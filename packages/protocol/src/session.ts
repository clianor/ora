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
  models: z.array(z.strictObject({ model: z.string().min(1), role: z.string().min(1) })),
  permissionMode: permissionModeSchema,
  isolation: isolationSchema,
  promptHash: z.string().min(1),
  engineVersion: z.string().min(1),
  /** "이 세션 동안" 승인한 규칙이다. 재개한 뒤에도 유지한다 (SPEC 5.1절). */
  approvals: z.array(approvalRuleSchema).optional(),
});
export type SessionRecord = z.infer<typeof sessionRecordSchema>;
