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
import {
  approvalRequestSchema,
  questionAnswerSchema,
  questionRequestSchema,
} from './interaction.ts';
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
      /** 이 메시지가 담은 사용자 지시 원문이다(최초 요청, 승인 거부 때의 조향, 재개 조향). 알림문이나 todo 목록은 넣지 않는다. 압축 요약의 "사용자 지시"는 이 필드만 읽는다. */
      instructions: z.array(z.string()).optional(),
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
        uncachedInputTokens: z.number().int().nonnegative(),
        cacheReadInputTokens: z.number().int().nonnegative(),
        cacheCreationInputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      }),
      durationMs: z.number().int().nonnegative(),
      /** 요약 요청이면 `compaction`이다. 스텝 요청에는 없다. 엔진은 이 값이 있는 요청을 입력 토큰 어림의 기준으로 쓰지 않는다. */
      purpose: z.literal('compaction').optional(),
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
      /** 승인은 적용했지만 기억 저장에 실패했을 때 사용자에게 보여 줄 경고다. */
      warning: z.string().optional(),
    }),
  ),
  // 승인 응답을 기다리기 시작할 때 `session.json`을 `awaiting_approval`로 바꾸기 전에 쓴다. 대기 중인 요청은 이 이벤트로 다시 만든다.
  defineEvent('approval_request', approvalRequestSchema),
  // `ask_user`의 답을 기다리기 시작할 때 `session.json`을 `awaiting_user`로 바꾸기 전에 쓴다.
  defineEvent('question', questionRequestSchema),
  // 사용자가 `ask_user`에 답했다는 기록이다. 상태를 `running`으로 되돌리기 전에 쓴다.
  defineEvent(
    'answer',
    z.strictObject({ callId: z.string().min(1), answers: z.array(questionAnswerSchema) }),
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
  // 하드 킬이나 전원 차단으로 깨진 마지막 줄을 버렸다는 기록이다. 파일은 고치지 않고 이 이벤트만 덧붙인다.
  defineEvent(
    'recovered',
    z.strictObject({
      droppedLines: z.number().int().positive(),
      droppedBytes: z.number().int().nonnegative(),
      afterSeq: z.number().int().nonnegative(),
    }),
  ),
  // 컨텍스트 압축 결과다 (SPEC 4.3절). `prune`은 도구 출력 가지치기, `shake`는 모델 없이 큰 블록을 참조로 바꾼 것, `handoff`와 `summary`는 요약 파일이 앞 메시지를 대신한 것이다.
  // 범위는 컨텍스트에서 바뀐 메시지의 seq 범위다. transcript 파일의 원본 이벤트는 그대로 남고, 재개는 이 이벤트들을 같은 순서로 다시 적용한다.
  defineEvent(
    'compaction',
    z.strictObject({
      method: z.enum(['prune', 'shake', 'handoff', 'summary']).default('summary'),
      fromSeq: z.number().int().positive(),
      toSeq: z.number().int().positive(),
      /** `handoff`와 `summary`만 있다. */
      path: z.string().min(1).optional(),
      /** 이 이벤트가 자리표시로 바꾼 도구 호출 ID다. */
      prunedCallIds: z.array(z.string().min(1)).default([]),
      /** `prune`과 `shake`가 줄인 어림 토큰 수다. 이전 기록에는 없다. */
      savedTokens: z.number().int().nonnegative().optional(),
    }),
  ),
  // 재개할 때 모델 컨텍스트에서 뺀 seq 범위다. transcript 파일에는 그대로 남는다.
  defineEvent(
    'context_trim',
    z.strictObject({
      fromSeq: z.number().int().positive(),
      toSeq: z.number().int().positive(),
      reason: z.enum(['failed_batch', 'aborted_batch']),
    }),
  ),
  defineEvent(
    'resume',
    z.strictObject({
      fromStatus: sessionStatusSchema,
      hardKilled: z.boolean(),
      steered: z.boolean(),
      resumePointTodoId: z.string().min(1).optional(),
      /** 마지막 압축 요약 파일을 읽지 못해 이전 요약이나 원본 메시지로 컨텍스트를 다시 만들었다는 기록이다. `usedPath`가 없으면 원본 메시지를 썼다. */
      summaryFallback: z
        .strictObject({ missing: z.array(z.string()).min(1), usedPath: z.string().optional() })
        .optional(),
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
