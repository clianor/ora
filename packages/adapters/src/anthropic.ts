import { defaultSleep, readSse } from './fetch/http.ts';
import { scrubText } from '@ora/core';
import type { ModelPort, ModelRequest, ModelStreamEvent } from '@ora/core';
import { createFrameAssembler, toApiName } from './anthropic-frames.ts';
import {
  ANTHROPIC_DEFAULT_BASE_URL,
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
import { UsageLimitError, WireAuthError } from './fetch/wire.ts';
import type { WireCredential, WireStream } from './fetch/wire.ts';

export interface AnthropicOptions {
  readonly model: string;
  /** 요청마다 부른다. 키는 호출 시점에만 읽고 어디에도 저장하지 않는다. */
  readonly getApiKey: () => string;
  readonly maxTokens: number;
  /** `output_config.effort`로 보낸다. 없으면 보내지 않는다. */
  readonly effort?: 'low' | 'medium' | 'high';
  readonly baseUrl?: string;
  /** 테스트가 로컬 서버나 가짜 응답으로 바꿔 끼울 수 있다. */
  readonly fetch?: typeof fetch;
  /** 재시도 대기를 바꿔 끼운다. 호출자가 신호를 취소하면 예외를 던져야 한다. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

const ERROR_BODY_MAX_CHARS = 500;

/** 마지막 메시지의 마지막 블록에 캐시 표시를 붙인다. thinking 블록은 표시를 받지 못하므로 건너뛴다. */
function toApiMessages(
  request: ModelRequest,
  cacheControl: CacheControl,
  apiToolName: (name: string) => string,
) {
  const messages = request.messages.map((message) => ({
    role: message.role,
    content: message.content.flatMap((block): Record<string, unknown>[] => {
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
    }),
  }));
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
    stream: true,
    system,
    messages: toApiMessages(request, cacheControl, apiToolName),
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
): Record<string, string> {
  if (credential.kind === 'oauth') {
    return buildOauthHeaders({
      token: credential.token,
      sessionId,
      betas: buildOauthBetas({ hasTools: request.tools.length > 0, hasEffort }),
    });
  }
  return {
    'x-api-key': credential.token,
    'anthropic-version': ANTHROPIC_API_VERSION,
    'content-type': 'application/json',
    ...(model.cacheTtl === '1h' ? { 'anthropic-beta': EXTENDED_CACHE_TTL_BETA } : {}),
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
  const headers = buildHeaders(model, credential, request, options.effort !== undefined, sessionId);

  const post = async (): Promise<Response> => {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await doFetch(url, { method: 'POST', signal, headers, body });
      } catch (error) {
        if (signal.aborted) throw error;
        if (attempt + 1 >= RETRY_MAX_ATTEMPTS) {
          throw new Error(
            redact(`Anthropic 요청이 네트워크 오류로 실패했습니다: ${String(error)}`),
            {
              cause: error,
            },
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
      if (!retryable || attempt + 1 >= RETRY_MAX_ATTEMPTS) throw new Error(summary);
      if (hint !== undefined && hint > RETRY_MAX_DELAY_MS) {
        const message = `${summary} (재시도 대기 ${Math.ceil(hint / 1000)}초가 상한을 넘어 중단합니다)`;
        throw response.status === 429 ? new UsageLimitError(message, resetAt) : new Error(message);
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

/** 사용자 본인의 API 키(`x-api-key`)로 호출하는 어댑터다. 사용량 과금을 따른다. 키는 `getApiKey`로만 받는다. */
export function createAnthropicModel(options: AnthropicOptions): ModelPort {
  const model: CatalogModel = {
    id: options.model,
    provider: 'anthropic',
    wire: 'anthropic-messages',
    baseUrl: options.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL,
    contextWindow: 200_000,
    maxOutputTokens: options.maxTokens,
    cacheTtl: '1h',
  };
  return {
    model: options.model,
    adapter: 'anthropic',
    stream: (request, signal) =>
      streamAnthropicMessages({
        model,
        credential: { kind: 'apiKey', token: options.getApiKey() },
        request,
        signal,
        options: {
          ...(options.effort === undefined ? {} : { effort: options.effort }),
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
          ...(options.now === undefined ? {} : { now: options.now }),
        },
      }),
  };
}
