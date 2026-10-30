import { defaultSleep, readSse } from './fetch/http.ts';
import { ModelServerError, scrubText } from '@ora/core';
import type { ModelCompactResult, ModelMessage, ModelRequest, ModelStreamEvent } from '@ora/core';
import type { CompactionReplay } from '@ora/protocol';
import { createFrameAssembler, toApiName } from './anthropic-frames.ts';
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_MESSAGES_PATH,
  EXTENDED_CACHE_TTL_BETA,
  RETRYABLE_STATUSES,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_ATTEMPTS,
  RETRY_MAX_DELAY_MS,
  cacheControlFor,
} from './anthropic-profile.ts';
import type { CacheControl } from './anthropic-profile.ts';
import {
  CLAUDE_CODE_IDENTITY,
  buildBillingText,
  buildMetadataUserId,
  buildOauthBetas,
  buildOauthHeaders,
  fromOauthToolName,
  newSessionId,
  replaceCch,
  toOauthToolName,
} from './fetch/claude-identity.ts';
import type { CatalogModel } from './fetch/catalog.ts';
import { failedResponse, UsageLimitError, WireAuthError } from './fetch/wire.ts';
import type { WireCredential, WireStream } from './fetch/wire.ts';

const ERROR_BODY_MAX_CHARS = 500;

type ApiBlock = Record<string, unknown>;
type AnthropicReplay = Extract<CompactionReplay, { kind: 'anthropic' }>;

/** 같은 프로바이더의 지원 모델이 받는 메시지만 서버가 만든 압축 블록을 보낸다. */
function replayOf(model: CatalogModel, message: ModelMessage): AnthropicReplay | undefined {
  const { replay } = message;
  return replay?.kind === 'anthropic' &&
    replay.provider === model.provider &&
    supportsAnthropicCompaction(model)
    ? replay
    : undefined;
}

function toApiBlocks(
  content: ModelMessage['content'],
  apiToolName: (name: string) => string,
): ApiBlock[] {
  return content.flatMap((block): ApiBlock[] => {
    switch (block.type) {
      case 'text':
        return [{ type: 'text', text: block.text }];
      case 'thinking':
        // 서명이 없거나 Anthropic 서명이 아닌(다른 프로바이더가 남긴 JSON) thinking 블록은 API가 거부한다.
        return block.signature === undefined || block.signature.startsWith('{')
          ? []
          : [{ type: 'thinking', thinking: block.text, signature: block.signature }];
      case 'tool_use':
        return [
          {
            type: 'tool_use',
            id: block.callId,
            name: apiToolName(block.tool),
            input: block.input,
          },
        ];
      case 'tool_result':
        return [
          {
            type: 'tool_result',
            tool_use_id: block.callId,
            content: block.text,
            is_error: block.isError,
          },
        ];
    }
  });
}

/** 마지막 메시지의 마지막 블록에 캐시 표시를 붙인다. thinking 블록은 표시를 받지 못하므로 건너뛴다. */
function toApiMessages(
  request: ModelRequest,
  cacheControl: CacheControl,
  apiToolName: (name: string) => string,
  replayFor: (message: ModelMessage) => AnthropicReplay | undefined,
) {
  const messages = request.messages.flatMap(
    (message): { role: 'user' | 'assistant'; content: ApiBlock[] }[] => {
      const replay = replayFor(message);
      if (replay === undefined) {
        return [{ role: message.role, content: toApiBlocks(message.content, apiToolName) }];
      }
      return [
        { role: 'assistant', content: [replay.block] },
        {
          role: 'user',
          content: [
            { type: 'text', text: replay.supplement },
            ...toApiBlocks(message.content.slice(1), apiToolName),
          ],
        },
      ];
    },
  );
  const last = messages.at(-1)?.content.at(-1);
  if (last !== undefined && last.type !== 'thinking') last.cache_control = cacheControl;
  return messages;
}

function firstUserText(request: ModelRequest): string {
  const block = request.messages
    .find((message) => message.role === 'user')
    ?.content.find((candidate) => candidate.type === 'text');
  return block?.type === 'text' ? block.text : '';
}

/** `Retry-After`(초 또는 날짜)와 `anthropic-ratelimit-*-reset`(RFC 3339)에서 대기 시간을 읽는다. */
function readRetryHint(headers: Headers, now: number): number | undefined {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  const resets = [...headers.entries()]
    .filter(([name]) => name.startsWith('anthropic-ratelimit-') && name.endsWith('-reset'))
    .map(([, value]) => Date.parse(value) - now)
    .filter((delay) => !Number.isNaN(delay));
  return resets.length === 0 ? undefined : Math.max(0, Math.min(...resets));
}

function buildBody(
  model: CatalogModel,
  credential: WireCredential,
  request: ModelRequest,
  maxTokens: number,
  effort: 'low' | 'medium' | 'high' | undefined,
  sessionId: string,
  compactInstructions?: string,
): string {
  const oauth = credential.kind === 'oauth';
  const cacheControl = cacheControlFor(model.cacheTtl);
  const apiToolName = (name: string) =>
    oauth ? toOauthToolName(toApiName(name)) : toApiName(name);
  const system = oauth
    ? [
        { type: 'text', text: buildBillingText(firstUserText(request)) },
        { type: 'text', text: CLAUDE_CODE_IDENTITY, cache_control: cacheControl },
        { type: 'text', text: request.system, cache_control: cacheControl },
      ]
    : [{ type: 'text', text: request.system, cache_control: cacheControl }];
  const body = JSON.stringify({
    model: model.id,
    max_tokens: maxTokens,
    ...(compactInstructions === undefined ? { stream: true } : {}),
    system,
    messages: toApiMessages(request, cacheControl, apiToolName, (message) =>
      replayOf(model, message),
    ),
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool, index) => ({
            name: apiToolName(tool.name),
            description: tool.description,
            input_schema: tool.inputSchema,
            ...(index === request.tools.length - 1 ? { cache_control: cacheControl } : {}),
          })),
        }),
    ...(effort === undefined ? {} : { output_config: { effort } }),
    ...(compactInstructions === undefined
      ? {}
      : { compaction: { type: 'summarize', instructions: compactInstructions } }),
    ...(oauth
      ? { metadata: { user_id: buildMetadataUserId(credential.accountId, sessionId) } }
      : {}),
  });
  // `cch`는 자리표시자를 넣은 본문 전체의 해시라서 직렬화한 뒤에 채운다.
  return oauth ? replaceCch(body) : body;
}

function buildHeaders(
  model: CatalogModel,
  credential: WireCredential,
  request: ModelRequest,
  hasEffort: boolean,
  sessionId: string,
  extraBeta?: string,
): Record<string, string> {
  if (credential.kind === 'oauth') {
    const headers = buildOauthHeaders({
      token: credential.token,
      sessionId,
      betas: buildOauthBetas({ hasTools: request.tools.length > 0, hasEffort }),
    });
    return extraBeta === undefined
      ? headers
      : { ...headers, 'anthropic-beta': `${headers['anthropic-beta']},${extraBeta}` };
  }
  const betas = [model.cacheTtl === '1h' ? EXTENDED_CACHE_TTL_BETA : undefined, extraBeta].filter(
    (beta) => beta !== undefined,
  );
  return {
    'x-api-key': credential.token,
    'anthropic-version': ANTHROPIC_API_VERSION,
    'content-type': 'application/json',
    ...(betas.length === 0 ? {} : { 'anthropic-beta': betas.join(',') }),
  };
}

/** `anthropic-messages` 전송 형식이다. API 키(`x-api-key`)와 구독 OAuth(Bearer, Claude Code 식별 정보)를 모두 다룬다. */
export const streamAnthropicMessages: WireStream = async function* ({
  model,
  credential,
  request,
  signal,
  options,
}): AsyncGenerator<ModelStreamEvent> {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const url = `${model.baseUrl}${ANTHROPIC_MESSAGES_PATH}`;
  const oauth = credential.kind === 'oauth';
  const sessionId = options.sessionId ?? newSessionId();
  const redact = (text: string): string =>
    scrubText(
      credential.token === '' ? text : text.split(credential.token).join('[REDACTED:token]'),
    ).text;

  const body = buildBody(
    model,
    credential,
    request,
    options.maxTokens ?? model.maxOutputTokens,
    options.effort,
    sessionId,
  );
  const headers = buildHeaders(
    model,
    credential,
    request,
    options.effort !== undefined,
    sessionId,
    request.messages.some((message) => replayOf(model, message) !== undefined)
      ? COMPACT_BETA
      : undefined,
  );

  const post = async (): Promise<Response> => {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await doFetch(url, { method: 'POST', signal, headers, body });
      } catch (error) {
        if (signal.aborted) throw error;
        if (attempt + 1 >= RETRY_MAX_ATTEMPTS) {
          throw new ModelServerError(
            redact(`Anthropic 요청이 네트워크 오류로 실패했습니다: ${String(error)}`),
            { cause: error },
          );
        }
        await sleep(Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS), signal);
        continue;
      }
      if (response.ok) return response;

      const text = await response.text().catch(() => '');
      const summary = `Anthropic 응답 ${response.status}: ${redact(text.slice(0, ERROR_BODY_MAX_CHARS))}`;
      const hint = readRetryHint(response.headers, now());
      const resetAt = hint === undefined ? undefined : now() + hint;
      if (
        response.status === 429 &&
        response.headers.get('anthropic-ratelimit-unified-status') === 'rejected'
      ) {
        throw new UsageLimitError(summary, resetAt);
      }
      if (response.status === 401) throw new WireAuthError(summary);
      const retryable =
        response.status >= 500 ||
        (RETRYABLE_STATUSES as readonly number[]).includes(response.status);
      if (!retryable || attempt + 1 >= RETRY_MAX_ATTEMPTS)
        throw failedResponse(response.status, summary);
      if (hint !== undefined && hint > RETRY_MAX_DELAY_MS) {
        const message = `${summary} (재시도 대기 ${Math.ceil(hint / 1000)}초가 상한을 넘어 중단합니다)`;
        throw response.status === 429
          ? new UsageLimitError(message, resetAt)
          : failedResponse(response.status, message);
      }
      await sleep(hint ?? Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS), signal);
    }
  };

  const response = await post();
  if (response.body === null) throw new Error('Anthropic 응답에 본문이 없습니다.');
  const byApiName = new Map(request.tools.map((tool) => [toApiName(tool.name), tool.name]));
  const assembler = createFrameAssembler((name) => {
    const apiName = oauth ? fromOauthToolName(name) : name;
    return byApiName.get(apiName) ?? apiName.replaceAll('__', '.');
  });
  for await (const data of readSse(response.body)) {
    yield* assembler.push(JSON.parse(data));
    const failure = assembler.getError();
    if (failure !== undefined) {
      throw new Error(redact(`Anthropic 스트림 오류 ${failure.type}: ${failure.message}`));
    }
  }
  if (!assembler.isDone()) throw new Error('Anthropic 스트림이 message_stop 없이 끝났습니다.');
  yield assembler.finish();
};

const COMPACT_BETA = 'compact-2026-09-04';
const COMPACT_INSTRUCTIONS_MAX_CHARS = 16_384;
const COMPACT_ATTEMPTS = 3;
const OFFICIAL_ORIGIN = 'https://api.anthropic.com';
/** 온디맨드 압축 문서가 지원 모델로 적은 목록이다. */
const COMPACT_MODELS: Record<string, true> = {
  'claude-fable-5-1': true,
  'claude-mythos-5-1': true,
  'claude-fable-5': true,
  'claude-mythos-5': true,
  'claude-mythos-preview': true,
  'claude-opus-5-5': true,
  'claude-opus-5': true,
  'claude-sonnet-5-5': true,
  'claude-sonnet-5': true,
  'claude-haiku-5-5': true,
  'claude-opus-4-8': true,
  'claude-opus-4-7': true,
  'claude-opus-4-6': true,
  'claude-sonnet-4-6': true,
};

interface CompactIteration {
  type?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** 판정 기준은 인증 방식이 아니라 모델과 엔드포인트다. */
function supportsAnthropicCompaction(model: CatalogModel): boolean {
  return (
    model.wire === 'anthropic-messages' &&
    model.id in COMPACT_MODELS &&
    new URL(model.baseUrl).origin === OFFICIAL_ORIGIN
  );
}

/**
 * Anthropic 온디맨드 압축(`compact-2026-09-04` 베타, 본문 `compaction: {type: "summarize", instructions}`)이다.
 * https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand
 * 응답의 서명된 compaction 블록은 `replay`로 돌려주고, 다음 요청의 첫 블록으로 그대로 보낸다.
 * 지원하지 않는 모델과 엔드포인트, 요약이 없는 응답(`stop_reason`이 `compaction`이 아님)은 `undefined`다.
 */
export async function compactAnthropicMessages({
  model,
  credential,
  request,
  signal,
  options,
}: {
  model: CatalogModel;
  credential: WireCredential;
  request: ModelRequest & { instructions: string };
  signal: AbortSignal;
  options: {
    maxTokens?: number;
    fetch?: typeof fetch;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    sessionId?: string;
  };
}): Promise<ModelCompactResult | undefined> {
  if (!supportsAnthropicCompaction(model)) return undefined;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const sessionId = options.sessionId ?? newSessionId();
  const redact = (text: string): string =>
    scrubText(
      credential.token === '' ? text : text.split(credential.token).join('[REDACTED:token]'),
    ).text;
  const body = buildBody(
    model,
    credential,
    request,
    options.maxTokens ?? model.maxOutputTokens,
    undefined,
    sessionId,
    request.instructions.slice(0, COMPACT_INSTRUCTIONS_MAX_CHARS),
  );
  const headers = buildHeaders(model, credential, request, false, sessionId, COMPACT_BETA);
  let response: Response | undefined;
  for (let attempt = 0; response === undefined; attempt += 1) {
    const last = attempt + 1 >= COMPACT_ATTEMPTS;
    let received: Response;
    try {
      received = await doFetch(`${model.baseUrl}${ANTHROPIC_MESSAGES_PATH}`, {
        method: 'POST',
        signal,
        headers,
        body,
      });
    } catch (error) {
      if (signal.aborted || last) throw error;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt, signal);
      continue;
    }
    if (received.ok) {
      response = received;
      break;
    }
    const text = await received.text().catch(() => '');
    const summary = `Anthropic 압축 응답 ${received.status}: ${redact(text.slice(0, ERROR_BODY_MAX_CHARS))}`;
    if (received.status === 401) throw new WireAuthError(summary);
    if (received.status === 429 && /usage|limit/i.test(text)) throw new UsageLimitError(summary);
    const retryable =
      received.status >= 500 || (RETRYABLE_STATUSES as readonly number[]).includes(received.status);
    if (!retryable || last) throw failedResponse(received.status, summary);
    await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt, signal);
  }
  const result = (await response.json()) as {
    stop_reason?: string;
    content?: { type?: string; content?: string; signature?: string }[];
    usage?: { iterations?: CompactIteration[] };
  };
  const block = result.content?.find((candidate) => candidate.type === 'compaction');
  if (result.stop_reason !== 'compaction' || typeof block?.content !== 'string') return undefined;
  const calls = (result.usage?.iterations ?? []).filter((item) => item.type === 'compaction');
  const sum = (pick: (item: CompactIteration) => number | undefined) =>
    calls.reduce((total, item) => total + (pick(item) ?? 0), 0);
  return {
    text: block.content,
    usage: {
      uncachedInputTokens: sum((item) => item.input_tokens),
      cacheReadInputTokens: sum((item) => item.cache_read_input_tokens),
      cacheCreationInputTokens: sum((item) => item.cache_creation_input_tokens),
      outputTokens: sum((item) => item.output_tokens),
    },
    ...(typeof block.signature === 'string' && block.signature !== ''
      ? {
          replay: {
            kind: 'anthropic' as const,
            provider: model.provider,
            block: {
              ...block,
              type: 'compaction' as const,
              content: block.content,
              signature: block.signature,
            },
          },
        }
      : {}),
  };
}
