import { z } from 'zod';
import {
  actorSchema,
  approvalScopeSchema,
  endReasonSchema,
  isolationSchema,
  permissionModeSchema,
  sessionIdSchema,
  sessionStatusSchema,
  stageSchema,
  timestampSchema,
  toolResultStatusSchema,
  toolTierSchema,
} from './common.ts';
import { evidenceSchema, todoSchema, todoStatusSchema } from './todo.ts';

const jsonObjectSchema = z.record(z.string(), z.unknown());

export const contentBlockSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string() }),
  z.strictObject({
    type: z.literal('thinking'),
    text: z.string(),
    signature: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal('tool_use'),
    callId: z.string().min(1),
    tool: z.string().min(1),
    input: jsonObjectSchema,
  }),
  z.strictObject({
    type: z.literal('tool_result'),
    callId: z.string().min(1),
    text: z.string(),
    isError: z.boolean(),
  }),
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;

function defineEvent<TType extends string, TPayload extends z.ZodType>(
  type: TType,
  payload: TPayload,
) {
  return z.strictObject({
    seq: z.number().int().positive(),
    ts: timestampSchema,
    sessionId: sessionIdSchema,
    actor: actorSchema,
    stepId: z.string().min(1).optional(),
    type: z.literal(type),
    payload,
  });
}

export const oraEventSchema = z.discriminatedUnion('type', [
  defineEvent(
    'session_start',
    z.strictObject({
      configSummary: jsonObjectSchema,
      isolation: isolationSchema,
      permissionMode: permissionModeSchema,
      harnessFilesFound: z.array(z.string()).optional(),
      instructionFiles: z.array(
        z.strictObject({
          path: z.string().min(1),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
        }),
      ),
      promptHash: z.string().min(1),
    }),
  ),
  defineEvent(
    'stage',
    z.discriminatedUnion('outcome', [
      z.strictObject({ outcome: z.literal('entered'), stage: stageSchema }),
      z.strictObject({
        outcome: z.literal('skipped'),
        stage: stageSchema,
        reason: z.string().min(1),
      }),
    ]),
  ),
  defineEvent(
    'message',
    z.strictObject({
      role: z.enum(['user', 'assistant']),
      content: z.array(contentBlockSchema),
      providerMetadata: jsonObjectSchema.optional(),
    }),
  ),
  defineEvent(
    'model_request',
    z.strictObject({
      model: z.string().min(1),
      adapter: z.string().min(1),
      chainPosition: z.number().int().nonnegative(),
      nativeToolCalls: z.boolean(),
      usage: z.strictObject({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        cachedInputTokens: z.number().int().nonnegative().optional(),
      }),
      durationMs: z.number().int().nonnegative(),
    }),
  ),
  defineEvent('intent', z.strictObject({ text: z.string().min(1) })),
  defineEvent(
    'tool_call',
    z.strictObject({
      callId: z.string().min(1),
      tool: z.string().min(1),
      args: jsonObjectSchema,
      tier: toolTierSchema.optional(),
    }),
  ),
  defineEvent(
    'tool_result',
    z.strictObject({
      callId: z.string().min(1),
      status: toolResultStatusSchema,
      summary: z.string(),
      durationMs: z.number().int().nonnegative(),
      outputRef: z.string().min(1).optional(),
    }),
  ),
  defineEvent(
    'permission',
    z.strictObject({
      callId: z.string().min(1),
      mode: permissionModeSchema,
      policy: z.enum(['allow', 'prompt', 'deny']).optional(),
      decision: z.enum(['auto', 'approved', 'denied']),
      scope: approvalScopeSchema.optional(),
      originalCommand: z.string().optional(),
      editedCommand: z.string().optional(),
    }),
  ),
  // 변경 주체는 envelope의 actor다. rejected가 있으면 to는 요청된 상태이고 todo는 거부 전 스냅샷이다.
  defineEvent(
    'todo_update',
    z.strictObject({
      todoId: z.string().min(1),
      from: todoStatusSchema.optional(),
      to: todoStatusSchema,
      todo: todoSchema,
      rejected: z.strictObject({ reason: z.string().min(1) }).optional(),
    }),
  ),
  defineEvent(
    'verification',
    z.strictObject({
      todoId: z.string().min(1),
      evidence: evidenceSchema,
      gate: z.strictObject({ passed: z.boolean(), findings: z.array(z.string()) }).optional(),
    }),
  ),
  defineEvent(
    'cancel',
    z.strictObject({
      mode: z.enum(['soft', 'hard']),
      previousStatus: sessionStatusSchema,
    }),
  ),
  defineEvent(
    'session_end',
    z.strictObject({
      status: sessionStatusSchema,
      endReason: endReasonSchema,
      summary: z.string(),
    }),
  ),
]);

export type OraEvent = z.infer<typeof oraEventSchema>;
export type OraEventType = OraEvent['type'];
export type EventOf<TType extends OraEventType> = Extract<OraEvent, { type: TType }>;
