import { z } from 'zod';
import { sessionIdSchema, timestampSchema } from './common.ts';

/** 보드의 레인 다섯 개다. 레인 이름이 곧 에이전트 정의 이름이다 (SPEC 2.16절). */
export const boardLaneSchema = z.enum(['builder', 'verifier', 'reviewer', 'docs', 'qa']);
export type BoardLane = z.infer<typeof boardLaneSchema>;
export const BOARD_LANES = boardLaneSchema.options;

/** 카드가 부모를 가져야 하는 레인이다. 부모는 `builder` 카드여야 한다. */
export const BOARD_CHILD_LANES: readonly BoardLane[] = ['verifier', 'reviewer'];

export const boardCardSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().max(10_000),
  lane: boardLaneSchema,
  writeScope: z.array(z.string().min(1)),
  verifyCommand: z.string().min(1).optional(),
  parentId: z.string().min(1).optional(),
  /** 시작할 때마다 덧붙인다. 마지막 항목이 카드 상태를 정한다. */
  sessionIds: z.array(sessionIdSchema),
  createdAt: timestampSchema,
});
export type BoardCard = z.infer<typeof boardCardSchema>;

/** `<Ora 홈>/boards/<저장소 키>.json`의 내용이다. */
export const boardFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  cards: z.array(boardCardSchema),
});
export type BoardFile = z.infer<typeof boardFileSchema>;

export const boardCardStatusSchema = z.enum([
  'not_started',
  'running',
  'awaiting_approval',
  'done',
  'failed',
]);
export type BoardCardStatus = z.infer<typeof boardCardStatusSchema>;

/** 화면이 그리는 카드다. 상태와 부모 표시는 서버가 마지막 세션과 부모 카드에서 계산한다. */
export const boardCardViewSchema = boardCardSchema.extend({
  status: boardCardStatusSchema,
  /** 마지막 세션이 열린 워크트리 경로다. */
  lastWorktree: z.string().optional(),
  lastStartedAt: timestampSchema.optional(),
  /** 부모 카드의 제목이다. 부모가 있었는데 지웠으면 `parentDeleted`가 참이다. */
  parentTitle: z.string().optional(),
  parentDeleted: z.boolean(),
  lastWorktreeName: z.string().optional(),
  lastUpdatedAt: timestampSchema.optional(),
  /** 있으면 "시작"을 끄고 이 이유를 보인다. */
  startBlockedReason: z.string().optional(),
  /** 있으면 레인과 부모를 바꿀 수 없다. */
  isLocked: z.boolean(),
});
export type BoardCardView = z.infer<typeof boardCardViewSchema>;

export const boardResponseSchema = z.strictObject({
  /** 저장소 이름이다(저장소 폴더의 마지막 이름). */
  repoName: z.string(),
  /** 보드가 가리키는 저장소 루트의 실제 경로다. */
  repo: z.string(),
  cards: z.array(boardCardViewSchema),
});
export type BoardResponse = z.infer<typeof boardResponseSchema>;

const cardFields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000),
  lane: boardLaneSchema,
  writeScope: z.array(z.string().trim().min(1)),
  verifyCommand: z.string().trim().min(1).optional(),
  parentId: z.string().min(1).optional(),
};

export const createBoardCardBodySchema = z.strictObject({
  repo: z.string().min(1),
  ...cardFields,
  description: cardFields.description.default(''),
  writeScope: cardFields.writeScope.default([]),
});
export type CreateBoardCardBody = z.infer<typeof createBoardCardBodySchema>;

/** 보내지 않은 필드는 그대로 둔다. `verifyCommand`·`parentId`를 `null`로 보내면 지운다. */
export const updateBoardCardBodySchema = z.strictObject({
  repo: z.string().min(1),
  title: cardFields.title.optional(),
  description: cardFields.description.optional(),
  lane: boardLaneSchema.optional(),
  writeScope: cardFields.writeScope.optional(),
  verifyCommand: cardFields.verifyCommand.nullable().optional(),
  parentId: cardFields.parentId.nullable().optional(),
});
export type UpdateBoardCardBody = z.infer<typeof updateBoardCardBodySchema>;

export const startBoardCardBodySchema = z.strictObject({
  repo: z.string().min(1),
  worktree: z.string().min(1),
});
export type StartBoardCardBody = z.infer<typeof startBoardCardBodySchema>;

export const boardCardResponseSchema = z.strictObject({ card: boardCardViewSchema });
export type BoardCardResponse = z.infer<typeof boardCardResponseSchema>;

export const startBoardCardResponseSchema = z.strictObject({
  card: boardCardViewSchema,
  sessionId: sessionIdSchema,
});
export type StartBoardCardResponse = z.infer<typeof startBoardCardResponseSchema>;

/** 시작 팝오버의 워크트리 한 줄이다. */
export const boardWorktreeSchema = z.strictObject({
  path: z.string().min(1),
  branch: z.string().optional(),
  isMain: z.boolean(),
  runningSessions: z.number().int().nonnegative(),
  awaitingApprovalSessions: z.number().int().nonnegative(),
});
export type BoardWorktree = z.infer<typeof boardWorktreeSchema>;

export const boardWorktreesResponseSchema = z.strictObject({
  worktrees: z.array(boardWorktreeSchema),
});
export type BoardWorktreesResponse = z.infer<typeof boardWorktreesResponseSchema>;
