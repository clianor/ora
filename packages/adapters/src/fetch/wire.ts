import type { ModelRequest, ModelStreamEvent } from '@ora/core';
import type { CatalogModel, WireFormat } from './catalog.ts';

/** 모델 호출에 쓰는 자격이다. `token`은 OAuth 액세스 토큰 또는 API 키다. */
export interface WireCredential {
  readonly kind: 'oauth' | 'apiKey';
  readonly token: string;
  /** 프로바이더가 계정에 붙인 식별자다 (Claude는 account uuid). */
  readonly accountId?: string;
}

export interface WireOptions {
  readonly maxTokens?: number;
  readonly effort?: 'low' | 'medium' | 'high';
  readonly sessionId?: string;
  /** 테스트가 바꿔 끼운다. */
  readonly fetch?: typeof fetch;
  /** 재시도 대기를 바꿔 끼운다. 호출자가 신호를 취소하면 예외를 던져야 한다. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

interface WireStreamInput {
  readonly model: CatalogModel;
  readonly credential: WireCredential;
  readonly request: ModelRequest;
  readonly signal: AbortSignal;
  readonly options: WireOptions;
}

/**
 * 전송 형식 하나의 스트림 함수다. 이벤트는 `ModelPort.stream`과 같다: delta를 0회 이상 내고
 * `completed`를 정확히 한 번 낸다. 사용량은 `completed.usage`의 네 필드로 맞춘다
 * (캐시 토큰을 입력에 포함하는 형식은 `uncachedInputTokens`에서 캐시 읽기를 뺀다).
 * 사용량 한도 오류는 `UsageLimitError`로 던져 계정 전환을 일으킨다.
 */
export type WireStream = (input: WireStreamInput) => AsyncIterable<ModelStreamEvent>;

export interface OAuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** 만료 시각(epoch ms)이다. */
  readonly expiresAt: number;
  readonly accountUuid?: string;
  readonly email?: string;
}

/** 프로바이더 하나를 붙이려면 구현하는 것이다. 새 프로바이더는 파일 하나와 `providers.ts`의 한 줄이다. */
export interface ProviderDef {
  readonly id: string;
  /** 이 프로바이더의 모델이 쓰는 전송 형식이다. */
  readonly wire: WireFormat;
  /** refresh token이 회전하는 프로바이더는 새 refresh token을 돌려줘야 한다. */
  refresh(refreshToken: string, fetchImpl?: typeof fetch, now?: () => number): Promise<OAuthTokens>;
}

/** 사용량 한도에 걸린 응답이다. 같은 계정으로 다시 보내지 않고 다음 계정으로 바꾼다. */
export class UsageLimitError extends Error {
  readonly resetAtMs?: number;
  constructor(message: string, resetAtMs?: number) {
    super(message);
    this.name = 'UsageLimitError';
    if (resetAtMs !== undefined) this.resetAtMs = resetAtMs;
  }
}

/** 서버가 토큰을 거부(401)한 응답이다. OAuth 계정이면 `createFetchModel`이 토큰을 강제로 갱신해 한 번 다시 보낸다. */
export class WireAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WireAuthError';
  }
}
