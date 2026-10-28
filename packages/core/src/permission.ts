import type { PermissionMode, ToolTier } from '@ora/protocol';

export type ToolPolicy = 'allow' | 'prompt' | 'deny';
export type PermissionVerdict = 'auto' | 'ask' | 'deny';

const AUTO_TIERS: Readonly<Record<PermissionMode, readonly ToolTier[]>> = {
  'always-ask': ['read'],
  write: ['read', 'write'],
  'bypass-permissions': ['read', 'write', 'exec'],
};

/** 도구별 정책이 모드보다 앞선다 (SPEC 5.1절). */
export function decidePermission(input: {
  readonly mode: PermissionMode;
  readonly tier: ToolTier;
  readonly policy?: ToolPolicy;
}): PermissionVerdict {
  if (input.policy === 'allow') return 'auto';
  if (input.policy === 'deny') return 'deny';
  if (input.policy === 'prompt') return 'ask';
  return AUTO_TIERS[input.mode].includes(input.tier) ? 'auto' : 'ask';
}

const HIGH_RISK = [
  /\brm\s+-\w*[rf]/,
  /\bdd\b/,
  /\bmkfs/,
  /\bsudo\b/,
  /\bchmod\s+-R/,
  /\bchown\b/,
  /\b(curl|wget)\b[^|]*\|\s*(sh|bash)\b/,
  /\bgit\s+push\b.*--force/,
  /\bgit\s+reset\s+--hard/,
  /\bgit\s+clean\s+-\w*f/,
  /(^|[^>])>[^>]/,
];
const MEDIUM_RISK = [
  /\b(curl|wget|ssh|scp)\b/,
  /\b(npm|pnpm|yarn|pip|brew)\s+(install|add|i)\b/,
  /\bgit\s+push\b/,
];

/** 명령 문자열의 단순 패턴 일치로 위험도를 가른다. 등급은 사용자에게 보여 주는 정보이고 권한 판정에는 쓰지 않는다 (SPEC 5.1절). */
export function assessRisk(command: string): 'low' | 'medium' | 'high' {
  if (HIGH_RISK.some((pattern) => pattern.test(command))) return 'high';
  if (MEDIUM_RISK.some((pattern) => pattern.test(command))) return 'medium';
  return 'low';
}
