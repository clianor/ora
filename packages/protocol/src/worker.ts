import { z } from 'zod';
import {
  endReasonSchema,
  permissionModeSchema,
  sessionIdSchema,
  sessionStatusSchema,
} from './common.ts';
import { oraEventSchema } from './event.ts';
import { todoSchema } from './todo.ts';

const launchFields = {
  sessionId: sessionIdSchema,
  cwd: z.string().min(1),
  modelScriptPath: z.string().min(1),
  modelInputLogPath: z.string().min(1).optional(),
  configPath: z.string().min(1).optional(),
};

/** 호스트가 워커에 보내는 명령이다 (SPEC 2.6.1절의 createSession, resumeSession, cancel). */
export const workerCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('createSession'),
    ...launchFields,
    task: z.string().min(1),
    permissionMode: permissionModeSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('resumeSession'),
    ...launchFields,
    steer: z.string().min(1).optional(),
  }),
  z.strictObject({ type: z.literal('cancel'), mode: z.enum(['soft', 'hard']) }),
]);
export type WorkerCommand = z.infer<typeof workerCommandSchema>;
export type LaunchCommand = Exclude<WorkerCommand, { type: 'cancel' }>;

/** 워커가 호스트에 보내는 메시지다. 이벤트는 transcript와 같은 스키마를 쓴다. */
export const workerMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('event'), event: oraEventSchema }),
  z.strictObject({
    type: z.literal('result'),
    status: sessionStatusSchema,
    endReason: endReasonSchema,
    summary: z.string(),
    todos: z.array(todoSchema),
  }),
  // 세션을 시작하기 전에 알 수 있는 사용 오류(설정, 모델 스크립트, 재개 불가 상태)다.
  z.strictObject({ type: z.literal('usage_error'), message: z.string() }),
]);
export type WorkerMessage = z.infer<typeof workerMessageSchema>;
