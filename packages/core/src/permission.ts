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
