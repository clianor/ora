import type { SessionStatus } from '@ora/protocol';
import {
  CornerDownRight,
  FolderGit2,
  GitBranch,
  History,
  Loader,
  MessageCircleQuestion,
  Search,
  Settings,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../lib/cn.ts';
import { formatShortElapsed, useNow } from '../lib/now.ts';
import { hashFor, setPaletteOpen } from '../lib/route.ts';
import { runningStatuses, statusLabel } from '../lib/status.ts';
import type { RepoNode, SidebarData, WorktreeNode } from '../model.ts';
import { useStore } from '../store.tsx';

const stackIndent = 14;

const navRowClass =
  'flex h-8 w-full items-center gap-2 rounded-sm px-2.5 text-[13px] leading-[18px] transition-colors duration-(--duration-fast) ease-(--ease-out)';

/** 모양이 서로 다른 아이콘이라 색 없이도 상태를 구분합니다. 글자 이름도 함께 붙입니다. */
const sessionIcons: Partial<Record<SessionStatus, { Icon: LucideIcon; color: string }>> = {
  created: { Icon: Loader, color: 'text-foreground-muted' },
  running: { Icon: Loader, color: 'text-foreground-muted' },
  awaiting_approval: { Icon: ShieldAlert, color: 'text-warning' },
  awaiting_user: { Icon: MessageCircleQuestion, color: 'text-warning' },
};

function WorktreeRow({
  node,
  depth,
  selectedCwd,
  now,
}: {
  node: WorktreeNode;
  depth: number;
  selectedCwd: string | undefined;
  now: number;
}) {
  const { getBranch, getDefaultBranch } = useStore();
  const cwd = node.cwd ?? node.name;
  const isSelected = selectedCwd === cwd;
  const branch = getBranch(cwd);
  const isDefault = branch !== undefined && branch === getDefaultBranch(cwd);
  const active = node.sessions.filter((session) => runningStatuses.has(session.record.status));
  const Icon = depth > 0 ? CornerDownRight : GitBranch;
  const row = (
    <a
      href={hashFor('worktree', { cwd })}
      title={node.title}
      aria-current={isSelected ? 'page' : undefined}
      style={{ paddingLeft: 10 + stackIndent * depth }}
      className={cn(
        'flex h-8 items-center gap-2 rounded-sm pr-2.5 transition-colors duration-(--duration-fast) ease-(--ease-out)',
        !isSelected && 'hover:bg-surface-hover',
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          'size-3.5 shrink-0',
          isSelected ? 'text-foreground' : 'text-foreground-subtle',
        )}
      />
      <span
        className={cn(
          'min-w-0 truncate text-[13px] leading-[18px]',
          isSelected ? 'font-medium text-foreground' : 'text-foreground-muted',
        )}
      >
        {branch ?? node.name}
        {node.title && node.title !== node.name && <span className="sr-only"> ({node.title})</span>}
      </span>
      {isDefault && (
        <span className="rounded-[5px] bg-surface-hover px-1.5 text-[11px] leading-[18px] font-medium text-foreground-muted">
          기본
        </span>
      )}
      {!isSelected && active.length > 0 && (
        <span className="ml-auto text-xs leading-4 font-medium text-foreground-muted">
          실행 {active.length}
        </span>
      )}
    </a>
  );
  return (
    <>
      {isSelected ? (
        <div className="flex flex-col rounded-md border border-border-strong bg-surface pb-1">
          {row}
          {active.map((session) => {
            const { Icon: StatusIcon, color } = sessionIcons[session.record.status] ?? {
              Icon: Loader,
              color: 'text-foreground-muted',
            };
            return (
              <a
                key={session.record.id}
                href={hashFor('worktree', { sessionId: session.record.id })}
                className="flex h-[30px] items-center gap-2 rounded-sm pr-2.5 pl-7 hover:bg-surface-hover"
              >
                <StatusIcon
                  role="img"
                  aria-label={statusLabel[session.record.status]}
                  className={cn('size-3.5 shrink-0', color)}
                />
                <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] text-foreground">
                  {session.record.title}
                </span>
                <span className="text-xs leading-4 text-foreground-subtle">
                  {formatShortElapsed(session.record.createdAt, now)}
                </span>
              </a>
            );
          })}
        </div>
      ) : (
        row
      )}
      {node.stack.map((child) => (
        <WorktreeRow
          key={child.name}
          node={child}
          depth={depth + 1}
          selectedCwd={selectedCwd}
          now={now}
        />
      ))}
    </>
  );
}

function RepoGroup({
  repo,
  selectedCwd,
  now,
}: {
  repo: RepoNode;
  selectedCwd: string | undefined;
  now: number;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex h-8 items-center gap-2 px-2.5">
        <FolderGit2 aria-hidden className="size-3.5 text-foreground-muted" />
        <span className="text-[13px] leading-[18px] font-semibold text-foreground">
          {repo.name}
        </span>
      </div>
      {repo.worktrees.map((node) => (
        <WorktreeRow key={node.name} node={node} depth={0} selectedCwd={selectedCwd} now={now} />
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

/** 검색칸과 기록, 저장소 → 워크트리 목록이 있는 사이드바입니다. 고른 워크트리는 카드로 묶어 진행 중인 세션을 보입니다. */
export function Sidebar({ data, selectedCwd, isHistorySelected = false }: SidebarProps) {
  const now = useNow();
  return (
    <aside className="flex w-[264px] shrink-0 flex-col gap-4 border-r border-border bg-sidebar px-2 pt-3 pb-3">
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => {
            setPaletteOpen(true);
          }}
          className="flex h-[34px] w-full items-center gap-2 rounded-md bg-surface px-2.5 text-[13px] leading-[18px] text-foreground-subtle hover:bg-surface-hover"
        >
          <Search aria-hidden className="size-4" />
          <span className="flex-1 text-left">세션, 워크트리 검색</span>
          <kbd className="rounded-[5px] bg-kbd px-1.5 font-sans text-xs leading-5 font-medium text-foreground-muted">
            ⌘K
          </kbd>
        </button>
        <a
          href="#/history"
          aria-current={isHistorySelected ? 'page' : undefined}
          className={cn(
            navRowClass,
            'h-[34px]',
            isHistorySelected
              ? 'bg-surface-hover text-foreground'
              : 'text-foreground-muted hover:bg-surface-hover',
          )}
        >
          <History aria-hidden className="size-4" />
          <span className="flex-1">기록</span>
          <kbd className="font-sans text-xs text-foreground-subtle">⌘Y</kbd>
        </a>
      </div>
      <h2 className="px-2.5 text-xs leading-4 font-medium text-foreground-subtle">워크트리</h2>
      {data.repos.length === 0 ? (
        <p className="px-2.5 text-xs leading-4 text-foreground-subtle">
          아직 워크트리가 없습니다. 세션을 시작하면 작업 폴더가 여기에 나타납니다.
        </p>
      ) : (
        <nav aria-label="워크트리 목록" className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          {data.repos.map((repo) => (
            <RepoGroup key={repo.name} repo={repo} selectedCwd={selectedCwd} now={now} />
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
          href={
            selectedCwd === undefined
              ? '#/settings'
              : `#/settings?cwd=${encodeURIComponent(selectedCwd)}`
          }
          aria-label="설정"
          className="text-foreground-subtle hover:text-foreground"
        >
          <Settings aria-hidden className="size-4" />
        </a>
      </div>
    </aside>
  );
}
