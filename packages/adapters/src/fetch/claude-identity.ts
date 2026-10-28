/**
 * 구독 OAuth 토큰으로 `/v1/messages`를 부를 때 붙이는 Claude Code 식별 정보다.
 * 값은 omp(can1357/oh-my-pi)의 `providers/anthropic.ts`와 `anthropic-identity.ts`를 따라 직접 구현했다.
 * Claude Code 공식 문서가 이 방식을 금지하므로 Anthropic이 계정을 정지할 수 있다 (SPEC 2.4절).
 */
import { createHash, randomUUID } from 'node:crypto';
import { ANTHROPIC_API_VERSION } from '../anthropic-profile.ts';

const CLAUDE_CODE_VERSION = '2.1.280';
const STAINLESS_PACKAGE_VERSION = '0.112.1';

export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

const BILLING_SALT = '59cf53e54c78';
const CCH_SEED = 0x4d659218e32a3268n;
const CCH_PLACEHOLDER = 'cch=00000';

const MASK = 0xffffffffffffffffn;
const PRIME1 = 11400714785074694791n;
const PRIME2 = 14029467366897019727n;
const PRIME3 = 1609587929392839161n;
const PRIME4 = 9650029242287828579n;
const PRIME5 = 2870177450012600261n;

const rotateLeft = (value: bigint, bits: bigint): bigint =>
  ((value << bits) | (value >> (64n - bits))) & MASK;
const multiply = (a: bigint, b: bigint): bigint => (a * b) & MASK;
const round = (accumulator: bigint, input: bigint): bigint =>
  multiply(rotateLeft((accumulator + multiply(input, PRIME2)) & MASK, 31n), PRIME1);
const mergeRound = (accumulator: bigint, value: bigint): bigint =>
  (multiply(accumulator ^ round(0n, value), PRIME1) + PRIME4) & MASK;

/** XXHash64를 직접 구현했다 (BSD-2 알고리즘, 새 의존성 없음). */
export function xxHash64(data: Uint8Array, seed = 0n): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const length = data.byteLength;
  let offset = 0;
  let hash: bigint;
  if (length >= 32) {
    let v1 = (seed + PRIME1 + PRIME2) & MASK;
    let v2 = (seed + PRIME2) & MASK;
    let v3 = seed;
    let v4 = (seed - PRIME1) & MASK;
    for (; offset + 32 <= length; offset += 32) {
      v1 = round(v1, view.getBigUint64(offset, true));
      v2 = round(v2, view.getBigUint64(offset + 8, true));
      v3 = round(v3, view.getBigUint64(offset + 16, true));
      v4 = round(v4, view.getBigUint64(offset + 24, true));
    }
    hash =
      (rotateLeft(v1, 1n) + rotateLeft(v2, 7n) + rotateLeft(v3, 12n) + rotateLeft(v4, 18n)) & MASK;
    for (const lane of [v1, v2, v3, v4]) hash = mergeRound(hash, lane);
  } else {
    hash = (seed + PRIME5) & MASK;
  }
  hash = (hash + BigInt(length)) & MASK;
  for (; offset + 8 <= length; offset += 8) {
    hash ^= round(0n, view.getBigUint64(offset, true));
    hash = (multiply(rotateLeft(hash, 27n), PRIME1) + PRIME4) & MASK;
  }
  if (offset + 4 <= length) {
    hash ^= multiply(BigInt(view.getUint32(offset, true)), PRIME1);
    hash = (multiply(rotateLeft(hash, 23n), PRIME2) + PRIME3) & MASK;
    offset += 4;
  }
  for (; offset < length; offset += 1) {
    hash ^= multiply(BigInt(view.getUint8(offset)), PRIME5);
    hash = multiply(rotateLeft(hash, 11n), PRIME1);
  }
  hash ^= hash >> 33n;
  hash = multiply(hash, PRIME2);
  hash ^= hash >> 29n;
  hash = multiply(hash, PRIME3);
  hash ^= hash >> 32n;
  return hash;
}

/** 본문 전체(`cch=00000` 자리표시자 포함)의 해시에서 하위 20비트를 5자리 16진수로 만든다. */
export function replaceCch(body: string): string {
  const hash = xxHash64(new TextEncoder().encode(body), CCH_SEED);
  return body.replace(CCH_PLACEHOLDER, `cch=${(hash & 0xfffffn).toString(16).padStart(5, '0')}`);
}

/** 첫 사용자 메시지 텍스트의 4, 7, 20번째 글자로 버전 접미사를 만든다. */
export function buildBillingText(firstUserText: string): string {
  const picked = [4, 7, 20].map((index) => firstUserText[index] ?? '0').join('');
  const suffix = createHash('sha256')
    .update(`${BILLING_SALT}${picked}${CLAUDE_CODE_VERSION}`)
    .digest('hex')
    .slice(0, 3);
  return `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${suffix}; cc_entrypoint=cli; ${CCH_PLACEHOLDER};`;
}

// 구독 토큰에 `context-1m-2025-08-07`을 보내면 429가 나므로 넣지 않는다.
const AGENT_BETAS = [
  'claude-code-20250219',
  'oauth-2025-04-20', // gitleaks:allow
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'mid-conversation-system-2026-04-07',
];
const UTILITY_BETAS = [
  'oauth-2025-04-20', // gitleaks:allow
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'structured-outputs-2025-12-15',
];

export function buildOauthBetas(options: { hasTools: boolean; hasEffort: boolean }): string {
  if (!options.hasTools && !options.hasEffort) return UTILITY_BETAS.join(',');
  return [
    ...AGENT_BETAS,
    ...(options.hasEffort ? ['effort-2025-11-24'] : []),
    'fallback-credit-2026-06-01',
  ].join(',');
}

export function buildOauthHeaders(options: {
  token: string;
  betas: string;
  sessionId: string;
}): Record<string, string> {
  return {
    authorization: `Bearer ${options.token}`,
    accept: 'application/json',
    'content-type': 'application/json',
    'anthropic-version': ANTHROPIC_API_VERSION,
    'user-agent': `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
    'x-app': 'cli',
    'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-beta': options.betas,
    'x-claude-code-session-id': options.sessionId,
    'x-stainless-arch': process.arch,
    'x-stainless-lang': 'js',
    'x-stainless-os': process.platform,
    'x-stainless-package-version': STAINLESS_PACKAGE_VERSION,
    'x-stainless-retry-count': '0',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': process.version,
    'x-stainless-timeout': '600',
  };
}

export function buildMetadataUserId(accountUuid: string | undefined, sessionId: string): string {
  const device = createHash('sha256')
    .update(`ora-claude-device-id-v1\0${accountUuid ?? ''}`)
    .digest('hex');
  return JSON.stringify({
    device_id: device,
    session_id: sessionId,
    ...(accountUuid === undefined ? {} : { account_uuid: accountUuid }),
  });
}

/** 도구 이름은 `_` 접두사를 붙여 보내고 응답에서 뗀다. 서버가 쓰는 이름은 붙이지 않는다. */
const UNPREFIXED_TOOLS: Record<string, true> = {
  web_search: true,
  code_execution: true,
  text_editor: true,
  computer: true,
};
export const toOauthToolName = (apiName: string): string =>
  apiName in UNPREFIXED_TOOLS ? apiName : `_${apiName}`;
export const fromOauthToolName = (name: string): string =>
  name.startsWith('_') ? name.slice(1) : name;

export const newSessionId = (): string => randomUUID();
