import { useAuiState } from '@assistant-ui/react';
import { GitBranchPlus, TriangleAlert } from 'lucide-react';
import { pendingWorktreeKey, setComposerDraft } from '../lib/composerDraft.ts';
import { setCreateWorktree } from '../lib/route.ts';
import { Button } from '../ui/button.tsx';

/** 입력창에 적던 지시문을 들고 새 worktree 만들기 창을 엽니다. 만든 뒤 새 worktree의 새 세션 입력창에 그 지시문을 채워 둡니다. */
function OpenInNewWorktree({ repo }: { repo: string }) {
  const text = useAuiState((state) => state.composer.text);
  return (
    <Button
      onClick={() => {
        setComposerDraft(pendingWorktreeKey, text);
        setCreateWorktree(repo);
      }}
    >
      <GitBranchPlus aria-hidden className="size-3.5" />새 worktree에서 열기
    </Button>
  );
}

/** 같은 폴더에서 세션이 돌고 있다는 경고 줄입니다. 채팅 입력창을 감싼 `ChatProvider` 안에서 씁니다. */
export function OverwriteNotice({ count, repo }: { count: number; repo: string | undefined }) {
  return (
    <div className="mb-2 flex w-[720px] max-w-[calc(100%-var(--s-6)*2)] items-center gap-2 px-3.5 text-xs leading-4 text-foreground-muted">
      <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-warning" />
      <p className="flex-1">
        같은 폴더에서 세션 {count}개 실행 중 · 파일을 서로 덮어쓸 수 있습니다
      </p>
      {repo !== undefined && <OpenInNewWorktree repo={repo} />}
    </div>
  );
}
