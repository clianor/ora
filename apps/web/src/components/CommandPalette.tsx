import {
  ListChecks,
  MessageSquare,
  RotateCcw,
  Search,
  Settings,
  SquarePen,
  type LucideIcon,
} from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../lib/cn.ts';
import { navigate, type Route } from '../lib/route.ts';
import { focusTodoPanel } from './TodoPanel.tsx';
import type { RepoNode, SessionNode, WorktreeNode } from '../model.ts';

interface PaletteItem {
  group: '세션' | '명령' | '이동';
  icon: LucideIcon;
  label: string;
  detail?: string;
  shortcut?: string;
  route: Route;
  sessionId?: string;
  /** true면 이동한 뒤 할 일 패널로 포커스를 옮깁니다. */
  focusTodos?: true;
}

const groupOrder: PaletteItem['group'][] = ['세션', '명령', '이동'];

function listSessions(
  repo: RepoNode,
  worktrees: WorktreeNode[],
): { node: SessionNode; location: string }[] {
  return worktrees.flatMap((worktree) => [
    ...worktree.sessions.map((node) => ({ node, location: `${repo.name} · ${worktree.name}` })),
    ...listSessions(repo, worktree.stack),
  ]);
}

function buildItems(repos: readonly RepoNode[]): PaletteItem[] {
  const sessions = repos.flatMap((repo) => listSessions(repo, repo.worktrees));
  return [
    ...sessions.map(({ node, location }) => ({
      group: '세션' as const,
      icon: MessageSquare,
      label: node.record.title,
      detail: location,
      route: 'worktree' as const,
      sessionId: node.record.id,
    })),
    { group: '명령', icon: SquarePen, label: '새 세션 시작', shortcut: '⌘N', route: 'worktree' },
    ...sessions
      .filter(
        ({ node }) => node.record.status === 'crashed' || node.record.status === 'interrupted',
      )
      .map(({ node }) => ({
        group: '명령' as const,
        icon: RotateCcw,
        label: `${node.record.title} 재개`,
        route: 'worktree' as const,
        sessionId: node.record.id,
      })),
    {
      group: '이동',
      icon: ListChecks,
      label: '할 일 패널',
      shortcut: '⌘1',
      route: 'worktree',
      focusTodos: true,
    },
    { group: '이동', icon: Settings, label: '설정', shortcut: '⌘,', route: 'settings' },
  ];
}

/** 검색어와 일치한 부분을 굵게 씁니다. */
function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  const needle = query.trim();
  const start = needle === '' ? -1 : text.toLowerCase().indexOf(needle.toLowerCase());
  if (start < 0) return text;
  const end = start + needle.length;
  return (
    <>
      {text.slice(0, start)}
      <span className="font-semibold text-foreground">{text.slice(start, end)}</span>
      {text.slice(end)}
    </>
  );
}

interface CommandPaletteProps {
  repos: readonly RepoNode[];
  initialQuery: string;
  onClose: () => void;
}

/** `⌘K`로 여는 명령 팔레트입니다. 세션 전환, 명령 실행, 화면 이동을 키보드만으로 합니다(SPEC 8.2절). */
export function CommandPalette({ repos, initialQuery, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);

  const needle = query.trim().toLowerCase();
  const items = buildItems(repos).filter(
    (item) => needle === '' || `${item.label} ${item.detail ?? ''}`.toLowerCase().includes(needle),
  );
  const ordered = groupOrder.flatMap((group) => items.filter((item) => item.group === group));
  const activeIndex = Math.min(active, Math.max(ordered.length - 1, 0));

  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    if (item.focusTodos) {
      requestAnimationFrame(focusTodoPanel);
      return;
    }
    navigate(item.route, { sessionId: item.sessionId });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive(Math.min(activeIndex + 1, ordered.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(ordered[activeIndex]);
    }
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-[120px] left-1/2 flex w-[640px] max-w-[calc(100%-32px)] -translate-x-1/2 flex-col overflow-hidden rounded-lg bg-surface"
        >
          <Dialog.Title className="sr-only">명령 팔레트</Dialog.Title>
          <div className="flex h-[52px] items-center gap-2.5 px-4">
            <Search aria-hidden className="size-4 text-foreground-subtle" />
            <input
              autoFocus
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={handleKeyDown}
              role="combobox"
              aria-expanded
              aria-controls="palette-results"
              aria-activedescendant={
                ordered.length > 0 ? `palette-option-${activeIndex}` : undefined
              }
              aria-label="명령 검색"
              className="min-w-0 flex-1 bg-transparent text-[15px] leading-[22px] text-foreground outline-none"
            />
            <kbd className="flex h-[22px] items-center rounded-[6px] bg-background px-1.5 font-mono text-[11px] leading-[14px] font-medium text-foreground-subtle">
              Esc
            </kbd>
          </div>
          <div className="h-px bg-background" />
          <div
            id="palette-results"
            role="listbox"
            className="flex max-h-[420px] flex-col gap-2 overflow-y-auto p-2"
          >
            {ordered.length === 0 && (
              <p className="px-3 py-2 text-[13px] leading-[18px] text-foreground-subtle">
                일치하는 항목이 없습니다
              </p>
            )}
            {groupOrder.map((group) => {
              const rows = ordered.filter((item) => item.group === group);
              if (rows.length === 0) return null;
              return (
                <div
                  key={group}
                  role="group"
                  aria-labelledby={`palette-group-${group}`}
                  className="flex flex-col gap-0.5"
                >
                  <h3
                    id={`palette-group-${group}`}
                    className="flex h-6 items-center px-3 text-xs leading-4 font-medium text-foreground-subtle"
                  >
                    {group}
                  </h3>
                  {rows.map((item) => {
                    const index = ordered.indexOf(item);
                    const isActive = index === activeIndex;
                    const Icon = item.icon;
                    return (
                      <div
                        key={`${item.group}-${item.label}`}
                        id={`palette-option-${index}`}
                        ref={(node) => {
                          if (isActive) node?.scrollIntoView({ block: 'nearest' });
                        }}
                        role="option"
                        aria-selected={isActive}
                        onClick={() => {
                          run(item);
                        }}
                        onMouseMove={() => {
                          setActive(index);
                        }}
                        className={cn(
                          'flex h-9 cursor-default items-center gap-2.5 rounded-sm px-3',
                          isActive && 'bg-surface-hover',
                        )}
                      >
                        <Icon
                          aria-hidden
                          className={cn(
                            'size-[15px]',
                            isActive ? 'text-foreground' : 'text-foreground-subtle',
                          )}
                        />
                        <span className="text-[13px] leading-[18px] text-foreground-muted">
                          <Highlight text={item.label} query={query} />
                        </span>
                        {item.detail && (
                          <span className="font-mono text-xs leading-4 text-foreground-subtle">
                            <Highlight text={item.detail} query={query} />
                          </span>
                        )}
                        {item.shortcut && (
                          <kbd className="ml-auto font-mono text-xs leading-4 font-medium text-foreground-subtle">
                            {item.shortcut}
                          </kbd>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          <div className="flex h-9 items-center gap-4 bg-surface-sunken px-4 text-xs leading-4 text-foreground-subtle">
            <span>↑↓ 이동</span>
            <span>↵ 실행</span>
            <span>Esc 닫기</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
