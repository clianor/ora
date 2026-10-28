import { z } from 'zod';
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
});
export type SessionRecord = z.infer<typeof sessionRecordSchema>;
