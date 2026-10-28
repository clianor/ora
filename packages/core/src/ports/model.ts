import type { ContentBlock, EventOf } from '@ora/protocol';

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface ModelMessage {
  readonly role: 'user' | 'assistant';
  readonly content: readonly ContentBlock[];
}

export interface ModelRequest {
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolSpec[];
}

export type ModelUsage = EventOf<'model_request'>['payload']['usage'];

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens';

export type ModelStreamEvent =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'thinking_delta'; readonly text: string }
  | {
      readonly type: 'completed';
      readonly content: readonly ContentBlock[];
      readonly stopReason: StopReason;
      readonly usage: ModelUsage;
      readonly nativeToolCalls: boolean;
      readonly providerMetadata?: Record<string, unknown>;
    };

/** 스트림은 delta를 0회 이상 낸 뒤 `completed`를 정확히 한 번 내고 끝난다. */
export interface ModelPort {
  readonly model: string;
  readonly adapter: string;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
}
