import { z } from 'zod';
import { cleanupProcessSchema } from './ports.ts';
import { timestampSchema } from './common.ts';

/** PR 상태와 머지된 worktree 삭제의 HTTP API 본문이다 (SPEC 2.12절). */

export const prStateSchema = z.enum(['OPEN', 'DRAFT', 'MERGED', 'CLOSED']);
export type PrState = z.infer<typeof prStateSchema>;

/** 검사 결과 요약이다. `none`은 검사가 없거나 아직 시작하지 않았다는 뜻이다. */
export const prChecksSchema = z.enum(['pass', 'fail', 'running', 'none']);
export type PrChecks = z.infer<typeof prChecksSchema>;

export const prInfoSchema = z.strictObject({
  number: z.number().int().positive(),
  url: z.string().min(1),
  state: prStateSchema,
  checks: prChecksSchema,
  /** PR의 마지막 커밋이다. 머지 뒤 새 커밋을 가리는 기준이다. */
  headRefOid: z.string().min(1),
  createdAt: timestampSchema,
  mergedAt: timestampSchema.optional(),
  closedAt: timestampSchema.optional(),
});
export type PrInfo = z.infer<typeof prInfoSchema>;

/** 디폴트 브랜치가 원격보다 뒤처진·앞선 커밋 수다. */
export const defaultBranchSyncSchema = z.strictObject({
  behind: z.number().int().nonnegative(),
  ahead: z.number().int().nonnegative(),
});
export type DefaultBranchSync = z.infer<typeof defaultBranchSyncSchema>;

export const worktreePrEntrySchema = z.strictObject({
  /** worktree 폴더(realpath)다. */
  path: z.string().min(1),
  /** detached HEAD면 없다. */
  branch: z.string().min(1).optional(),
  /** 저장소 본체 폴더다. 삭제 대상이 아니다. */
  isMain: z.boolean(),
  /** 디폴트 브랜치 worktree다. PR 대신 `sync`를 보인다. */
  isDefault: z.boolean(),
  /** 브랜치를 head로 하는 같은 저장소의 가장 최근 PR이다. */
  pr: prInfoSchema.optional(),
  sync: defaultBranchSyncSchema.optional(),
  /** PR이 없을 때 GitHub 비교 화면 주소다. 원격이 GitHub가 아니면 없다. */
  createUrl: z.string().min(1).optional(),
});
export type WorktreePrEntry = z.infer<typeof worktreePrEntrySchema>;

/**
 * 저장소 하나의 PR 상태다. `gh`를 쓸 수 없으면 `unavailable`에 이유 한 줄이 있고 PR은 비어 있다.
 * `version`은 호스트가 새로 읽을 때마다 늘어난다.
 */
export const prStatusResponseSchema = z.strictObject({
  repo: z.string().min(1),
  version: z.number().int().nonnegative(),
  unavailable: z.string().min(1).optional(),
  worktrees: z.array(worktreePrEntrySchema),
});
export type PrStatusResponse = z.infer<typeof prStatusResponseSchema>;

/** `read`는 호스트가 갱신 시점을 정하고, `focus`는 지금 조건부로 확인하며, `force`는 전부 새로 읽는다. */
export const prStatusRefreshSchema = z.enum(['read', 'focus', 'force']);
export type PrStatusRefresh = z.infer<typeof prStatusRefreshSchema>;

export const cleanupGroupSchema = z.enum(['merged', 'closed']);
export type CleanupGroup = z.infer<typeof cleanupGroupSchema>;

export const cleanupCandidateSchema = z.strictObject({
  path: z.string().min(1),
  branch: z.string().min(1),
  group: cleanupGroupSchema,
  number: z.number().int().positive(),
  url: z.string().min(1),
  /** `Merged`는 머지한 시각, `Closed`는 닫은 시각이다. */
  at: timestampSchema.optional(),
  /** 닫은 PR에서 이 브랜치의 커밋이 원격 어딘가에 남아 있는지다. */
  isOnRemote: z.boolean(),
  /** 삭제하면 먼저 종료하는 Ora 터미널·세션의 프로세스다. */
  processes: z.array(cleanupProcessSchema),
  /** 고를 수 없게 막는 이유다. 없으면 고를 수 있다. */
  blocked: z.string().min(1).optional(),
});
export type CleanupCandidate = z.infer<typeof cleanupCandidateSchema>;

export const cleanupListResponseSchema = z.strictObject({
  repo: z.string().min(1),
  candidates: z.array(cleanupCandidateSchema),
});
export type CleanupListResponse = z.infer<typeof cleanupListResponseSchema>;

export const cleanupBodySchema = z.strictObject({
  /** 저장소의 아무 worktree 폴더다. */
  repo: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
});
export type CleanupBody = z.infer<typeof cleanupBodySchema>;

export const cleanupResultSchema = z.strictObject({
  removed: z.array(z.string()),
  failed: z.array(z.strictObject({ path: z.string(), reason: z.string() })),
});
export type CleanupResult = z.infer<typeof cleanupResultSchema>;
