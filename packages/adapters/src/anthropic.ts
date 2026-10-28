import { scrubText } from '@ora/core';
import type { ModelPort, ModelRequest, ModelStreamEvent, ModelUsage, StopReason } from '@ora/core';
import type { ContentBlock } from '@ora/protocol';
import { z } from 'zod';
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_MESSAGES_PATH,
  CACHE_CONTROL,
  RETRYABLE_STATUSES,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_ATTEMPTS,
  RETRY_MAX_DELAY_MS,
} from './anthropic-profile.ts';

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
  /** 재시도 대기를 바꿔 끼운다. 신호가 취소되면 예외를 던져야 한다. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

const ERROR_BODY_MAX_CHARS = 500;

const usageSchema = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().nullish(),
    cache_read_input_tokens: z.number().nullish(),
  })
  .partial();

const frameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message_start'), message: z.object({ usage: usageSchema }) }),
  z.object({
    type: z.literal('content_block_start'),
    index: z.number(),
    content_block: z.discriminatedUnion('type', [
      z.object({ type: z.literal('text') }),
      z.object({ type: z.literal('thinking') }),
      z.object({ type: z.literal('redacted_thinking') }),
      z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string() }),
    ]),
  }),
  z.object({
    type: z.literal('content_block_delta'),
    index: z.number(),
    delta: z.discriminatedUnion('type', [
      z.object({ type: z.literal('text_delta'), text: z.string() }),
      z.object({ type: z.literal('thinking_delta'), thinking: z.string() }),
      z.object({ type: z.literal('signature_delta'), signature: z.string() }),
      z.object({ type: z.literal('input_json_delta'), partial_json: z.string() }),
    ]),
  }),
  z.object({ type: z.literal('content_block_stop'), index: z.number() }),
  z.object({
    type: z.literal('message_delta'),
    delta: z.object({ stop_reason: z.string().nullish() }),
    usage: usageSchema.optional(),
  }),
  z.object({ type: z.literal('message_stop') }),
  z.object({ type: z.literal('ping') }),
  z.object({
    type: z.literal('error'),
    error: z.object({ type: z.string(), message: z.string() }),
  }),
]);
type Frame = z.infer<typeof frameSchema>;

/** Anthropic 도구 이름은 영문·숫자·`_`·`-`만 허용해서 `todo.update` 같은 이름의 `.`을 바꿔 보낸다. */
const toApiName = (name: string): string => name.replaceAll('.', '__');

/** 마지막 메시지의 마지막 블록에 캐시 표시를 붙인다. thinking 블록은 표시를 받지 못하므로 건너뛴다. */
function toApiMessages(request: ModelRequest) {
  const messages = request.messages.map((message) => ({
    role: message.role,
    content: message.content.flatMap((block): Record<string, unknown>[] => {
      switch (block.type) {
        case 'text':
          return [{ type: 'text', text: block.text }];
        case 'thinking':
          // 서명이 없는 thinking 블록은 API가 거부하므로 다시 보내지 않는다.
          return block.signature === undefined
            ? []
            : [{ type: 'thinking', thinking: block.text, signature: block.signature }];
        case 'tool_use':
          return [
            { type: 'tool_use', id: block.callId, name: toApiName(block.tool), input: block.input },
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
  if (last !== undefined && last.type !== 'thinking') last.cache_control = CACHE_CONTROL;
  return messages;
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

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  if (signal.aborted) {
    reject(signal.reason);
    return promise.then(() => undefined);
  }
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', onAbort);
    resolve(undefined);
  }, ms);
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal.reason);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return promise.then(() => undefined);
}

/** SSE 본문을 프레임 단위로 읽는다. 청크 경계에서 잘린 줄은 이어 붙인다. */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replaceAll('\r\n', '\n');
    let end = buffer.indexOf('\n\n');
    while (end !== -1) {
      const data = buffer
        .slice(0, end)
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      buffer = buffer.slice(end + 2);
      if (data !== '') yield data;
      end = buffer.indexOf('\n\n');
    }
  }
}

interface PartialBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'redacted_thinking';
  text: string;
  signature?: string;
  callId?: string;
  tool?: string;
  json: string;
}

/**
 * Anthropic Messages API 어댑터다. 사용자 본인의 API 키(`x-api-key`)로 호출하고 사용량 과금을 따른다.
 * 키는 `getApiKey`로만 받고, 오류 메시지에는 키 값을 가려서 넣는다.
 */
export function createAnthropicModel(options: AnthropicOptions): ModelPort {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const url = `${options.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL}${ANTHROPIC_MESSAGES_PATH}`;

  const redact = (text: string, token: string): string =>
    scrubText(token === '' ? text : text.split(token).join('[REDACTED:token]')).text;

  const post = async (request: ModelRequest, signal: AbortSignal): Promise<Response> => {
    const apiKey = options.getApiKey();
    const body = JSON.stringify({
      model: options.model,
      max_tokens: options.maxTokens,
      stream: true,
      system: [{ type: 'text', text: request.system, cache_control: CACHE_CONTROL }],
      messages: toApiMessages(request),
      ...(request.tools.length === 0
        ? {}
        : {
            tools: request.tools.map((tool, index) => ({
              name: toApiName(tool.name),
              description: tool.description,
              input_schema: tool.inputSchema,
              ...(index === request.tools.length - 1 ? { cache_control: CACHE_CONTROL } : {}),
            })),
          }),
      ...(options.effort === undefined ? {} : { output_config: { effort: options.effort } }),
    });
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await doFetch(url, {
          method: 'POST',
          signal,
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_API_VERSION,
            'content-type': 'application/json',
          },
          body,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        if (attempt + 1 >= RETRY_MAX_ATTEMPTS) {
          throw new Error(
            redact(`Anthropic 요청이 네트워크 오류로 실패했습니다: ${String(error)}`, apiKey),
            { cause: error },
          );
        }
        await sleep(Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS), signal);
        continue;
      }
      if (response.ok) return response;

      const text = await response.text().catch(() => '');
      const summary = `Anthropic 응답 ${response.status}: ${redact(text.slice(0, ERROR_BODY_MAX_CHARS), apiKey)}`;
      const retryable =
        response.status >= 500 ||
        (RETRYABLE_STATUSES as readonly number[]).includes(response.status);
      if (!retryable || attempt + 1 >= RETRY_MAX_ATTEMPTS) throw new Error(summary);
      const hint = readRetryHint(response.headers, now());
      if (hint !== undefined && hint > RETRY_MAX_DELAY_MS) {
        throw new Error(
          `${summary} (재시도 대기 ${Math.ceil(hint / 1000)}초가 상한을 넘어 중단합니다)`,
        );
      }
      await sleep(hint ?? Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS), signal);
    }
  };

  return {
    model: options.model,
    adapter: 'anthropic',
    async *stream(request, signal): AsyncGenerator<ModelStreamEvent> {
      const response = await post(request, signal);
      if (response.body === null) throw new Error('Anthropic 응답에 본문이 없습니다.');
      const byApiName = new Map(request.tools.map((tool) => [toApiName(tool.name), tool.name]));
      const blocks = new Map<number, PartialBlock>();
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      let stopReason: string | null | undefined;
      let done = false;

      const addUsage = (value: z.infer<typeof usageSchema> | undefined) => {
        if (value === undefined) return;
        usage.input = value.input_tokens ?? usage.input;
        usage.output = value.output_tokens ?? usage.output;
        usage.cacheRead = value.cache_read_input_tokens ?? usage.cacheRead;
        usage.cacheWrite = value.cache_creation_input_tokens ?? usage.cacheWrite;
      };

      for await (const data of readSse(response.body)) {
        const parsed = frameSchema.safeParse(JSON.parse(data));
        if (!parsed.success) continue;
        const frame: Frame = parsed.data;
        switch (frame.type) {
          case 'message_start':
            addUsage(frame.message.usage);
            break;
          case 'content_block_start': {
            const block = frame.content_block;
            blocks.set(frame.index, {
              type: block.type,
              text: '',
              json: '',
              ...(block.type === 'tool_use' ? { callId: block.id, tool: block.name } : {}),
            });
            break;
          }
          case 'content_block_delta': {
            const block = blocks.get(frame.index);
            if (block === undefined) break;
            const { delta } = frame;
            if (delta.type === 'text_delta') {
              block.text += delta.text;
              yield { type: 'text_delta', text: delta.text };
            } else if (delta.type === 'thinking_delta') {
              block.text += delta.thinking;
              yield { type: 'thinking_delta', text: delta.thinking };
            } else if (delta.type === 'signature_delta') {
              block.signature = (block.signature ?? '') + delta.signature;
            } else {
              block.json += delta.partial_json;
            }
            break;
          }
          case 'message_delta':
            stopReason = frame.delta.stop_reason ?? stopReason;
            addUsage(frame.usage);
            break;
          case 'message_stop':
            done = true;
            break;
          case 'error':
            throw new Error(
              redact(
                `Anthropic 스트림 오류 ${frame.error.type}: ${frame.error.message}`,
                options.getApiKey(),
              ),
            );
          default:
            break;
        }
      }
      if (!done) throw new Error('Anthropic 스트림이 message_stop 없이 끝났습니다.');

      const content: ContentBlock[] = [...blocks.entries()]
        .sort(([a], [b]) => a - b)
        .flatMap(([, block]): ContentBlock[] => {
          if (block.type === 'text') return [{ type: 'text', text: block.text }];
          if (block.type === 'thinking') {
            return [
              {
                type: 'thinking',
                text: block.text,
                ...(block.signature === undefined ? {} : { signature: block.signature }),
              },
            ];
          }
          if (block.type === 'redacted_thinking') return [];
          const input: unknown = block.json === '' ? {} : JSON.parse(block.json);
          return [
            {
              type: 'tool_use',
              callId: block.callId ?? '',
              tool: byApiName.get(block.tool ?? '') ?? (block.tool ?? '').replaceAll('__', '.'),
              input: z.record(z.string(), z.unknown()).parse(input),
            },
          ];
        });
      const modelUsage: ModelUsage = {
        inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
        outputTokens: usage.output,
        cachedInputTokens: usage.cacheRead,
      };
      const reasons: Record<string, StopReason> = {
        end_turn: 'end_turn',
        tool_use: 'tool_use',
        max_tokens: 'max_tokens',
      };
      yield {
        type: 'completed',
        content,
        stopReason: reasons[stopReason ?? ''] ?? 'end_turn',
        usage: modelUsage,
        nativeToolCalls: true,
      };
    },
  };
}
