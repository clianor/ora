import type { SessionStatus, WorktreeTab } from '@ora/protocol';
import {
  GitCompare,
  PanelLeft,
  PanelRightOpen,
  Plus,
  SquarePen,
  SquareTerminal,
  X,
} from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { cn } from '../lib/cn.ts';
import { pickPanelTab, setPanelOpen, usePanelState } from '../lib/panel.ts';
import { closeTab, openNewTab, selectTab, type TabContext } from '../lib/tabs.ts';
import { useStore } from '../store.tsx';
import { DiffStat } from '../ui/stat.tsx';
import { StatusIcon } from './StatusIcon.tsx';

function tabIcon(tab: WorktreeTab, status: SessionStatus | undefined): ReactNode {
  if (tab.kind === 'terminal') {
    return <SquareTerminal aria-hidden className="size-3.5 shrink-0 text-foreground-muted" />;
  }
  if (tab.kind === 'session' && status) return <StatusIcon status={status} />;
  return <SquarePen aria-hidden className="size-3.5 shrink-0 text-foreground-subtle" />;
}

interface TitleBarProps {
  context: TabContext;
  diff: { add: number; del: number } | null;
  onToggleSidebar: () => void;
}

/**
 * 창 맨 위 제목 줄입니다. 왼쪽에 탭, 오른쪽에 diff 칩과 패널이 접혔을 때의 열기 단추를 둡니다.
 * 고른 탭은 본문과 같은 바탕이라 아래 내용으로 이어져 보입니다.
 */
export function TitleBar({ context, diff, onToggleSidebar }: TitleBarProps) {
  const store = useStore();
  const { isOpen } = usePanelState();
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const { tabs, activeTabId } = context;
  return (
    <header className="flex h-10 shrink-0 items-stretch border-b border-border bg-titlebar">
      <button
        type="button"
        aria-label="사이드바 열고 닫기"
        onClick={onToggleSidebar}
        className="flex w-10 shrink-0 items-center justify-center text-foreground-muted hover:bg-surface-hover hover:text-foreground"
      >
        <PanelLeft aria-hidden className="size-4" />
      </button>
      <div
        role="tablist"
        aria-label="워크트리 탭"
        className="flex min-w-0 items-stretch"
        onKeyDown={(event) => {
          const count = tabs.tabs.length;
          const index = tabs.tabs.findIndex((tab) => tab.id === activeTabId);
          const moves: Record<string, number | undefined> = {
            ArrowRight: (index + 1) % count,
            ArrowLeft: (index - 1 + count) % count,
            Home: 0,
            End: count - 1,
          };
          const target = moves[event.key];
          const tab = target === undefined ? undefined : tabs.tabs[target];
          if (target === undefined || !tab) return;
          event.preventDefault();
          selectTab(context, tab.id);
          tabButtons.current[target]?.focus();
        }}
      >
        {tabs.tabs.map((tab, index) => {
          const isActive = tab.id === activeTabId;
          const session = tab.kind === 'session' ? store.getSession(tab.sessionId) : undefined;
          const terminalNumber =
            tabs.tabs
              .filter((item) => item.kind === 'terminal')
              .findIndex((item) => item.id === tab.id) + 1;
          const titles = {
            session: session?.record.title ?? '세션',
            terminal: `터미널 ${String(terminalNumber)}`,
            new: '새 탭',
          };
          return (
            <div
              key={tab.id}
              className={cn(
                'group flex max-w-[220px] min-w-0 items-center border-r border-border',
                isActive ? '-mb-px bg-background' : 'hover:bg-surface-hover',
              )}
            >
              <button
                ref={(element) => {
                  tabButtons.current[index] = element;
                }}
                type="button"
                role="tab"
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                onClick={() => {
                  selectTab(context, tab.id);
                }}
                className={cn(
                  'flex h-full min-w-0 items-center gap-2 pr-1 pl-3 text-[13px] leading-[18px]',
                  isActive ? 'font-medium text-foreground' : 'text-foreground-muted',
                )}
              >
                {tabIcon(tab, session?.record.status)}
                <span className="truncate">{titles[tab.kind]}</span>
              </button>
              <button
                type="button"
                aria-label="탭 닫기"
                onClick={() => {
                  const isTerminalRunning =
                    tab.kind === 'terminal' &&
                    store.getTerminal(tab.terminalId)?.status === 'running';
                  if (
                    isTerminalRunning &&
                    !window.confirm('실행 중인 터미널을 종료하고 탭을 닫을까요?')
                  ) {
                    return;
                  }
                  closeTab(context, tab, isTerminalRunning);
                }}
                className={cn(
                  'mr-2 flex size-[18px] shrink-0 items-center justify-center rounded-[4px] text-foreground-subtle hover:text-foreground focus-visible:opacity-100',
                  isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                )}
              >
                <X aria-hidden className="size-3" />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        aria-label="새 탭"
        onClick={() => {
          openNewTab(context);
        }}
        className="flex w-9 shrink-0 items-center justify-center text-foreground-muted hover:bg-surface-hover hover:text-foreground"
      >
        <Plus aria-hidden className="size-4" />
      </button>
      <div className="ml-auto flex shrink-0 items-center gap-1.5 px-2.5">
        {diff && (diff.add > 0 || diff.del > 0) && (
          <button
            type="button"
            title="변경 탭 열기"
            onClick={() => {
              pickPanelTab('changes');
              setPanelOpen(true);
            }}
            className="flex h-7 items-center gap-1.5 rounded-sm px-2 hover:bg-surface-hover"
          >
            <GitCompare aria-hidden className="size-3.5 text-foreground-muted" />
            <DiffStat add={diff.add} del={diff.del} />
            <span className="sr-only">변경 탭 열기</span>
          </button>
        )}
        {!isOpen && (
          <button
            type="button"
            onClick={() => {
              setPanelOpen(true);
            }}
            className="flex h-7 items-center gap-1.5 rounded-sm bg-surface-hover px-2 text-xs leading-4 font-medium text-foreground-muted hover:text-foreground"
          >
            <PanelRightOpen aria-hidden className="size-[15px] text-foreground" />
            <span className="sr-only">오른쪽 패널 열기 </span>
            <kbd className="font-sans">⌥⌘B</kbd>
          </button>
        )}
      </div>
    </header>
  );
}
