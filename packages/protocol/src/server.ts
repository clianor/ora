import { z } from 'zod';
import { isolationSchema, permissionModeSchema, sessionIdSchema } from './common.ts';
import {
  approvalDecisionSchema,
  approvalRequestSchema,
  questionAnswerSchema,
  questionRequestSchema,
} from './interaction.ts';
import { sessionRecordSchema } from './session.ts';
import { todoSchema } from './todo.ts';

/** 로컬 서버의 HTTP API 요청·응답 본문이다 (SPEC 2.6.1절, 2.6.2절). 웹은 이 스키마만 import한다. */

export const createSessionBodySchema = z.strictObject({
  task: z.string().min(1),
  cwd: z.string().min(1).optional(),
  permissionMode: permissionModeSchema.optional(),
});
export type CreateSessionBody = z.infer<typeof createSessionBodySchema>;

export const resumeSessionBodySchema = z.strictObject({ steer: z.string().min(1).optional() });
export type ResumeSessionBody = z.infer<typeof resumeSessionBodySchema>;

export const cancelBodySchema = z.strictObject({ mode: z.enum(['soft', 'hard']) });
export type CancelBody = z.infer<typeof cancelBodySchema>;

export const approvalBodySchema = z.strictObject({
  requestId: z.string().min(1),
  decision: approvalDecisionSchema,
});
export type ApprovalBody = z.infer<typeof approvalBodySchema>;

export const answerBodySchema = z.strictObject({
  requestId: z.string().min(1),
  answers: z.array(questionAnswerSchema).min(1).max(4),
});
export type AnswerBody = z.infer<typeof answerBodySchema>;

/** 조향 메시지다. 실행 중이면 소프트 스톱 뒤에, 멈춘 세션이면 바로 같은 세션을 이어 간다. */
export const messageBodySchema = z.strictObject({ text: z.string().min(1) });
export type MessageBody = z.infer<typeof messageBodySchema>;

export const pendingApprovalSchema = z.strictObject({
  requestId: z.string().min(1),
  request: approvalRequestSchema,
});
export type PendingApproval = z.infer<typeof pendingApprovalSchema>;

export const pendingQuestionSchema = z.strictObject({
  requestId: z.string().min(1),
  request: questionRequestSchema,
});
export type PendingQuestion = z.infer<typeof pendingQuestionSchema>;

export const sessionListResponseSchema = z.strictObject({ sessions: z.array(sessionRecordSchema) });
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;

export const sessionIdResponseSchema = z.strictObject({ sessionId: sessionIdSchema });
export type SessionIdResponse = z.infer<typeof sessionIdResponseSchema>;

/** `live`는 이 서버가 띄운 워커가 지금 돌고 있다는 뜻이다. 다른 프로세스가 띄운 세션은 항상 false다. */
export const sessionDetailResponseSchema = z.strictObject({
  session: sessionRecordSchema,
  todos: z.array(todoSchema),
  live: z.boolean(),
  /** 이 서버 설정의 최대 스텝 수다. session.json에는 없는 값이라 여기서 알려 준다. */
  maxSteps: z.number().int().positive(),
  /** 세션 모델의 컨텍스트 창 크기(토큰)다. 모르면 없다. */
  contextWindow: z.number().int().positive().optional(),
  /** 입력이 창 × 이 값에 닿으면 압축한다 (`context.compactAtRatio`). */
  compactAtRatio: z.number().gt(0).lte(1),
  /** 압축해도 원문으로 남기는 최근 토큰 수다 (`context.keepRecentTokens`). */
  keepRecentTokens: z.number().int().positive(),
  pendingApprovals: z.array(pendingApprovalSchema),
  pendingQuestions: z.array(pendingQuestionSchema),
});
export type SessionDetailResponse = z.infer<typeof sessionDetailResponseSchema>;

/** `GET /api/sessions/:id/compaction?path=`의 응답이다. 압축 요약 파일 본문이다. */
export const compactionFileResponseSchema = z.strictObject({ text: z.string() });
export type CompactionFileResponse = z.infer<typeof compactionFileResponseSchema>;

export const okResponseSchema = z.strictObject({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof okResponseSchema>;

export const errorResponseSchema = z.strictObject({ error: z.string() });
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/**
 * SSE 이벤트 스트림 `GET /api/sessions/:id/events`의 이름 붙은 이벤트다.
 * 이름 없는 `message` 이벤트의 `data`는 transcript 이벤트(`oraEventSchema`)다.
 */
export const sseEventNames = {
  approvalRequest: 'approval_request',
  questionRequest: 'question_request',
  requestResolved: 'request_resolved',
  steerFailed: 'steer_failed',
} as const;

export const requestResolvedSchema = z.strictObject({ requestId: z.string().min(1) });
export type RequestResolved = z.infer<typeof requestResolvedSchema>;

/** 조향 메시지로 세션을 잇지 못했을 때 보낸다. `texts`는 전달하지 못한 메시지라서 클라이언트가 다시 보낼 수 있다. */
export const steerFailedSchema = z.strictObject({
  error: z.string(),
  texts: z.array(z.string().min(1)),
});
export type SteerFailed = z.infer<typeof steerFailedSchema>;

/** 새 세션 화면이 보여 줄 서버 기본값이다. `branch`는 `cwd`가 git 저장소이고 브랜치 위에 있을 때만 있다. */
export const infoResponseSchema = z.strictObject({
  cwd: z.string(),
  branch: z.string().optional(),
  /** 새 세션이 받을 권한 모드다. 설정 파일 값이고, 설정 파일이 없으면 `always-ask`다. */
  permissionMode: permissionModeSchema,
  isolation: isolationSchema,
  maxSteps: z.number().int().positive(),
});
export type InfoResponse = z.infer<typeof infoResponseSchema>;
