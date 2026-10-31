import type {
  DefaultBranchSync,
  LivePort,
  PrState,
  PrStatusResponse,
  SessionStatus,
} from '@ora/protocol';
import {
  ExternalLink,
  Plug,
  RefreshCw,
  Square,
  CircleX,
  CornerDownRight,
  FolderGit2,
  GitBranch,
  History,
  Loader,
  MessageCircleQuestion,
  Plus,
  Trash2,
  Search,
  Settings,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { formatShortElapsed, useNow } from '../lib/now.ts';
import { hashFor, setCleanupWorktrees, setCreateWorktree, setPaletteOpen } from '../lib/route.ts';
import { runningStatuses, statusLabel } from '../lib/status.ts';
import type { RepoNode, SidebarData, WorktreeNode } from '../model.ts';
import { PrChecksIcon, PrStateIcon, describePr, prStateLabel } from './PrParts.tsx';
import { PrStatusSync } from './PrStatusSync.tsx';
import { runAction, useStore } from '../store.tsx';

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

function describeSync(sync: DefaultBranchSync): string {
  const parts: string[] = [];
  if (sync.behind > 0) parts.push(`원격보다 ${String(sync.behind)}개 뒤처짐`);
  if (sync.ahead > 0) parts.push(`원격보다 ${String(sync.ahead)}개 앞섬`);
  return parts.join(', ');
}

const isFinished = (state: PrState): boolean => state === 'MERGED' || state === 'CLOSED';

function WorktreeRow({
  node,
  depth,
  selectedCwd,
  now,
  status,
  repoPath,
}: {
  node: WorktreeNode;
  depth: number;
  selectedCwd: string | undefined;
  now: number;
  status: PrStatusResponse | undefined;
  repoPath: string | undefined;
}) {
  const { getBranch, getDefaultBranch, getPorts } = useStore();
  const cwd = node.cwd ?? node.name;
  const isSelected = selectedCwd === cwd;
  const branch = getBranch(cwd);
  const isDefault = branch !== undefined && branch === getDefaultBranch(cwd);
  const active = node.sessions.filter((session) => runningStatuses.has(session.record.status));
  const entry = status?.worktrees.find((item) => item.path === cwd);
  const ports =
    repoPath === undefined
      ? []
      : (getPorts(repoPath)?.worktrees.find((item) => item.path === cwd)?.ports ?? []);
  const hasBadge =
    node.setup?.status === 'creating' ||
    node.setup?.status === 'setup' ||
    node.setup?.status === 'setup-failed' ||
    (!isSelected && active.length > 0);
  const Icon = depth > 0 ? CornerDownRight : GitBranch;
  const row = (
    <a
      href={hashFor('worktree', { cwd })}
      title={node.title}
      aria-current={isSelected ? 'page' : undefined}
      style={{ paddingLeft: 10 + stackIndent * depth }}
      className={cn(
        'flex h-8 items-center gap-2 rounded-sm transition-colors duration-(--duration-fast) ease-(--ease-out)',
        ports.length > 0 ? 'pr-12' : 'pr-2.5',
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
      {(node.setup?.status === 'creating' || node.setup?.status === 'setup') && (
        <span className="ml-auto flex items-center gap-1.5 text-xs leading-4 font-medium text-foreground-muted">
          <Loader aria-hidden className="size-3.5 motion-safe:animate-spin" />
          생성 중
        </span>
      )}
      {node.setup?.status === 'setup-failed' && (
        <span className="ml-auto flex items-center gap-1.5 text-xs leading-4 font-medium text-danger">
          <CircleX aria-hidden className="size-3.5" />
          초기 명령 실패
        </span>
      )}
      {!isSelected && active.length > 0 && node.setup?.status !== 'setup-failed' && (
        <span className="ml-auto text-xs leading-4 font-medium text-foreground-muted">
          실행 {active.length}
        </span>
      )}
      {entry?.sync !== undefined && (entry.sync.behind > 0 || entry.sync.ahead > 0) && (
        <span
          title={describeSync(entry.sync)}
          className={cn(
            'flex items-center gap-1.5 text-xs leading-4 font-medium text-foreground-muted',
            !hasBadge && 'ml-auto',
          )}
        >
          <span aria-hidden className="flex gap-1.5">
            {entry.sync.behind > 0 && <span>↓{entry.sync.behind}</span>}
            {entry.sync.ahead > 0 && <span>↑{entry.sync.ahead}</span>}
          </span>
          <span className="sr-only">{describeSync(entry.sync)}</span>
        </span>
      )}
      {entry?.pr !== undefined && (
        <span
          title={describePr(entry.pr)}
          className={cn(
            'flex items-center gap-1 text-xs leading-4 font-medium text-foreground-muted',
            hasBadge ? 'ml-2' : 'ml-auto',
          )}
        >
          <PrStateIcon state={entry.pr.state} />
          <span
            aria-hidden
            className={cn(isFinished(entry.pr.state) || 'font-mono text-foreground')}
          >
            {isFinished(entry.pr.state)
              ? prStateLabel[entry.pr.state]
              : `#${String(entry.pr.number)}`}
          </span>
          {!isFinished(entry.pr.state) && <PrChecksIcon checks={entry.pr.checks} />}
          <span className="sr-only">PR {describePr(entry.pr)}</span>
        </span>
      )}
    </a>
  );
  const rowBlock =
    ports.length > 0 && repoPath !== undefined ? (
      <div className="relative">
        {row}
        <PortsButton repo={repoPath} path={cwd} name={branch ?? node.name} ports={ports} />
      </div>
    ) : (
      row
    );
  return (
    <>
      {isSelected ? (
        <div
          className={cn(
            'flex flex-col rounded-md bg-surface ring-1 ring-border-strong ring-inset',
            active.length > 0 && 'pb-1',
          )}
        >
          {rowBlock}
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
                  className={cn(
                    'size-3.5 shrink-0',
                    color,
                    StatusIcon === Loader && 'motion-safe:animate-spin',
                  )}
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
        rowBlock
      )}
      {node.stack.map((child) => (
        <WorktreeRow
          key={child.name}
          node={child}
          depth={depth + 1}
          selectedCwd={selectedCwd}
          now={now}
          status={status}
          repoPath={repoPath}
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
  const { getPrStatus } = useStore();
  const repoPath = repo.path;
  const status = repoPath === undefined ? undefined : getPrStatus(repoPath);
  const mergedCount =
    status === undefined || status.unavailable !== undefined
      ? 0
      : status.worktrees.filter(
          (item) => !item.isMain && !item.isDefault && item.pr?.state === 'MERGED',
        ).length;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex h-8 items-center gap-2 px-2.5">
        <FolderGit2 aria-hidden className="size-3.5 text-foreground-muted" />
        <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] font-semibold text-foreground">
          {repo.name}
        </span>
        {repo.path !== undefined && (
          <button
            type="button"
            onClick={() => {
              setCreateWorktree(repo.path);
            }}
            className="flex size-6 items-center justify-center rounded-sm text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
          >
            <Plus aria-hidden className="size-3.5" />
            <span className="sr-only">{repo.name}에 새 워크트리 만들기</span>
          </button>
        )}
      </div>
      {repo.worktrees.map((node) => (
        <WorktreeRow
          key={node.name}
          node={node}
          depth={0}
          selectedCwd={selectedCwd}
          now={now}
          status={status}
          repoPath={repoPath}
        />
      ))}
      {mergedCount > 0 && repoPath !== undefined && (
        <button
          type="button"
          onClick={() => {
            setCleanupWorktrees(repoPath);
          }}
          className="flex h-8 items-center gap-2 rounded-sm px-2.5 text-[13px] leading-[18px] text-foreground-muted hover:bg-surface-hover hover:text-foreground"
        >
          <Trash2 aria-hidden className="size-3.5 shrink-0 text-foreground-subtle" />
          머지된 워크트리 {mergedCount}개 삭제…
        </button>
      )}
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
      <PrStatusSync />
      <PortsSync />
      {window.ora !== undefined && <div data-titlebar aria-hidden className="-mb-1 h-6 shrink-0" />}
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
      <div className="mt-auto flex h-8 items-center justify-end px-2.5">
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

/**
 * 저장소마다 라이브 포트를 읽습니다. 창이 앞에 있는 동안 5초마다 읽고, 창에 포커스가 돌아올 때도 읽습니다.
 * 팝오버가 열려 있는 동안의 2초 간격은 팝오버가 따로 맡습니다.
 */
function PortsSync() {
  const { sidebar, actions } = useStore();
  const repoKey = sidebar.repos
    .flatMap((repo) => (repo.path === undefined ? [] : [repo.path]))
    .join('\n');

  /** 창 포커스와 타이머는 브라우저 창 상태라서 렌더 결과로 계산할 수 없고, 이 저장소에는 구독 훅 라이브러리가 없어 effect로 맞춥니다. */
  useEffect(() => {
    const repos = repoKey === '' ? [] : repoKey.split('\n');
    const refreshAll = () => {
      if (document.visibilityState === 'hidden') return;
      for (const repo of repos) runAction(actions.refreshPorts(repo));
    };
    refreshAll();
    const timer = setInterval(refreshAll, 5000);
    window.addEventListener('focus', refreshAll);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refreshAll);
    };
  }, [actions, repoKey]);

  return null;
}

/** 워크트리 줄의 플러그 아이콘과 라이브 포트 팝오버입니다. 줄을 누르면 브라우저에서 열고, 종료 단추는 그 프로세스 하나만 끕니다. */
function PortsButton({
  repo,
  path,
  name,
  ports,
}: {
  repo: string;
  path: string;
  name: string;
  ports: LivePort[];
}) {
  const { actions } = useStore();
  const [top, setTop] = useState<number>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const isOpen = top !== undefined;
  const reveal =
    'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100';

  /** 팝오버가 열려 있는 동안만 2초마다 다시 읽는 타이머라서 렌더 결과로 계산할 수 없고, 이 저장소에는 타이머 훅 라이브러리가 없어 effect로 맞춥니다. */
  useEffect(() => {
    if (!isOpen) return;
    const timer = setInterval(() => {
      runAction(actions.refreshPorts(repo));
    }, 2000);
    return () => {
      clearInterval(timer);
    };
  }, [actions, repo, isOpen]);

  const close = () => {
    setTop(undefined);
    triggerRef.current?.focus();
  };
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-label={`${name}의 라이브 포트 ${String(ports.length)}개`}
        onClick={(event) => {
          setTop(isOpen ? undefined : event.currentTarget.getBoundingClientRect().top - 4);
        }}
        className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-[3px] rounded-sm px-1 text-xs leading-4 font-medium text-foreground-muted hover:bg-surface-hover"
      >
        <Plug aria-hidden className="size-[13px]" />
        <span aria-hidden className="font-mono">
          {ports.length}
        </span>
      </button>
      {isOpen && (
        <>
          <div aria-hidden className="fixed inset-0 z-40" onClick={close} />
          <div
            role="dialog"
            aria-label={`${name}의 라이브 포트`}
            style={{ top }}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.stopPropagation();
              close();
            }}
            className="fixed left-[272px] z-50 flex w-[400px] flex-col gap-1 rounded-xl border border-border-strong bg-popover p-2.5"
          >
            <div className="flex h-[30px] items-center gap-2 px-1.5">
              <GitBranch aria-hidden className="size-3.5 text-foreground-muted" />
              <span className="min-w-0 flex-1 truncate font-mono text-[13px] leading-[18px] font-semibold text-foreground">
                {name}
              </span>
              <button
                type="button"
                autoFocus
                aria-label="새로고침"
                onClick={() => {
                  runAction(actions.refreshPorts(repo));
                }}
                className="flex size-6 items-center justify-center rounded-sm text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
              >
                <RefreshCw aria-hidden className="size-[13px]" />
              </button>
            </div>
            <div className="flex h-[26px] items-center gap-1.5 px-1.5 text-xs leading-4 font-semibold text-foreground-muted">
              <Plug aria-hidden className="size-[13px]" />
              라이브 포트 ({ports.length})
            </div>
            <ul className="flex flex-col">
              {ports.map((item) => (
                <li
                  key={`${String(item.pid)}-${String(item.port)}-${item.address}`}
                  className="group flex h-10 items-center gap-2 rounded-md px-2.5 hover:bg-surface-hover focus-within:bg-surface-hover"
                >
                  <button
                    type="button"
                    aria-label={`포트 ${String(item.port)}를 브라우저에서 열기`}
                    onClick={() => {
                      window.open(
                        `http://localhost:${String(item.port)}`,
                        '_blank',
                        'noopener,noreferrer',
                      );
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  >
                    <span className="w-[52px] font-mono text-sm leading-5 font-semibold text-foreground">
                      {item.port}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-px">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate font-mono text-[13px] leading-[18px] font-medium text-foreground">
                          {item.name}
                        </span>
                        {item.isExternal && (
                          <span className="shrink-0 rounded-[5px] bg-surface-hover px-1.5 text-[11px] leading-[18px] font-medium text-foreground-muted">
                            Ora 밖에서 시작
                          </span>
                        )}
                      </span>
                      <span className="truncate font-mono text-xs leading-4 text-foreground-subtle">
                        {item.address} · PID {item.pid}
                      </span>
                    </span>
                    <ExternalLink
                      aria-hidden
                      className={cn('size-3.5 shrink-0 text-foreground-muted', reveal)}
                    />
                  </button>
                  <button
                    type="button"
                    aria-label={`포트 ${String(item.port)}의 ${item.name} 종료`}
                    onClick={() => {
                      runAction(actions.killPort(repo, path, item.pid, item.port));
                    }}
                    className={cn(
                      'flex h-[26px] shrink-0 items-center gap-[5px] rounded-md bg-danger-subtle px-2 text-xs leading-4 font-semibold text-danger',
                      reveal,
                    )}
                  >
                    <Square aria-hidden className="size-[11px]" />
                    종료
                  </button>
                </li>
              ))}
            </ul>
            <p className="px-1.5 py-1 text-xs leading-[18px] text-foreground-subtle">
              줄을 누르면 브라우저에서 엽니다. 종료는 그 프로세스 하나만 끕니다.
            </p>
          </div>
        </>
      )}
    </>
  );
}
