/**
 * Anthropic Messages API에 구독 OAuth 토큰으로 접속할 때 보내는 요청 모양이다 (omp 18.13.2가 보내는 값을 따랐다).
 * 값이 정확해야 하는지는 문서가 없어서 실제 호출로 확인해야 한다. 바꿀 때는 이 파일만 고친다.
 */

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_MESSAGES_PATH = '/v1/messages';
export const ANTHROPIC_API_VERSION = '2023-06-01';

/** `anthropic-beta` 헤더 값이다. 앞의 둘은 OAuth 토큰이 Claude Code 요청으로 인정받는 데 필요하다. */
export const ANTHROPIC_BETA_FLAGS = ['claude-code-20250219', 'oauth-2025-04-20'] as const;

// 2026-10-28 이 PC에 설치된 Claude Code 버전(`claude --version`)이다. 서버가 거부하면 최신 버전으로 올린다.
const CLAUDE_CLI_VERSION = '2.1.312';
export const ANTHROPIC_USER_AGENT = `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`;

/** `system`의 첫 블록은 이 문장과 정확히 같아야 한다. Ora의 시스템 프롬프트는 그다음 블록이다. */
export const CLAUDE_CODE_SYSTEM_PREAMBLE =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/** 전송 층 재시도 (SPEC 2.8절). */
export const RETRY_MAX_ATTEMPTS = 5;
export const RETRY_BASE_DELAY_MS = 500;
export const RETRY_MAX_DELAY_MS = 60_000;
export const RETRYABLE_STATUSES = [408, 429] as const;
