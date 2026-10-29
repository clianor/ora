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
  /** 세션이 실제로 쓴 모델이다. 역할과 체인 위치마다 하나이고, 가장 나중에 쓴 항목이 맨 뒤에 온다. */
  models: z.array(
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
});
export type SessionRecord = z.infer<typeof sessionRecordSchema>;
