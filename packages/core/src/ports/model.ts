import type { ContentBlock, EventOf, SessionRecord } from '@ora/protocol';

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
  /** 모델 컨텍스트 창(토큰)이다. 모르면 비우고, 호스트가 카탈로그 값을 채운다. */
  readonly contextWindow?: number;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
  /** 마지막 요청을 보낸 계정이다. 엔진이 `session.json`에 적어 재개한 세션이 같은 계정을 이어 쓰게 한다. */
  accountPin?(): SessionRecord['accountPin'];
}
