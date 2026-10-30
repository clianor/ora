import type { CompactionReplay, ContentBlock, EventOf, SessionRecord } from '@ora/protocol';

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface ModelMessage {
  readonly role: 'user' | 'assistant';
  readonly content: readonly ContentBlock[];
  /**
   * 요약 문서 메시지에만 붙는다. 첫 내용 블록이 요약 문서이고, 같은 프로바이더의 어댑터는 그 블록 대신 서버가 만든 압축 결과를 보낸다.
   * 다른 프로바이더의 어댑터는 이 필드를 무시하고 요약 문서를 그대로 보낸다.
   */
  readonly replay?: CompactionReplay;
}

export interface ModelRequest {
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolSpec[];
  /** 이 요청에서 모델이 쓸 수 있는 출력 토큰 상한이다. 비우면 전송 형식의 기본 상한을 쓴다. */
  readonly maxOutputTokens?: number;
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
    };

/** 스트림은 delta를 0회 이상 낸 뒤 `completed`를 정확히 한 번 내고 끝난다. */
export interface ModelPort {
  readonly model: string;
  readonly adapter: string;
  /** 모델을 제공하는 프로바이더 ID다. 서버가 만든 압축 결과를 같은 프로바이더의 모델만 읽을 수 있는지 판정하는 데 쓴다. */
  readonly provider?: string;
  /** 모델 컨텍스트 창(토큰)이다. 모르면 비우고, 호스트가 카탈로그 값을 채운다. */
  readonly contextWindow?: number;
  /** 모델의 최대 출력 토큰이다(카탈로그 값). 모르면 비운다. */
  readonly maxOutputTokens?: number;
  /** 전송 형식이 요청의 `maxOutputTokens`를 출력 상한으로 실을 수 있는지다. `true`가 아니면 상한은 프롬프트와 사후 검사로 지킨다. */
  readonly acceptsOutputCap?: boolean;
  /**
   * 프로바이더 서버가 요약을 쓰는 압축 요청이다. `undefined`를 돌려주면 이 모델과 자격으로는 쓸 수 없다는 뜻이며 엔진이 `remote` 방식을 건너뛴다.
   * 서버가 요약을 쓰지 못했을 때도 `undefined`다. 요청 자체가 실패하면 예외를 던진다. `instructions`는 서버가 쓰는 요약 지시다.
   */
  compact?(
    request: ModelRequest & { readonly instructions: string },
    signal: AbortSignal,
  ): Promise<ModelCompactResult | undefined>;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
  /** 프롬프트 캐시가 유지되는 시간이다. 모르면 비운다. 엔진이 입력을 기다리는 동안 요약을 만들 시점을 정하는 데 쓴다. */
  readonly cacheTtl?: '5m' | '1h';
  /** 마지막 요청을 보낸 계정이다. 엔진이 `session.json`에 적어 재개한 세션이 같은 계정을 이어 쓰게 한다. */
  accountPin?(): SessionRecord['accountPin'];
}

type DistributiveOmit<T, K extends string> = T extends unknown ? Omit<T, K> : never;

export interface ModelCompactResult {
  /** 사람이 읽을 수 있는 요약이다. 서버가 요약을 불투명한 항목으로만 돌려주면 빈 문자열이다. */
  readonly text: string;
  readonly usage: ModelUsage;
  /** 같은 프로바이더의 모델에 되돌려 보낼 서버 결과다. */
  readonly replay?: DistributiveOmit<CompactionReplay, 'supplement'>;
}

/** 사용량 한도 때문에 요청을 보낼 수 없다는 오류다. 어댑터의 한도 오류가 이 클래스를 상속한다. */
export class ModelLimitError extends Error {
  /** 한도가 해제되는 시각(epoch ms)이다. 프로바이더가 알려 주지 않으면 없다. */
  readonly resetAtMs?: number;
  constructor(message: string, resetAtMs?: number) {
    super(message);
    if (resetAtMs !== undefined) this.resetAtMs = resetAtMs;
  }
}

/** 서버 오류(5xx·408)나 일시적 연결 오류가 같은 계정의 재시도를 다 쓴 뒤에도 이어졌다는 오류다. 엔진이 다음 모델로 넘어간다. 계정은 바꾸지 않는다. */
export class ModelServerError extends Error {}

/** 모델 하나의 100만 토큰당 단가다. 비용 가드레일 판정에만 쓴다. 캐시 단가를 비우면 입력 단가로 계산한다. */
export interface ModelPricing {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok?: number;
  readonly cacheWritePerMTok?: number;
}

/** 비용 가드레일이 모델 요청을 막았다는 신호다. 엔진이 세션을 `cost_limit`으로 멈춘다. */
export class CostStopError extends Error {
  readonly guard: 'limit' | 'pricing_missing';
  constructor(message: string, guard: 'limit' | 'pricing_missing') {
    super(message);
    this.guard = guard;
  }
}

export interface ModelChainEntry {
  readonly provider: string;
  readonly model: string;
  readonly effort?: 'low' | 'medium' | 'high';
  /** 설정 체인의 항목이면 `config`, 사용자가 세션을 만들 때 고른 모델이면 `user`다. */
  readonly source: 'config' | 'user';
}

/** 역할마다 모델 체인을 내주고, 체인 항목으로 모델을 만든다. 모델은 요청이 필요할 때 만든다. */
export interface ModelRouter {
  /** 역할의 체인이다. 비어 있는 역할은 `default` 체인을 돌려주며, 항상 항목이 하나 이상이다. */
  chain(role: string): readonly ModelChainEntry[];
  open(entry: ModelChainEntry): Promise<ModelPort>;
  readonly fallback: {
    readonly revertPolicy: 'cooldown-expiry' | 'never';
  };
}
