import type { OraEvent } from '@ora/protocol';

/** 프롬프트 캐시 토큰 수입니다. `uncached`는 캐시에 닿지 않은 새 입력입니다. */
export interface CacheUsage {
  uncached: number;
  read: number;
  creation: number;
}

export interface CacheView {
  /** 세션 누적 적중률입니다. 0에서 1 사이입니다. */
  rate: number;
  session: CacheUsage;
  last: CacheUsage | null;
  /** 캐시 유지 시간입니다. 서버 설정에서 받은 값만 적습니다. */
  ttl?: string;
}

/** 요청 한 건의 사용량에서 캐시 토큰 수를 읽습니다. */
function readCacheUsage(usage: {
  uncachedInputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}): CacheUsage {
  return {
    uncached: usage.uncachedInputTokens,
    read: usage.cacheReadInputTokens,
    creation: usage.cacheCreationInputTokens,
  };
}

export function totalInput(usage: CacheUsage): number {
  return usage.uncached + usage.read + usage.creation;
}

/** 적중률은 읽은 토큰을 전체 입력으로 나눈 값입니다. 전체 입력이 0이면 null입니다. */
function getHitRate(usage: CacheUsage): number | null {
  const total = totalInput(usage);
  return total === 0 ? null : usage.read / total;
}

/** 세션의 `model_request` 이벤트에서 캐시 보기를 만듭니다. 전체 입력이 0이면 null이라 항목을 숨깁니다. */
export function buildCacheView(events: readonly OraEvent[], ttl?: string): CacheView | null {
  const session: CacheUsage = { uncached: 0, read: 0, creation: 0 };
  let last: CacheUsage | null = null;
  for (const event of events) {
    if (event.type !== 'model_request') continue;
    const usage = readCacheUsage(event.payload.usage);
    session.uncached += usage.uncached;
    session.read += usage.read;
    session.creation += usage.creation;
    last = usage;
  }
  const rate = getHitRate(session);
  return rate === null ? null : { rate, session, last, ttl };
}

/** 토큰 수를 `182.4k`, `0.3k`처럼 천 단위로 소수 한 자리까지 적습니다. */
export function formatTokens(count: number): string {
  return `${(count / 1000).toFixed(1)}k`;
}

export function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}
