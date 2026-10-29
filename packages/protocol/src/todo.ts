import { z } from 'zod';
import { timestampSchema } from './common.ts';

export const todoStatusSchema = z.enum([
  'pending',
  'attempted',
  'claimed_verified',
  'verified',
  'failed',
  'interrupted',
  'blocked',
  'abandoned',
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

/** phase 이름이 없는 todo가 속하는 기본 phase다. 예전 세션 기록의 todo도 같은 규칙으로 읽는다. */
export const defaultPhaseName = '할 일';

export const todoSchema = z.strictObject({
  id: z.string().min(1),
  content: z.string().min(1),
  status: todoStatusSchema,
  attempts: z.number().int().nonnegative(),
  writeScope: z.array(z.string()),
  /** 앞뒤 공백을 지운 1~40자다. 예전 기록에는 없고, 없으면 `defaultPhaseName`이다. */
  phase: z.string().min(1).max(40).optional(),
  /** `blocked`일 때 가장 최근에 적은 사유(1~300자)다. */
  blockedReason: z.string().min(1).max(300).optional(),
  verify: z.strictObject({ command: z.string().min(1), origin: evidenceOriginSchema }).optional(),
  evidence: evidenceSchema.optional(),
  updatedAt: timestampSchema,
});
export type Todo = z.infer<typeof todoSchema>;
