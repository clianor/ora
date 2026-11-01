import { z } from 'zod';
import { sessionIdSchema, timestampSchema } from './common.ts';

/** 그래프 노드 ID다. todo ID로도 쓰므로 짧은 영숫자로 제한한다. */
export const graphNodeIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,19}$/);

/** `graph.plan`이 받아들인 노드 하나다. `content`는 화면에 보이는 할 일 문장이고, 부모 todo의 내용은 `<id> · <content>`다. */
export const graphNodeSpecSchema = z.strictObject({
  id: graphNodeIdSchema,
  intent: z.string().min(1).max(200),
  content: z.string().min(1).max(200),
  /** 비어 있으면 읽기 전용 노드다. */
  writeScope: z.array(z.string()),
  agent: z.string().min(1),
  verifyCommand: z.string().min(1),
  /** 앞선 노드 ID다. 이 노드들이 모두 `verified`여야 시작한다. */
  after: z.array(graphNodeIdSchema),
});
export type GraphNodeSpec = z.infer<typeof graphNodeSpecSchema>;

/** 화면이 그리는 노드 상태다. "다시 시도 중"은 `running`이면서 `attempt`가 2 이상인 경우다. */
export const graphNodeStateSchema = z.enum([
  'queued',
  'running',
  'verifying',
  'verified',
  'failed',
  'blocked',
]);
export type GraphNodeState = z.infer<typeof graphNodeStateSchema>;

/** 노드마다 다시 시도할 수 있는 최대 횟수다. 시도 번호는 최대 `1 + 이 값`이다. */
export const MAX_GRAPH_NODE_RETRIES = 3;

/** 엔진이 직접 돌린 검증 증거 요약이다. 하위 세션이 낸 증거는 담지 않는다. */
export const graphEvidenceSchema = z.strictObject({
  command: z.string().min(1),
  exitCode: z.number().int().optional(),
  summary: z.string(),
  ranAt: timestampSchema,
  scopeDigest: z.string().regex(/^sha256:[0-9a-f]+$/),
  outputRef: z.string().min(1).optional(),
  gateFindings: z.array(z.string()).optional(),
});
export type GraphEvidence = z.infer<typeof graphEvidenceSchema>;

export const graphPlanPayloadSchema = z.strictObject({
  callId: z.string().min(1),
  nodes: z.array(graphNodeSpecSchema).min(1),
});

export const graphRunPayloadSchema = z.strictObject({
  /** 실행마다 다른 값이다. 첫 실행은 그래프 호출 ID이고, 다시 돌릴 때마다 `#2`, `#3`을 붙인다. */
  runId: z.string().min(1),
  callId: z.string().min(1),
  /** 이 실행을 시작할 때의 HEAD다. git 저장소가 아니면 `null`이다. */
  baseCommit: z.string().min(1).nullable(),
  isRerun: z.boolean(),
});

export const graphNodePayloadSchema = z.strictObject({
  runId: z.string().min(1),
  nodeId: graphNodeIdSchema,
  state: graphNodeStateSchema,
  /** 이 노드의 시도 번호다. 시작 전(`queued`)과 앞선 노드의 실패로 `blocked`가 된 노드는 0이다. */
  attempt: z.number().int().nonnegative(),
  childSessionId: sessionIdSchema.optional(),
  /** `failed`와 다시 시도 직전에 붙는 진단이다. 2,000바이트·20줄 이내이고 원시 프롬프트나 transcript를 담지 않는다. */
  diagnostic: z.string().optional(),
  /** `blocked`일 때 앞선 노드가 실패했다는 사유다. */
  reason: z.string().optional(),
});

/** 시도 하나의 계보 기록이다. 신원은 엔진이 가진 값만 쓰고 실행자가 주장한 값은 쓰지 않는다. */
export const nodeLineagePayloadSchema = z.strictObject({
  runId: z.string().min(1),
  nodeId: graphNodeIdSchema,
  attempt: z.number().int().positive(),
  childSessionId: sessionIdSchema,
  baseCommit: z.string().min(1).nullable(),
  verdict: z.enum(['passed', 'failed']),
  evidence: graphEvidenceSchema,
});

export const graphEndPayloadSchema = z.strictObject({
  runId: z.string().min(1),
  status: z.enum(['verified', 'failed']),
  baseCommit: z.string().min(1).nullable(),
  nodes: z.array(
    z.strictObject({
      id: graphNodeIdSchema,
      state: graphNodeStateSchema,
      attempts: z.number().int().nonnegative(),
    }),
  ),
  attempts: z.number().int().nonnegative(),
  changedFiles: z.array(z.string()),
  added: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
});
