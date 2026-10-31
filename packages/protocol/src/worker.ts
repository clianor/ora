import { z } from 'zod';
import {
  endReasonSchema,
  isolationSchema,
  permissionModeSchema,
  sessionIdSchema,
  sessionStatusSchema,
} from './common.ts';
import { oraEventSchema } from './event.ts';
import {
  approvalDecisionSchema,
  approvalRequestSchema,
  questionAnswerSchema,
  questionRequestSchema,
} from './interaction.ts';
import { todoSchema } from './todo.ts';

const launchFields = {
  sessionId: sessionIdSchema,
  cwd: z.string().min(1),
  /** 있으면 가짜 모델 스크립트를 쓰고, 없으면 설정의 실제 모델을 쓴다. */
  modelScriptPath: z.string().min(1).optional(),
  modelInputLogPath: z.string().min(1).optional(),
  configPath: z.string().min(1).optional(),
  /** 격리 옵션을 지정한다 (SPEC 5.6절). 새 세션은 설정 기본값보다 앞서고, 재개는 세션 기록이 앞선다. */
  isolation: isolationSchema.optional(),
  /** true면 승인과 `ask_user`를 호스트로 올려 답을 기다린다. false면 `ora run`처럼 응답할 사람이 없는 headless 실행이다. */
  interactive: z.boolean().optional(),
};

/** 호스트가 워커에 보내는 명령이다 (SPEC 2.6.1절의 createSession, resumeSession, cancel). */
export const workerCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('createSession'),
    ...launchFields,
    task: z.string().min(1),
    permissionMode: permissionModeSchema.optional(),
    /** `<프로바이더>/<모델>[:<추론 강도>]`다. 주면 이 세션의 `default` 체인 맨 앞에 넣는다. */
    model: z.string().min(1).optional(),
  }),
  z.strictObject({
    type: z.literal('resumeSession'),
    ...launchFields,
    steer: z.string().min(1).optional(),
  }),
  z.strictObject({ type: z.literal('cancel'), mode: z.enum(['soft', 'hard']) }),
  /** 위임 카드의 "중지"다. 그 하위 세션만 소프트 스톱하고 부모는 계속 돈다. */
  z.strictObject({ type: z.literal('cancelDelegate'), sessionId: sessionIdSchema }),
  z.strictObject({
    type: z.literal('todoAction'),
    todoId: z.string().min(1),
    action: z.enum(['abandon', 'restore']),
  }),
  z.strictObject({
    type: z.literal('resolveApproval'),
    requestId: z.string().min(1),
    decision: approvalDecisionSchema,
  }),
  z.strictObject({
    type: z.literal('answerQuestion'),
    requestId: z.string().min(1),
    answers: z.array(questionAnswerSchema),
  }),
]);
export type WorkerCommand = z.infer<typeof workerCommandSchema>;
export type LaunchCommand = Extract<WorkerCommand, { type: 'createSession' | 'resumeSession' }>;

/** 워커가 호스트에 보내는 메시지다. 이벤트는 transcript와 같은 스키마를 쓴다. */
export const workerMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('event'), event: oraEventSchema }),
  z.strictObject({
    type: z.literal('result'),
    status: sessionStatusSchema,
    endReason: endReasonSchema,
    summary: z.string(),
    cost: z.number().nonnegative().optional(),
    todos: z.array(todoSchema),
  }),
  // 세션을 시작하기 전에 알 수 있는 사용 오류(설정, 모델 스크립트, 재개 불가 상태)다.
  z.strictObject({ type: z.literal('usage_error'), message: z.string() }),
  z.strictObject({
    type: z.literal('approval_request'),
    requestId: z.string().min(1),
    request: approvalRequestSchema,
  }),
  z.strictObject({
    type: z.literal('question_request'),
    requestId: z.string().min(1),
    request: questionRequestSchema,
  }),
  /** 응답 없이 신호가 취소돼 워커가 거둔 승인·질문이다. 호스트는 대기 목록에서 지운다. */
  z.strictObject({ type: z.literal('request_withdrawn'), requestId: z.string().min(1) }),
]);
export type WorkerMessage = z.infer<typeof workerMessageSchema>;
