/**
 * OpenAI Responses API 전송 형식 둘이다. `openai-responses`는 api.openai.com과 api.x.ai가 쓰고,
 * `openai-codex-responses`는 ChatGPT 구독의 `chatgpt.com/backend-api/codex/responses`가 쓴다.
 * 요청 모양은 pi-mono와 omp의 공개 소스에서 확인한 값이다.
 */
import { scrubText } from '@ora/core';
import type { ModelRequest, ModelUsage, StopReason } from '@ora/core';
import type { ContentBlock } from '@ora/protocol';
import { z } from 'zod';
import { toApiName } from '../anthropic-frames.ts';
import {
  RETRYABLE_STATUSES,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_ATTEMPTS,
  RETRY_MAX_DELAY_MS,
} from '../anthropic-profile.ts';
import { defaultSleep, readSse } from './http.ts';
import { UsageLimitError, WireAuthError } from './wire.ts';
import type { WireStream } from './wire.ts';

const ERROR_BODY_MAX_CHARS = 500;
const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';
const CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api';
const ORIGINATOR = 'ora';
const USAGE_LIMIT_CODES = new Set([
  'usage_limit_reached',
  'usage_not_included',
  'insufficient_quota',
]);
/** 일시적인 속도 제한(`rate_limit_exceeded`, "Rate limit reached ... try again in 6s")은 포함하지 않는다. */
const USAGE_LIMIT_TEXT =
  /usage limit|usage_limit_reached|out of (?:extra )?usage|exceeded your .{0,40}quota|insufficient[_ ]quota|credit balance/i;
/** 이 모델은 `reasoning.effort`를 받지 않는다 (omp의 `omitReasoningEffort`). */
const OMIT_EFFORT_MODEL = /reasoning$|^grok-build/;

/** 생각 블록의 `signature`에 담는 값이다. 암호화된 reasoning 항목을 다음 요청에 되돌려 보낼 때 쓴다. */
const reasoningSignatureSchema = z.object({
  responsesReasoning: z.literal(1),
  source: z.string(),
  encryptedContent: z.string().min(1),
  summary: z.array(z.unknown()),
});

const usageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  input_tokens_details: z.object({ cached_tokens: z.number().nullish() }).nullish(),
});

const outputItemSchema = z.looseObject({ type: z.string() });

type ApiItem = Record<string, unknown>;

function toInput(
  request: ModelRequest,
  apiToolName: (name: string) => string,
  source: string,
): ApiItem[] {
  const input: ApiItem[] = [];
  for (const message of request.messages) {
    const parts: string[] = [];
    const flush = () => {
      if (parts.length === 0) return;
      const text = parts.splice(0).join('');
      input.push(
        message.role === 'user'
          ? { role: 'user', content: [{ type: 'input_text', text }] }
          : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
      );
    };
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          parts.push(block.text);
          break;
        case 'thinking': {
          // 암호화된 reasoning이 없는 블록은 API가 이어 받을 수 없으므로 다시 보내지 않는다.
          const parsed = parseSignature(block.signature, source);
          if (parsed === undefined) break;
          flush();
          input.push({
            type: 'reasoning',
            summary: parsed.summary,
            encrypted_content: parsed.encryptedContent,
          });
          break;
        }
        case 'tool_use':
          flush();
          input.push({
            type: 'function_call',
            call_id: block.callId,
            name: apiToolName(block.tool),
            arguments: JSON.stringify(block.input),
          });
          break;
        case 'tool_result':
          flush();
          input.push({ type: 'function_call_output', call_id: block.callId, output: block.text });
          break;
      }
    }
    flush();
  }
  return input;
}

/** 같은 서버(`source`)가 만든 서명일 때만 돌려준다. 다른 프로바이더의 암호화 reasoning은 400을 만든다. */
function parseSignature(signature: string | undefined, source: string) {
  if (signature === undefined) return undefined;
  try {
    const parsed = reasoningSignatureSchema.safeParse(JSON.parse(signature));
    return parsed.success && parsed.data.source === source ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const callItemSchema = z.looseObject({
  call_id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string().optional(),
});
const messageItemSchema = z.looseObject({
  content: z
    .array(
      z.looseObject({
        type: z.string(),
        text: z.string().optional(),
        refusal: z.string().optional(),
      }),
    )
    .optional(),
});
const reasoningItemSchema = z.looseObject({
  summary: z.array(z.looseObject({ text: z.string().optional() })).optional(),
  encrypted_content: z.string().nullish(),
});

function resolveResetAt(
  resetsAt: number | null | undefined,
  resetsIn: number | null | undefined,
  now: number,
): number | undefined {
  if (resetsAt != null) return resetsAt * 1000;
  if (resetsIn != null) return now + resetsIn * 1000;
  return undefined;
}

/** 응답의 출력 항목 하나를 Ora 내용 블록으로 바꾼다. `source`는 암호화 reasoning을 만든 서버 주소다. */
function itemToBlocks(
  item: ApiItem,
  resolveTool: (apiName: string) => string,
  source: string,
): ContentBlock[] {
  if (item.type === 'message') {
    const text = (messageItemSchema.parse(item).content ?? [])
      .map((part) => (part.type === 'refusal' ? (part.refusal ?? '') : (part.text ?? '')))
      .join('');
    return text === '' ? [] : [{ type: 'text', text }];
  }
  if (item.type === 'reasoning') {
    const { summary = [], encrypted_content: encrypted } = reasoningItemSchema.parse(item);
    const text = summary
      .map((part) => part.text ?? '')
      .filter((part) => part !== '')
      .join('\n\n');
    const signature =
      encrypted == null || encrypted === ''
        ? undefined
        : JSON.stringify({
            responsesReasoning: 1,
            source,
            encryptedContent: encrypted,
            summary,
          });
    return [{ type: 'thinking', text, ...(signature === undefined ? {} : { signature }) }];
  }
  if (item.type === 'function_call') {
    const call = callItemSchema.parse(item);
    const raw = call.arguments === undefined || call.arguments === '' ? '{}' : call.arguments;
    let input: Record<string, unknown>;
    try {
      input = z.record(z.string(), z.unknown()).parse(JSON.parse(raw));
    } catch {
      throw new Error(
        `도구 ${call.name}의 인자가 올바른 JSON 객체가 아닙니다(출력이 잘렸을 수 있습니다).`,
      );
    }
    return [{ type: 'tool_use', callId: call.call_id, tool: resolveTool(call.name), input }];
  }
  return [];
}

interface LimitInfo {
  readonly code: string | undefined;
  readonly message: string;
  readonly resetAtMs: number | undefined;
}

/** `{error:{code,type,message,resets_at,resets_in_seconds}}`와 `{detail}` 두 모양에서 오류 정보를 읽는다. */
function readErrorInfo(text: string, now: number): LimitInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { code: undefined, message: text, resetAtMs: undefined };
  }
  const root = z.looseObject({ error: z.unknown().optional(), detail: z.unknown().optional() });
  const outer = root.safeParse(parsed);
  const errorValue = outer.success ? (outer.data.error ?? outer.data.detail) : undefined;
  const inner = z
    .looseObject({
      code: z.string().nullish(),
      type: z.string().nullish(),
      message: z.string().nullish(),
      resets_at: z.number().nullish(),
      resets_in_seconds: z.number().nullish(),
    })
    .safeParse(errorValue);
  if (!inner.success) {
    return {
      code: undefined,
      message: typeof errorValue === 'string' ? errorValue : text,
      resetAtMs: undefined,
    };
  }
  const { code, type, message, resets_at: resetsAt, resets_in_seconds: resetsIn } = inner.data;
  return {
    code: code ?? type ?? undefined,
    message: message ?? text,
    resetAtMs: resolveResetAt(resetsAt, resetsIn, now),
  };
}

function retryAfterMs(headers: Headers, now: number): number | undefined {
  const value = headers.get('retry-after');
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

const stopFor = (hasToolCall: boolean): StopReason => (hasToolCall ? 'tool_use' : 'end_turn');

function streamResponses(flavor: 'generic' | 'codex'): WireStream {
  return async function* ({ model, credential, request, signal, options }) {
    const doFetch = options.fetch ?? fetch;
    const sleep = options.sleep ?? defaultSleep;
    const now = options.now ?? (() => Date.now());
    const sessionId = options.sessionId ?? crypto.randomUUID();
    const source = new URL(model.baseUrl).origin;
    const label = flavor === 'codex' ? 'Codex' : 'Responses';
    const redact = (text: string): string =>
      scrubText(
        credential.token === '' ? text : text.split(credential.token).join('[REDACTED:token]'),
      ).text;

    const url =
      flavor === 'codex' ? `${model.baseUrl}/codex/responses` : `${model.baseUrl}/responses`;
    const reasoningEffort =
      options.effort !== undefined && !(flavor === 'generic' && OMIT_EFFORT_MODEL.test(model.id))
        ? options.effort
        : undefined;
    const body = JSON.stringify({
      model: model.id,
      instructions: request.system === '' ? 'You are a helpful assistant.' : request.system,
      input: toInput(request, toApiName, source),
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: sessionId,
      tool_choice: 'auto',
      parallel_tool_calls: true,
      ...(request.tools.length === 0
        ? {}
        : {
            tools: request.tools.map((tool) => ({
              type: 'function',
              name: toApiName(tool.name),
              description: tool.description,
              parameters: tool.inputSchema,
              strict: false,
            })),
          }),
      ...(flavor === 'codex'
        ? {
            text: { verbosity: 'low' },
            reasoning: {
              summary: 'auto',
              ...(reasoningEffort === undefined ? {} : { effort: reasoningEffort }),
            },
          }
        : {
            max_output_tokens: options.maxTokens ?? model.maxOutputTokens,
            ...(reasoningEffort === undefined ? {} : { reasoning: { effort: reasoningEffort } }),
          }),
    });

    const headers: Record<string, string> = {
      authorization: `Bearer ${credential.token}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
    if (flavor === 'codex') {
      if (credential.accountId === undefined || credential.accountId === '') {
        throw new Error('Codex 계정 id가 없습니다. ora login codex로 다시 로그인합니다.');
      }
      headers['chatgpt-account-id'] = credential.accountId;
      headers['openai-beta'] = 'responses=experimental';
      headers.originator = ORIGINATOR;
      headers['session-id'] = sessionId;
      headers['x-client-request-id'] = sessionId;
    }

    const post = async (): Promise<Response> => {
      for (let attempt = 0; ; attempt += 1) {
        let response: Response;
        try {
          response = await doFetch(url, { method: 'POST', signal, headers, body });
        } catch (error) {
          if (signal.aborted) throw error;
          if (attempt + 1 >= RETRY_MAX_ATTEMPTS) {
            throw new Error(
              redact(`${label} 요청이 네트워크 오류로 실패했습니다: ${String(error)}`),
              { cause: error },
            );
          }
          await sleep(Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS), signal);
          continue;
        }
        if (response.ok) return response;

        const text = await response.text().catch(() => '');
        const info = readErrorInfo(text, now());
        const summary = `${label} 응답 ${response.status}: ${redact(info.message.slice(0, ERROR_BODY_MAX_CHARS))}`;
        if (response.status === 401) throw new WireAuthError(summary);
        const hint = retryAfterMs(response.headers, now());
        const resetAt = info.resetAtMs ?? (hint === undefined ? undefined : now() + hint);
        if (
          (info.code !== undefined && USAGE_LIMIT_CODES.has(info.code)) ||
          (response.status === 429 && USAGE_LIMIT_TEXT.test(text))
        ) {
          throw new UsageLimitError(summary, resetAt);
        }
        const retryable =
          response.status >= 500 ||
          (RETRYABLE_STATUSES as readonly number[]).includes(response.status);
        if (!retryable || attempt + 1 >= RETRY_MAX_ATTEMPTS) throw new Error(summary);
        if (hint !== undefined && hint > RETRY_MAX_DELAY_MS) {
          const message = `${summary} (재시도 대기 ${Math.ceil(hint / 1000)}초가 상한을 넘어 중단합니다)`;
          throw response.status === 429
            ? new UsageLimitError(message, resetAt)
            : new Error(message);
        }
        await sleep(
          hint ?? Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS),
          signal,
        );
      }
    };

    const response = await post();
    if (response.body === null) throw new Error(`${label} 응답에 본문이 없습니다.`);
    const byApiName = new Map(request.tools.map((tool) => [toApiName(tool.name), tool.name]));
    const resolveTool = (apiName: string) =>
      byApiName.get(apiName) ?? apiName.replaceAll('__', '.');
    const doneItems = new Map<number, ApiItem>();

    for await (const data of readSse(response.body)) {
      if (data === '[DONE]') continue;
      let parsedData: unknown;
      try {
        parsedData = JSON.parse(data);
      } catch {
        throw new Error(`${label} 스트림 프레임이 JSON이 아닙니다.`);
      }
      const frame = z.looseObject({ type: z.string() }).safeParse(parsedData);
      if (!frame.success) continue;
      const event = frame.data;
      switch (event.type) {
        case 'response.output_text.delta':
          if (typeof event.delta === 'string' && event.delta !== '') {
            yield { type: 'text_delta', text: event.delta };
          }
          break;
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta':
          if (typeof event.delta === 'string' && event.delta !== '') {
            yield { type: 'thinking_delta', text: event.delta };
          }
          break;
        case 'response.output_item.done': {
          const item = outputItemSchema.safeParse(event.item);
          if (item.success) {
            const index =
              typeof event.output_index === 'number' ? event.output_index : doneItems.size;
            doneItems.set(index, item.data);
          }
          break;
        }
        case 'response.completed':
        case 'response.done':
        case 'response.incomplete': {
          const completed = z
            .looseObject({
              output: z.array(outputItemSchema).optional(),
              usage: usageSchema.nullish(),
              incomplete_details: z.object({ reason: z.string().nullish() }).nullish(),
            })
            .parse(event.response ?? {});
          const items =
            doneItems.size > 0
              ? [...doneItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item)
              : (completed.output ?? []);
          const content = items.flatMap((item) => itemToBlocks(item, resolveTool, source));
          const hasToolCall = content.some((block) => block.type === 'tool_use');
          let stopReason: StopReason = stopFor(hasToolCall);
          if (event.type === 'response.incomplete') {
            const reason = completed.incomplete_details?.reason ?? 'max_output_tokens';
            if (reason === 'content_filter') {
              throw new Error(`${label} 응답이 콘텐츠 필터로 중단됐습니다.`);
            }
            stopReason = 'max_tokens';
          }
          const cached = completed.usage?.input_tokens_details?.cached_tokens ?? 0;
          const usage: ModelUsage = {
            uncachedInputTokens: Math.max(0, (completed.usage?.input_tokens ?? 0) - cached),
            cacheReadInputTokens: cached,
            cacheCreationInputTokens: 0,
            outputTokens: completed.usage?.output_tokens ?? 0,
          };
          yield { type: 'completed', content, stopReason, usage, nativeToolCalls: true };
          return;
        }
        case 'response.failed':
        case 'error': {
          const failed = z.looseObject({ error: z.unknown().optional() }).safeParse(event.response);
          const raw = event.type === 'error' ? event : failed.data?.error;
          const info = readErrorInfo(JSON.stringify({ error: raw }), now());
          const message = redact(
            `${label} 스트림 오류 ${info.code ?? event.type}: ${info.message}`,
          );
          if (info.code !== undefined && USAGE_LIMIT_CODES.has(info.code)) {
            throw new UsageLimitError(message, info.resetAtMs);
          }
          throw new Error(message);
        }
        default:
          break;
      }
    }
    throw new Error(`${label} 스트림이 완료 이벤트 없이 끝났습니다.`);
  };
}

const streamGeneric = streamResponses('generic');
const streamCodex = streamResponses('codex');

export const streamOpenAIResponses: WireStream = streamGeneric;

/** API 키 계정은 ChatGPT 백엔드가 아니라 공개 OpenAI Responses API로 보낸다. 설정이 준 다른 주소는 그대로 쓴다. */
export const streamOpenAICodexResponses: WireStream = (input) => {
  if (input.credential.kind !== 'apiKey') return streamCodex(input);
  const model =
    input.model.baseUrl === CHATGPT_BASE_URL
      ? { ...input.model, baseUrl: OPENAI_API_BASE_URL }
      : input.model;
  return streamGeneric({ ...input, model });
};
