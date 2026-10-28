import type { SessionStatus } from '@ora/protocol';
import {
  CornerDownRight,
  Folder,
  GitBranch,
  MessageSquare,
  Plus,
  Search,
  Settings,
  SquarePen,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/cn.ts';
import { hashFor } from '../lib/route.ts';
import { statusLabel } from '../lib/status.ts';
import type { RepoNode, SessionNode, SidebarData, WorktreeNode } from '../model.ts';
import { DiffStat } from '../ui/stat.tsx';

const stackIndent = 14;

const filters = ['전체', '실행 중', '답변 대기', '승인 대기', '실패', '완료'] as const;
type Filter = (typeof filters)[number];

const filterOfStatus: Partial<Record<SessionStatus, Filter>> = {
  running: '실행 중',
  awaiting_user: '답변 대기',
  awaiting_approval: '승인 대기',
  failed: '실패',
  completed: '완료',
};

const dotColor: Partial<Record<SessionStatus, string>> = {
  completed: 'bg-success',
  merged: 'bg-success',
  failed: 'bg-danger',
  awaiting_approval: 'bg-warning',
  awaiting_user: 'bg-warning',
  interrupted: 'bg-warning',
  crashed: 'bg-warning',
};

type MatchKind = 'title' | 'todo' | null;

function matchSession(session: SessionNode, query: string, filter: Filter): MatchKind | false {
  if (filter !== '전체' && filterOfStatus[session.record.status] !== filter) return false;
  const needle = query.trim().toLowerCase();
  if (needle === '') return null;
  if (session.record.title.toLowerCase().includes(needle)) return 'title';
  if (session.todoTitles.some((title) => title.toLowerCase().includes(needle))) return 'todo';
  return false;
}

interface SessionEntry {
  node: SessionNode;
  match: MatchKind;
}

interface WorktreeEntry {
  node: WorktreeNode;
  sessions: SessionEntry[];
  stack: WorktreeEntry[];
}

/** 검색어와 상태 필터에 맞는 세션만 남깁니다. 조건이 없으면 모든 워크트리를 그대로 둡니다. */
function filterWorktrees(
  worktrees: WorktreeNode[],
  query: string,
  filter: Filter,
  isFiltering: boolean,
): WorktreeEntry[] {
  return worktrees.flatMap((node) => {
    const sessions = node.sessions.flatMap((session) => {
      const match = matchSession(session, query, filter);
      return match === false ? [] : [{ node: session, match }];
    });
    const stack = filterWorktrees(node.stack, query, filter, isFiltering);
    if (isFiltering && sessions.length === 0 && stack.length === 0) return [];
    return [{ node, sessions, stack }];
  });
}

function countSessions(entries: WorktreeEntry[]): number {
  return entries.reduce(
    (sum, entry) => sum + entry.sessions.length + countSessions(entry.stack),
    0,
  );
}

const matchLabel: Record<'title' | 'todo', string> = { title: '제목 일치', todo: '할 일 일치' };

function SessionRow({
  entry,
  depth,
  isSelected,
}: {
  entry: SessionEntry;
  depth: number;
  isSelected: boolean;
}) {
  const { node, match } = entry;
  const dot = dotColor[node.record.status];
  return (
    <a
      href={hashFor('session', { sessionId: node.record.id })}
      aria-current={isSelected ? 'page' : undefined}
      style={{ paddingLeft: 42 + stackIndent * depth }}
      className={cn(
        'flex flex-col gap-0.5 rounded-sm py-1.5 pr-2.5 transition-colors duration-(--duration-fast) ease-(--ease-out)',
        isSelected ? 'bg-surface-hover' : 'hover:bg-surface-hover',
      )}
    >
      <span className="flex items-center gap-1.5">
        {dot && <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', dot)} />}
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[13px] leading-[18px]',
            isSelected ? 'font-medium text-foreground' : 'text-foreground-muted',
          )}
        >
          {node.record.title}
        </span>
      </span>
      <span className="text-xs leading-4 text-foreground-subtle">
        {[statusLabel[node.record.status], node.detail, match && matchLabel[match]]
          .filter(Boolean)
          .join(', ')}
      </span>
    </a>
  );
}

/** 워크트리를 고르면 그 워크트리의 새 세션 화면이 열립니다. 변경 통계는 세션이 아니라 워크트리에 붙습니다. */
function WorktreeTree({
  entry,
  repo,
  depth,
  selectedCwd,
  selectedSessionId,
}: {
  entry: WorktreeEntry;
  repo: string;
  depth: number;
  selectedCwd: string | undefined;
  selectedSessionId: string | undefined;
}) {
  const { node } = entry;
  const isSelected = selectedCwd !== undefined && selectedCwd === node.cwd;
  const Icon = depth > 0 ? CornerDownRight : GitBranch;
  return (
    <>
      <a
        href={hashFor('new', { cwd: node.cwd })}
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
        </span>
        {node.add !== undefined && node.del !== undefined && (
          <DiffStat add={node.add} del={node.del} />
        )}
        {isSelected && <Plus aria-hidden className="size-3.5 text-foreground-muted" />}
      </a>
      {entry.sessions.map((session) => (
        <SessionRow
          key={session.node.record.id}
          entry={session}
          depth={depth}
          isSelected={session.node.record.id === selectedSessionId}
        />
      ))}
      {entry.stack.map((child) => (
        <WorktreeTree
          key={child.node.name}
          entry={child}
          repo={repo}
          depth={depth + 1}
          selectedCwd={selectedCwd}
          selectedSessionId={selectedSessionId}
        />
      ))}
    </>
  );
}

function RepoGroup({
  repo,
  worktrees,
  selectedCwd,
  selectedSessionId,
}: {
  repo: RepoNode;
  worktrees: WorktreeEntry[];
  selectedCwd: string | undefined;
  selectedSessionId: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-px">
      <div className="flex h-7 items-center gap-2 px-2.5">
        <Folder aria-hidden className="size-3.5 text-foreground-subtle" />
        <span className="text-[13px] leading-[18px] font-medium text-foreground-muted">
          {repo.name}
        </span>
      </div>
      {worktrees.map((entry) => (
        <WorktreeTree
          key={entry.node.name}
          entry={entry}
          repo={repo.name}
          depth={0}
          selectedCwd={selectedCwd}
          selectedSessionId={selectedSessionId}
        />
      ))}
    </div>
  );
}

interface SidebarProps {
  data: SidebarData;
  /** 새 세션 화면이 가리키는 작업 폴더입니다. 이 폴더의 워크트리 행을 고른 상태로 그립니다. */
  selectedCwd?: string;
  selectedSessionId?: string;
  initialQuery?: string;
}

/** 저장소, 워크트리, 세션 3단 사이드바입니다(SPEC 8.2절). */
export function Sidebar({ data, selectedCwd, selectedSessionId, initialQuery }: SidebarProps) {
  const [isSearchOpen, setIsSearchOpen] = useState(initialQuery !== undefined);
  const [query, setQuery] = useState(initialQuery ?? '');
  const [filter, setFilter] = useState<Filter>('전체');

  const isFiltering = isSearchOpen && (query.trim() !== '' || filter !== '전체');
  const groups = data.repos
    .map((repo) => ({
      repo,
      worktrees: filterWorktrees(
        repo.worktrees,
        isSearchOpen ? query : '',
        isSearchOpen ? filter : '전체',
        isFiltering,
      ),
    }))
    .filter((group) => !isFiltering || group.worktrees.length > 0);
  const found = groups.reduce((sum, group) => sum + countSessions(group.worktrees), 0);

  return (
    <aside className="flex w-[264px] shrink-0 flex-col gap-4 bg-sidebar px-2 pt-4 pb-3">
      <div className="flex h-5 items-center justify-end px-2.5">
        <a
          href="#/new"
          aria-label="새 세션"
          className="rounded-sm text-foreground-muted hover:text-foreground"
        >
          <SquarePen aria-hidden className="size-4" />
        </a>
      </div>
      <div className="flex items-center gap-2 px-2.5 pt-1.5">
        <MessageSquare aria-hidden className="size-[15px] text-foreground-muted" />
        <h2 className="flex-1 text-[13px] leading-[18px] font-medium text-foreground-muted">
          세션
        </h2>
        {!isSearchOpen && (
          <button
            type="button"
            aria-label="세션 검색"
            onClick={() => {
              setIsSearchOpen(true);
            }}
            className="rounded-sm text-foreground-subtle hover:text-foreground"
          >
            <Search aria-hidden className="size-3.5" />
          </button>
        )}
      </div>
      {isSearchOpen && (
        <div className="flex flex-col gap-2 px-0.5">
          <label className="flex h-8 items-center gap-2 rounded-sm bg-surface px-2.5">
            <Search aria-hidden className="size-3.5 shrink-0 text-foreground-subtle" />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              placeholder="검색"
              aria-label="세션 검색어"
              className="min-w-0 flex-1 bg-transparent text-[13px] leading-[18px] text-foreground outline-none placeholder:text-foreground-subtle"
            />
            <button
              type="button"
              aria-label="검색 닫기"
              onClick={() => {
                setIsSearchOpen(false);
                setQuery('');
                setFilter('전체');
              }}
              className="rounded-sm text-foreground-subtle hover:text-foreground"
            >
              <X aria-hidden className="size-3.5" />
            </button>
          </label>
          <div role="group" aria-label="상태 필터" className="flex flex-wrap gap-1">
            {filters.map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={item === filter}
                onClick={() => {
                  setFilter(item);
                }}
                className={cn(
                  'h-6 rounded-[6px] px-2 text-xs leading-4',
                  item === filter
                    ? 'bg-surface-hover font-semibold text-foreground'
                    : 'font-medium text-foreground-subtle hover:bg-surface-hover',
                )}
              >
                {item}
              </button>
            ))}
          </div>
          <p className="px-2 text-xs leading-4 text-foreground-subtle">
            {isFiltering ? `세션 ${found}개에서 찾았습니다` : '검색어를 입력하거나 상태를 고릅니다'}
          </p>
        </div>
      )}
      {data.repos.length === 0 ? (
        <div className="flex flex-col gap-1 px-2.5 pt-1">
          <p className="text-[13px] leading-[18px] font-medium text-foreground-muted">
            아직 세션이 없습니다
          </p>
          <p className="w-[220px] text-xs leading-4 text-foreground-subtle">
            오른쪽 입력창에 첫 작업을 적으면 세션이 생깁니다.
          </p>
        </div>
      ) : (
        <nav aria-label="세션 목록" className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          {groups.map((group) => (
            <RepoGroup
              key={group.repo.name}
              repo={group.repo}
              worktrees={group.worktrees}
              selectedCwd={selectedCwd}
              selectedSessionId={selectedSessionId}
            />
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
