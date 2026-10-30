import { z } from 'zod';
import { isolationSchema, permissionModeSchema, sessionIdSchema } from './common.ts';
import {
  approvalDecisionSchema,
  approvalRequestSchema,
  approvalRuleSchema,
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
  /** `<프로바이더>/<모델>[:<추론 강도>]`다. 주면 이 세션의 `default` 체인 맨 앞에 넣는다. */
  model: z.string().min(1).optional(),
});
export type CreateSessionBody = z.infer<typeof createSessionBodySchema>;

/** `GET /api/routing`의 응답이다. 새 세션이 쓸 역할별 모델 체인을 실행 전에 보여 준다. */
export const routingEntrySchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  /** 그 프로바이더에 로그인한 계정이 하나 이상 있는지다. */
  hasAccount: z.boolean(),
});
/** 카탈로그에 있는 모델이다. 새 세션이 체인 밖의 모델을 고를 수 있게 한다. */
export const routingCatalogEntrySchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  hasAccount: z.boolean(),
});
export const routingResponseSchema = z.strictObject({
  roles: z.record(z.string(), z.array(routingEntrySchema)),
  catalog: z.array(routingCatalogEntrySchema),
  fallback: z.strictObject({
    revertPolicy: z.enum(['cooldown-expiry', 'never']),
  }),
});
export type RoutingResponse = z.infer<typeof routingResponseSchema>;

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

/** 사용자가 todo를 포기하거나 포기를 취소한다. 실행 중이면 지금 스텝이 끝난 뒤, 멈춘 세션이면 바로 반영한다. */
export const todoActionBodySchema = z.strictObject({ todoId: z.string().min(1) });
export type TodoActionBody = z.infer<typeof todoActionBodySchema>;

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

/** 포기·포기 취소 응답이다. 실행 중인 세션은 `applied: false`(스텝이 끝난 뒤 반영), 멈춘 세션은 `true`다. */
export const todoActionResponseSchema = z.strictObject({
  ok: z.literal(true),
  applied: z.boolean(),
});
export type TodoActionResponse = z.infer<typeof todoActionResponseSchema>;

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

const modelPricingSchema = z.strictObject({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  cacheReadPerMTok: z.number().nonnegative().optional(),
  cacheWritePerMTok: z.number().nonnegative().optional(),
});

/** 설정 › 비용 상한의 값이다. 금액은 이 화면과 설정 파일에만 있고 세션 기록에는 비율만 남는다 (SPEC 5.4절). `null`은 설정하지 않음이다. */
export const costSettingsSchema = z.strictObject({
  maxCost: z.number().positive().nullable(),
  warnCost: z.number().positive().nullable(),
  /** `<프로바이더>/<모델>` 키마다 100만 토큰당 단가다. */
  pricing: z.record(z.string().min(1), modelPricingSchema),
});
export type CostSettings = z.infer<typeof costSettingsSchema>;

/** 설정 › 일반에서 고를 수 있는 값의 범위다. 저장 API와 화면이 같은 값을 쓴다. */
export const GENERAL_SETTINGS_RANGES = {
  maxSteps: { min: 1, max: 1000 },
  maxRepairsPerTodo: { min: 0, max: 20 },
  noProgressSteps: { min: 1, max: 50 },
  maxConcurrentSessions: { min: 1, max: 16 },
  compactAtRatio: { min: 0.1, max: 0.95 },
} as const;

const rangedInt = (range: { min: number; max: number }) =>
  z.number().int().min(range.min).max(range.max);

/** 설정 › 일반의 값이다. 세션이 시작할 때 읽으므로 바꾼 값은 다음 세션부터 쓴다. */
export const generalSettingsSchema = z.strictObject({
  maxSteps: rangedInt(GENERAL_SETTINGS_RANGES.maxSteps),
  maxRepairsPerTodo: rangedInt(GENERAL_SETTINGS_RANGES.maxRepairsPerTodo),
  noProgressSteps: rangedInt(GENERAL_SETTINGS_RANGES.noProgressSteps),
  maxConcurrentSessions: rangedInt(GENERAL_SETTINGS_RANGES.maxConcurrentSessions),
  isReviewEnabled: z.boolean(),
  compactAtRatio: z
    .number()
    .min(GENERAL_SETTINGS_RANGES.compactAtRatio.min)
    .max(GENERAL_SETTINGS_RANGES.compactAtRatio.max),
  isIdleSummaryEnabled: z.boolean(),
});
export type GeneralSettings = z.infer<typeof generalSettingsSchema>;

/** 체인 항목 `<프로바이더>/<모델>[:<추론 강도>]`다. */
export const chainEntryTextSchema = z
  .string()
  .regex(/^(claude|codex|grok)\/[^:\s]+(:(low|medium|high))?$/, {
    error: '체인 항목은 <claude|codex|grok>/<모델>[:<low|medium|high>] 형식입니다.',
  });

/** 설정 › 모델의 값이다. 비어 있는 역할의 체인은 `default` 체인을 쓴다. */
export const modelSettingsSchema = z.strictObject({
  roles: z.record(z.string().min(1), z.array(chainEntryTextSchema)),
  revertPolicy: z.enum(['cooldown-expiry', 'never']),
});
export type ModelSettings = z.infer<typeof modelSettingsSchema>;

export const toolPolicySchema = z.enum(['allow', 'prompt', 'deny']);

/** 설정 › 권한의 값이다. `restrictedFolders` 안의 쓰기와 실행은 어떤 모드에서도 승인을 묻는다. */
export const permissionSettingsSchema = z.strictObject({
  mode: permissionModeSchema,
  tools: z.record(z.string().min(1), toolPolicySchema),
  restrictedFolders: z.array(z.string().min(1)),
});
export type PermissionSettings = z.infer<typeof permissionSettingsSchema>;

/** 권한 화면이 도구 정책을 더할 때 고르는 도구 이름이다. */
export const permissionSettingsResponseSchema = permissionSettingsSchema.extend({
  availableTools: z.array(z.string()),
});
export type PermissionSettingsResponse = z.infer<typeof permissionSettingsResponseSchema>;

/** 설정 › 격리의 값이다. */
export const isolationSettingsSchema = z.strictObject({ isolation: isolationSchema });
export type IsolationSettings = z.infer<typeof isolationSettingsSchema>;

export const isolationSettingsResponseSchema = isolationSettingsSchema.extend({
  runningSessionCount: z.number().int().nonnegative(),
  /** 엔진이 읽지 않는 홈 디렉터리 아래 폴더 이름이다 (SPEC 5.6절). */
  unreadDirectories: z.array(z.string()),
});
export type IsolationSettingsResponse = z.infer<typeof isolationSettingsResponseSchema>;

/** "항상 승인한 명령" 목록이다. `error`가 있으면 파일을 읽지 못한 것이므로 지울 수 없다. */
export const permissionRulesResponseSchema = z.strictObject({
  rules: z.array(z.strictObject({ key: z.string(), rule: approvalRuleSchema })),
  error: z.string().optional(),
});
export type PermissionRulesResponse = z.infer<typeof permissionRulesResponseSchema>;
