/**
 * 비밀 스크럽 패턴 목록의 정본이다 (SPEC 5.2절).
 * 이벤트·artifact·모델 관찰 마스킹, 환경변수 제거, 기억 Intake의 Refuse 판정이 모두 이 파일의 목록을 쓴다.
 */

interface ScrubRule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
}

const SCRUB_RULES: readonly ScrubRule[] = [
  {
    name: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED:private-key]',
  },
  {
    name: 'bearer',
    pattern: /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/g,
    replacement: '$1[REDACTED:bearer]',
  },
  {
    name: 'token-prefix',
    pattern: /\b(?:sk|pk)-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED:token-prefix]',
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
    replacement: '[REDACTED:jwt]',
  },
  {
    name: 'url-credentials',
    pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi,
    replacement: '$1[REDACTED:url-credentials]$2',
  },
  {
    name: 'env-assignment',
    pattern:
      /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*=)(?:"[^"\n]*"|'[^'\n]*'|\S+)/g,
    replacement: '$1[REDACTED:env-assignment]',
  },
];

const SECRET_ENV_KEY = /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

/** 패턴 이름별 마스킹 횟수다. */
export type ScrubHits = Record<string, number>;

export interface ScrubResult {
  readonly text: string;
  readonly hits: Readonly<ScrubHits>;
}

export function mergeScrubHits(target: ScrubHits, source: Readonly<ScrubHits>): void {
  for (const [name, count] of Object.entries(source)) target[name] = (target[name] ?? 0) + count;
}

export function scrubText(text: string): ScrubResult {
  const hits: ScrubHits = {};
  let scrubbed = text;
  for (const rule of SCRUB_RULES) {
    const count = scrubbed.match(rule.pattern)?.length ?? 0;
    if (count === 0) continue;
    hits[rule.name] = count;
    scrubbed = scrubbed.replace(rule.pattern, rule.replacement);
  }
  return { text: scrubbed, hits };
}

/** 텍스트에서 찾은 비밀 패턴의 이름 목록이다. 없으면 빈 배열이다. */
export function findSecretPatterns(text: string): string[] {
  return SCRUB_RULES.filter((rule) => (text.match(rule.pattern)?.length ?? 0) > 0).map(
    (rule) => rule.name,
  );
}

export function isSecretEnvKey(key: string): boolean {
  return SECRET_ENV_KEY.test(key);
}

export function describeScrubHits(hits: Readonly<ScrubHits>): string {
  return Object.entries(hits)
    .map(([name, count]) => `${name}×${count}`)
    .join(', ');
}

/** JSON으로 직렬화할 값 안의 모든 문자열을 마스킹한다. `hits`를 주면 마스킹 횟수를 더한다. */
export function scrubValue<T>(value: T, hits?: ScrubHits): T {
  return scrubUnknown(value, hits) as T;
}

function scrubUnknown(value: unknown, hits?: ScrubHits): unknown {
  if (typeof value === 'string') {
    const result = scrubText(value);
    if (hits !== undefined) mergeScrubHits(hits, result.hits);
    return result.text;
  }
  if (Array.isArray(value)) return value.map((item) => scrubUnknown(item, hits));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrubUnknown(item, hits)]),
    );
  }
  return value;
}
