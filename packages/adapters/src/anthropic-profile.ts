/** Anthropic Messages API 요청 상수다. 인증은 API 키(`x-api-key`)뿐이다. */

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_MESSAGES_PATH = '/v1/messages';
export const ANTHROPIC_API_VERSION = '2023-06-01';

/** 프롬프트 캐시 표시다. 시스템 프롬프트 끝, 도구 목록 끝, 마지막 메시지에 붙인다 (1시간 TTL). */
export const CACHE_CONTROL = { type: 'ephemeral', ttl: '1h' } as const;

/** 전송 층 재시도 (SPEC 2.8절). */
export const RETRY_MAX_ATTEMPTS = 5;
export const RETRY_BASE_DELAY_MS = 500;
export const RETRY_MAX_DELAY_MS = 60_000;
export const RETRYABLE_STATUSES = [408, 429] as const;
