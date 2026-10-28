import type { ModelStreamEvent, ModelUsage, StopReason } from '@ora/core';
import type { ContentBlock } from '@ora/protocol';
import { z } from 'zod';

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

/** Anthropic 도구 이름은 영문·숫자·`_`·`-`만 허용해서 `todo.update` 같은 이름의 `.`을 바꿔 보낸다. */
export const toApiName = (name: string): string => name.replaceAll('.', '__');

interface PartialBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'redacted_thinking';
  text: string;
  signature?: string;
  callId?: string;
  tool?: string;
  json: string;
}

const STOP_REASONS: Record<string, StopReason> = {
  end_turn: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
};

export interface FrameAssembler {
  /** 프레임 하나를 반영하고 새로 생긴 delta 이벤트를 돌려준다. 모르는 프레임은 건너뛴다. */
  readonly push: (frame: unknown) => ModelStreamEvent[];
  readonly isDone: () => boolean;
  readonly getError: () => { type: string; message: string } | undefined;
  readonly finish: () => Extract<ModelStreamEvent, { type: 'completed' }>;
}

/**
 * Messages API 스트림 프레임(SSE `data`나 Claude Code의 `stream_event.event`)을 모아
 * `completed` 이벤트 하나로 만든다. `resolveTool`은 API 도구 이름을 Ora 도구 이름으로 되돌린다.
 */
export function createFrameAssembler(resolveTool: (apiName: string) => string): FrameAssembler {
  const blocks = new Map<number, PartialBlock>();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let stopReason: string | null | undefined;
  let done = false;
  let error: { type: string; message: string } | undefined;

  const addUsage = (value: z.infer<typeof usageSchema> | undefined) => {
    if (value === undefined) return;
    usage.input = value.input_tokens ?? usage.input;
    usage.output = value.output_tokens ?? usage.output;
    usage.cacheRead = value.cache_read_input_tokens ?? usage.cacheRead;
    usage.cacheWrite = value.cache_creation_input_tokens ?? usage.cacheWrite;
  };

  return {
    push(raw) {
      const parsed = frameSchema.safeParse(raw);
      if (!parsed.success) return [];
      const frame = parsed.data;
      const events: ModelStreamEvent[] = [];
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
            events.push({ type: 'text_delta', text: delta.text });
          } else if (delta.type === 'thinking_delta') {
            block.text += delta.thinking;
            events.push({ type: 'thinking_delta', text: delta.thinking });
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
          error = frame.error;
          break;
        default:
          break;
      }
      return events;
    },
    isDone: () => done,
    getError: () => error,
    finish() {
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
              tool: resolveTool(block.tool ?? ''),
              input: z.record(z.string(), z.unknown()).parse(input),
            },
          ];
        });
      const modelUsage: ModelUsage = {
        uncachedInputTokens: usage.input,
        cacheReadInputTokens: usage.cacheRead,
        cacheCreationInputTokens: usage.cacheWrite,
        outputTokens: usage.output,
      };
      return {
        type: 'completed',
        content,
        stopReason: STOP_REASONS[stopReason ?? ''] ?? 'end_turn',
        usage: modelUsage,
        nativeToolCalls: true,
      };
    },
  };
}
