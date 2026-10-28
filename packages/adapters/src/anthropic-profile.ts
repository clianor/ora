/** Anthropic Messages API 요청 상수다. 인증은 API 키(`x-api-key`)와 구독 OAuth(Bearer)를 모두 쓴다. */

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_MESSAGES_PATH = '/v1/messages';
export const ANTHROPIC_API_VERSION = '2023-06-01';

/** API 키 경로에서 1시간 TTL 캐시 표시를 받으려면 필요한 베타다. */
export const EXTENDED_CACHE_TTL_BETA = 'extended-cache-ttl-2025-04-11';

export interface CacheControl {
  readonly type: 'ephemeral';
  readonly ttl?: '1h';
}

/** 프롬프트 캐시 표시다. 시스템 프롬프트 끝, 도구 목록 끝, 마지막 메시지에 붙인다. */
export function cacheControlFor(ttl: '5m' | '1h'): CacheControl {
  return ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

/** 전송 층 재시도 (SPEC 2.8절). */
export const RETRY_MAX_ATTEMPTS = 5;
export const RETRY_BASE_DELAY_MS = 500;
export const RETRY_MAX_DELAY_MS = 60_000;
export const RETRYABLE_STATUSES = [408, 409, 429] as const;
