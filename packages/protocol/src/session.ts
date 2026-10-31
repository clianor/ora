import { z } from 'zod';
import { approvalRuleSchema } from './interaction.ts';
import {
  endReasonSchema,
  isolationSchema,
  permissionModeSchema,
  sessionIdSchema,
  sessionStatusSchema,
  timestampSchema,
} from './common.ts';

const PROVIDER_BY_MODEL_PREFIX: readonly (readonly [string, string])[] = [
  ['claude-', 'claude'],
  ['gpt-', 'codex'],
  ['grok-', 'grok'],
  ['fake/', 'fake'],
];

/** 체인 도입 전 기록의 `models` 항목에는 프로바이더, 체인 위치, 출처가 없다. 읽을 때만 채우고 파일은 고쳐 쓰지 않는다. */
function fillLegacyModels(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || 'provider' in entry) return entry;
    const model = 'model' in entry && typeof entry.model === 'string' ? entry.model : '';
    const provider = PROVIDER_BY_MODEL_PREFIX.find(([prefix]) => model.startsWith(prefix))?.[1];
    return { provider: provider ?? 'unknown', chainPosition: 0, source: 'config', ...entry };
  });
}

export const sessionRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: sessionIdSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  title: z.string(),
  actor: z.string().regex(/^(user|routine:.+)$/),
  status: sessionStatusSchema,
  endReason: endReasonSchema.optional(),
  repo: z.string().min(1).optional(),
  /** 사용자가 만든 `ora/*` worktree에서 연 세션만 가진다. worktree를 만든 시점 부모 브랜치의 HEAD 커밋 해시다 (SPEC 2.7절). */
  baseRef: z.string().min(1).optional(),
  /** 세션이 실제로 쓴 모델이다. 역할과 체인 위치마다 하나이고, 가장 나중에 쓴 항목이 맨 뒤에 온다. */
  models: z.preprocess(
    fillLegacyModels,
    z.array(
      z.strictObject({
        model: z.string().min(1),
        provider: z.string().min(1),
        role: z.string().min(1),
        chainPosition: z.number().int().nonnegative(),
        effort: z.enum(['low', 'medium', 'high']).optional(),
        /** `config`는 설정 체인, `user`는 사용자가 세션을 만들 때 고른 모델, `fallback`은 앞 모델이 실패해 넘어간 모델이다. */
        source: z.enum(['config', 'user', 'fallback']),
      }),
    ),
  ),
  permissionMode: permissionModeSchema,
  isolation: isolationSchema,
  promptHash: z.string().min(1),
  engineVersion: z.string().min(1),
  /** "이 세션 동안" 승인한 규칙이다. 재개한 뒤에도 유지한다 (SPEC 5.1절). */
  approvals: z.array(approvalRuleSchema).optional(),
  /** 세션이 고정한 모델 계정이다. 프롬프트 캐시와 서명된 reasoning을 지키려고 재개할 때 같은 계정을 이어 쓴다 (SPEC 2.8절). */
  accountPin: z
    .strictObject({
      provider: z.string().min(1),
      account: z.string().min(1),
      lastUsedAt: timestampSchema,
    })
    .optional(),
  /** 되돌리기 기록이다. 되돌린 시각과 되돌아간 사용자 메시지의 이벤트 번호다. 취소했으면 취소 시각이 있다 (SPEC 4.1.1절, 4.4절). */
  rewinds: z
    .array(
      z.strictObject({
        at: timestampSchema,
        targetSeq: z.number().int().positive(),
        undoneAt: timestampSchema.optional(),
      }),
    )
    .optional(),
  /** 하위 세션만 가진다. 일을 맡긴 부모 세션 ID, 위임 호출 ID, 에이전트 정의 이름이다 (SPEC 2.15.1절). */
  delegatedBy: z
    .strictObject({
      sessionId: sessionIdSchema,
      callId: z.string().min(1),
      agent: z.string().min(1),
      /** 위임할 때 정한 쓰기 범위와 정의의 최대 스텝이다. 하위 세션 탭의 머리 띠가 보인다. */
      writeScope: z.array(z.string()).optional(),
      maxSteps: z.number().int().positive().optional(),
    })
    .optional(),
});
export type SessionRecord = z.infer<typeof sessionRecordSchema>;
