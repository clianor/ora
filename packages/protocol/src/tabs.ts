import { z } from 'zod';
import { sessionIdSchema } from './common.ts';
import { terminalIdSchema } from './terminal.ts';

const tabIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const worktreeTabSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id: tabIdSchema, kind: z.literal('session'), sessionId: sessionIdSchema }),
  z.strictObject({ id: tabIdSchema, kind: z.literal('terminal'), terminalId: terminalIdSchema }),
  z.strictObject({ id: tabIdSchema, kind: z.literal('new') }),
]);
export type WorktreeTab = z.infer<typeof worktreeTabSchema>;

export const worktreeTabsSchema = z
  .strictObject({
    tabs: z.array(worktreeTabSchema).max(100),
    activeTabId: tabIdSchema.optional(),
  })
  .refine(
    (value) =>
      new Set(value.tabs.map((tab) => tab.id)).size === value.tabs.length &&
      (value.activeTabId === undefined || value.tabs.some((tab) => tab.id === value.activeTabId)),
    { message: '탭 ID가 겹치거나 활성 탭이 열린 탭에 없습니다.' },
  );
export type WorktreeTabs = z.infer<typeof worktreeTabsSchema>;

/** 키는 세션 기록의 `repo`와 같은 형식의 워크트리 경로다. */
export const tabsFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  worktrees: z.record(z.string().min(1), worktreeTabsSchema),
});
export type TabsFile = z.infer<typeof tabsFileSchema>;

export const tabsQuerySchema = z.strictObject({ cwd: z.string().min(1) });

export const putTabsBodySchema = z.strictObject({
  cwd: z.string().min(1),
  tabs: worktreeTabsSchema,
});
export type PutTabsBody = z.infer<typeof putTabsBodySchema>;

export const branchResponseSchema = z.strictObject({ branch: z.string().optional() });
export type BranchResponse = z.infer<typeof branchResponseSchema>;

export const tabsResponseSchema = z.strictObject({ tabs: worktreeTabsSchema });
export type TabsResponse = z.infer<typeof tabsResponseSchema>;
