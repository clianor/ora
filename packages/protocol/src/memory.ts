import { z } from 'zod';
import { timestampSchema } from './common.ts';

/** `memory` 이벤트가 남기는 저장 판정이다. `remember`만 저장한 경우이고, 나머지 둘은 기록하지 않았다. */
export const memoryDecisionSchema = z.enum(['remember', 'refuse', 'rejected']);

/** 설정 › 메모리가 메모리 한 항목을 가리키는 범위다. `project`는 현재 프로젝트, `global`은 모든 프로젝트다. */
export const memoryScopeSchema = z.enum(['project', 'global']);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

/** 설정 › 메모리의 항목 한 줄이다. `id`는 지우기 요청에만 쓰고 화면에 보이지 않는다. */
export const memoryItemSchema = z.strictObject({
  id: z.string().min(1),
  text: z.string().min(1),
  scope: memoryScopeSchema,
  /** 저장한 시각이다. 시각을 적지 않은 옛 항목은 저장한 날의 0시다. */
  savedAt: timestampSchema,
  /** 저장한 세션이다. 옛 항목이나 `ora memory` 밖에서 옮긴 항목에는 없다. */
  sessionId: z.string().min(1).optional(),
  /** 저장한 세션의 제목이다. 세션 기록을 읽을 수 없으면 없다. */
  sessionTitle: z.string().optional(),
  /** 이 메모리를 회상 팩에 넣은 횟수다. `usage.jsonl`에서 센다. */
  useCount: z.number().int().nonnegative(),
  lastUsedAt: timestampSchema.optional(),
  /** 출처 없이 저장한 항목이다. 회상할 때 출처 있는 항목보다 낮게 친다. */
  isUnsourced: z.boolean(),
  /** 전체 패스가 오래 안 쓴 항목으로 표시했다. 표시만 하고 아카이브하지 않는다. */
  isStale: z.boolean(),
});
export type MemoryItem = z.infer<typeof memoryItemSchema>;

/** 마지막 전체 패스의 시각과 결과다. 결과 수는 설정 › 메모리의 한 줄 요약이 된다. */
export const memoryPassSummarySchema = z.strictObject({
  at: timestampSchema,
  outcome: z.enum(['ok', 'failed']),
  merged: z.number().int().nonnegative(),
  rewritten: z.number().int().nonnegative(),
  /** 틀리거나 모순이어서 아카이브로 옮긴 항목 수다. 합쳐서 옮긴 항목은 `merged`에 센다. */
  archived: z.number().int().nonnegative(),
  flagged: z.number().int().nonnegative(),
  /** 응답 형식이 두 번 틀려 건드리지 않은 묶음 수다. */
  skippedBatches: z.number().int().nonnegative(),
  /** `failed`일 때 이유다. */
  reason: z.string().optional(),
});
export type MemoryPassSummary = z.infer<typeof memoryPassSummarySchema>;

export const memoryListResponseSchema = z.strictObject({
  projectName: z.string(),
  project: z.array(memoryItemSchema),
  global: z.array(memoryItemSchema),
  /** 사용자가 지운 항목의 ID다. 대화의 저장 줄이 "지웠습니다"를 보이는 데 쓴다. */
  deletedIds: z.array(z.string()),
  /** 전체 패스가 합치거나 모순으로 아카이브한 항목의 ID다. 이 항목의 저장 줄은 지우기 단추를 숨긴다. */
  archivedIds: z.array(z.string()),
  lastPass: memoryPassSummarySchema.optional(),
  /** 전체 패스가 지금 돌고 있다. */
  isTidying: z.boolean(),
});
export type MemoryListResponse = z.infer<typeof memoryListResponseSchema>;

export const memoryDeleteResponseSchema = z.strictObject({ deleted: z.literal(true) });
