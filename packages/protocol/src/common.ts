import { z } from 'zod';

export const timestampSchema = z.iso.datetime({ offset: true });

export const sessionIdSchema = z.string().regex(/^s-\d{8}-[A-Za-z0-9]{6}$/);

export const sessionStatusSchema = z.enum([
  'created',
  'running',
  'awaiting_approval',
  'awaiting_user',
  'interrupted',
  'completed',
  'stopped',
  'failed',
  'crashed',
  'merge_pending',
  'conflicted',
  'merged',
  'archived',
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const endReasonSchema = z.enum([
  'passed',
  'max_steps',
  'no_progress',
  'context_overflow',
  'cost_limit',
  'error',
  'user_cancel',
  'blocked',
  'abandoned',
]);
export type EndReason = z.infer<typeof endReasonSchema>;

export const stageSchema = z.enum([
  'understand',
  'research',
  'decide',
  'plan',
  'execute',
  'verify',
  'operate',
  'learn',
]);
export type Stage = z.infer<typeof stageSchema>;

export const permissionModeSchema = z.enum(['always-ask', 'write', 'bypass-permissions']);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

export const isolationSchema = z.enum(['none', 'harness', 'clean-home']);
export type Isolation = z.infer<typeof isolationSchema>;

export const toolTierSchema = z.enum(['read', 'write', 'exec']);
export type ToolTier = z.infer<typeof toolTierSchema>;

export const actorSchema = z.enum(['model', 'user', 'engine', 'tool', 'routine']);
export type Actor = z.infer<typeof actorSchema>;

export const toolResultStatusSchema = z.enum(['ok', 'error', 'aborted', 'timeout']);
export type ToolResultStatus = z.infer<typeof toolResultStatusSchema>;

export const approvalScopeSchema = z.enum(['once', 'session', 'always']);
export type ApprovalScope = z.infer<typeof approvalScopeSchema>;
