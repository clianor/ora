import type { RepoNode, WorktreeNode } from '../model.ts';

export interface WorktreeRef {
  repo: RepoNode;
  node: WorktreeNode;
  /** 탭 저장소의 키입니다. 세션 기록의 `repo` 경로와 같은 형식입니다. */
  cwd: string;
}

function collect(repo: RepoNode, nodes: WorktreeNode[]): WorktreeRef[] {
  return nodes.flatMap((node) => [
    { repo, node, cwd: node.cwd ?? node.name },
    ...collect(repo, node.stack),
  ]);
}

/** 쌓인 워크트리까지 펼친 모든 워크트리입니다. */
export function listWorktrees(repos: readonly RepoNode[]): WorktreeRef[] {
  return repos.flatMap((repo) => collect(repo, repo.worktrees));
}

export function findWorktreeOfSession(
  repos: readonly RepoNode[],
  sessionId: string,
): WorktreeRef | undefined {
  return listWorktrees(repos).find((ref) =>
    ref.node.sessions.some((session) => session.record.id === sessionId),
  );
}
