import { z } from 'zod';
import { timestampSchema } from './common.ts';

export const todoStatusSchema = z.enum([
  'pending',
  'attempted',
  'claimed_verified',
  'verified',
  'failed',
  'interrupted',
]);
export type TodoStatus = z.infer<typeof todoStatusSchema>;

export const evidenceOriginSchema = z.enum(['user', 'repo', 'model']);
export type EvidenceOrigin = z.infer<typeof evidenceOriginSchema>;

export const evidenceSchema = z.strictObject({
  command: z.string().min(1),
  exitCode: z.number().int().optional(),
  summary: z.string(),
  origin: evidenceOriginSchema,
  ranAt: timestampSchema,
  scopeDigest: z.string().regex(/^sha256:[0-9a-f]+$/),
  outputRef: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const todoSchema = z.strictObject({
  id: z.string().min(1),
  content: z.string().min(1),
  status: todoStatusSchema,
  attempts: z.number().int().nonnegative(),
  writeScope: z.array(z.string()),
  verify: z.strictObject({ command: z.string().min(1), origin: evidenceOriginSchema }).optional(),
  evidence: evidenceSchema.optional(),
  updatedAt: timestampSchema,
});
export type Todo = z.infer<typeof todoSchema>;
