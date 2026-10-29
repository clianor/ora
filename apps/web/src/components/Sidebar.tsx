import {
  CornerDownRight,
  Folder,
  GitBranch,
  History,
  Loader,
  Search,
  Settings,
} from 'lucide-react';
import { cn } from '../lib/cn.ts';
import { hashFor, setPaletteOpen } from '../lib/route.ts';
import { runningStatuses } from '../lib/status.ts';
import type { RepoNode, SidebarData, WorktreeNode } from '../model.ts';
import { DiffStat } from '../ui/stat.tsx';

const stackIndent = 14;

const navRowClass =
  'flex h-8 w-full items-center gap-2 rounded-sm px-2.5 text-[13px] leading-[18px] transition-colors duration-(--duration-fast) ease-(--ease-out)';

function WorktreeRow({
  node,
  depth,
  selectedCwd,
}: {
  node: WorktreeNode;
  depth: number;
  selectedCwd: string | undefined;
}) {
  const cwd = node.cwd ?? node.name;
  const isSelected = selectedCwd === cwd;
  const runningCount = node.sessions.filter((session) =>
    runningStatuses.has(session.record.status),
  ).length;
  const Icon = depth > 0 ? CornerDownRight : GitBranch;
  return (
    <>
      <a
        href={hashFor('worktree', { cwd })}
        title={node.title}
        aria-current={isSelected ? 'page' : undefined}
        style={{ paddingLeft: 20 + stackIndent * depth }}
        className={cn(
          'flex h-7 items-center gap-2 rounded-sm pr-2.5 transition-colors duration-(--duration-fast) ease-(--ease-out)',
          isSelected ? 'bg-surface-hover' : 'hover:bg-surface-hover',
        )}
      >
        <Icon
          aria-hidden
          className={cn(
            'size-[13px] shrink-0',
            isSelected ? 'text-foreground' : 'text-foreground-subtle',
          )}
        />
        <span
          className={cn(
            'min-w-0 flex-1 truncate font-mono text-[13px] leading-[18px]',
            isSelected ? 'font-medium text-foreground' : 'text-foreground-muted',
          )}
        >
          {node.name}
          {node.title && node.title !== node.name && (
            <span className="sr-only"> ({node.title})</span>
          )}
        </span>
        {runningCount > 0 && (
          <span className="flex h-[18px] items-center gap-1 rounded-full bg-surface px-1.5 text-xs leading-4 text-foreground-muted">
            <Loader aria-hidden className="size-3" />
            {runningCount}
            <span className="sr-only">개 세션 실행 중</span>
          </span>
        )}
        {node.add !== undefined && node.del !== undefined && (
          <DiffStat add={node.add} del={node.del} />
        )}
      </a>
      {node.stack.map((child) => (
        <WorktreeRow key={child.name} node={child} depth={depth + 1} selectedCwd={selectedCwd} />
      ))}
    </>
  );
}

function RepoGroup({ repo, selectedCwd }: { repo: RepoNode; selectedCwd: string | undefined }) {
  return (
    <div className="flex flex-col gap-px">
      <div className="flex h-7 items-center gap-2 px-2.5">
        <Folder aria-hidden className="size-3.5 text-foreground-subtle" />
        <span className="text-[13px] leading-[18px] font-medium text-foreground-muted">
          {repo.name}
        </span>
      </div>
      {repo.worktrees.map((node) => (
        <WorktreeRow key={node.name} node={node} depth={0} selectedCwd={selectedCwd} />
      ))}
    </div>
  );
}

interface SidebarProps {
  data: SidebarData;
  /** 탭 화면이 가리키는 워크트리입니다. 이 행을 고른 상태로 그립니다. */
  selectedCwd?: string;
  isHistorySelected?: boolean;
}

/** 기록과 검색 진입점, 저장소 → 워크트리 목록만 보이는 사이드바입니다. 세션은 워크트리 탭 화면과 기록 화면에서 엽니다. */
export function Sidebar({ data, selectedCwd, isHistorySelected = false }: SidebarProps) {
  return (
    <aside className="flex w-[264px] shrink-0 flex-col gap-4 bg-sidebar px-2 pt-4 pb-3">
      <div className="flex flex-col gap-px">
        <a
          href="#/history"
          aria-current={isHistorySelected ? 'page' : undefined}
          className={cn(
            navRowClass,
            isHistorySelected
              ? 'bg-surface-hover text-foreground'
              : 'text-foreground-muted hover:bg-surface-hover',
          )}
        >
          <History aria-hidden className="size-4" />
          <span className="flex-1">기록</span>
          <kbd className="font-sans text-xs text-foreground-subtle">⌘Y</kbd>
        </a>
        <button
          type="button"
          onClick={() => {
            setPaletteOpen(true);
          }}
          className={cn(navRowClass, 'text-foreground-muted hover:bg-surface-hover')}
        >
          <Search aria-hidden className="size-4" />
          <span className="flex-1 text-left">검색</span>
          <kbd className="font-sans text-xs text-foreground-subtle">⌘K</kbd>
        </button>
      </div>
      <h2 className="px-2.5 text-xs leading-4 text-foreground-subtle">워크트리</h2>
      {data.repos.length === 0 ? (
        <p className="px-2.5 text-xs leading-4 text-foreground-subtle">
          아직 워크트리가 없습니다. 세션을 시작하면 작업 폴더가 여기에 나타납니다.
        </p>
      ) : (
        <nav aria-label="워크트리 목록" className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          {data.repos.map((repo) => (
            <RepoGroup key={repo.name} repo={repo} selectedCwd={selectedCwd} />
          ))}
        </nav>
      )}
      <div className="mt-auto flex h-8 items-center gap-2 px-2.5">
        <span aria-hidden className="size-2 rounded-full bg-success" />
        <span className="flex-1 text-[13px] leading-[18px] text-foreground-muted">
          {data.deviceName}
          <span className="sr-only"> 연결됨</span>
        </span>
        <a
          href="#/settings"
          aria-label="설정"
          className="text-foreground-subtle hover:text-foreground"
        >
          <Settings aria-hidden className="size-4" />
        </a>
      </div>
    </aside>
  );
}
