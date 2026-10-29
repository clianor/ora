import type { WorktreeTab, WorktreeTabs } from '@ora/protocol';
import { Globe, MessageSquare, Smartphone, SquareTerminal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getStageIndex } from '../events.ts';
import { cn } from '../lib/cn.ts';
import { basename } from '../lib/path.ts';
import { navigate, type RouteState } from '../lib/route.ts';
import { usePanelState } from '../lib/panel.ts';
import { runningStatuses } from '../lib/status.ts';
import { openNewTab, openTerminalTab, turnIntoSessionTab, type TabContext } from '../lib/tabs.ts';
import { findWorktreeOfSession, listWorktrees } from '../lib/worktrees.ts';
import { runAction, useStore } from '../store.tsx';
import { RightPanel } from './RightPanel.tsx';
import { Sidebar } from './Sidebar.tsx';
import { TerminalTab } from './TerminalTab.tsx';
import { TitleBar } from './TitleBar.tsx';
import { NewSessionWelcome } from './Welcome.tsx';
import { Workbench } from './Workbench.tsx';

function Notice({ title, detail }: { title: string; detail: string }) {
  return (
    <main className="flex min-w-0 flex-1 flex-col items-center justify-center gap-1">
      <h1 className="text-sm leading-5 font-semibold text-foreground">{title}</h1>
      <p role="status" className="text-xs leading-4 text-foreground-subtle">
        {detail}
      </p>
    </main>
  );
}

const chooserRowClass =
  'flex h-9 w-full items-center gap-2.5 rounded-md border border-border bg-surface px-3 text-[13px] leading-[18px]';

function NewTabChooser({
  title,
  onPickSession,
  onPickTerminal,
}: {
  title: string;
  onPickSession: () => void;
  onPickTerminal: () => void;
}) {
  return (
    <main className="flex min-w-0 flex-1 flex-col items-center justify-center">
      <div className="flex w-80 flex-col gap-1.5">
        <h2 className="text-[13px] leading-[18px] text-foreground-subtle">{title}에서 열기</h2>
        <button
          type="button"
          onClick={onPickSession}
          className={cn(chooserRowClass, 'font-medium text-foreground hover:bg-surface-hover')}
        >
          <MessageSquare aria-hidden className="size-4 text-foreground-muted" />
          <span className="flex-1 text-left">세션</span>
          <kbd className="rounded-[5px] bg-kbd px-1.5 font-sans text-xs font-normal text-foreground-muted">
            ⇧⌘S
          </kbd>
        </button>
        <button
          type="button"
          onClick={onPickTerminal}
          className={cn(chooserRowClass, 'font-medium text-foreground hover:bg-surface-hover')}
        >
          <SquareTerminal aria-hidden className="size-4 text-foreground-muted" />
          <span className="flex-1 text-left">터미널</span>
          <kbd className="rounded-[5px] bg-kbd px-1.5 font-sans text-xs font-normal text-foreground-muted">
            ⇧⌘T
          </kbd>
        </button>
        <button
          type="button"
          disabled
          aria-describedby="new-tab-later"
          className={cn(chooserRowClass, 'text-foreground-subtle')}
        >
          <Globe aria-hidden className="size-4" />
          <span className="flex-1 text-left">브라우저</span>
          <span className="text-xs">곧 지원</span>
        </button>
        <button
          type="button"
          disabled
          aria-describedby="new-tab-later"
          className={cn(chooserRowClass, 'text-foreground-subtle')}
        >
          <Smartphone aria-hidden className="size-4" />
          <span className="flex-1 text-left">에뮬레이터</span>
          <span className="text-xs">곧 지원</span>
        </button>
        <p
          id="new-tab-later"
          className="pt-0.5 text-center text-xs leading-4 text-foreground-subtle"
        >
          브라우저와 에뮬레이터는 데스크톱 앱(M3)에서 지원합니다.
        </p>
      </div>
    </main>
  );
}

function TabContent({
  tab,
  cwd,
  context,
  runningCount,
  title,
  repoName,
  isSessionMode,
  isModelPickerOpen,
}: {
  tab: WorktreeTab | undefined;
  cwd: string;
  context: TabContext;
  runningCount: number;
  title: string;
  repoName: string;
  isSessionMode: boolean;
  isModelPickerOpen: boolean;
}) {
  const store = useStore();
  if (tab?.kind === 'session') {
    const view = store.getSession(tab.sessionId);
    if (!view) {
      return <Notice title="세션을 찾지 못했습니다" detail="탭을 닫고 기록에서 다시 엽니다." />;
    }
    return <Workbench key={view.record.id} view={view} sameFolderRunningCount={runningCount} />;
  }
  if (tab?.kind === 'terminal') {
    return (
      <TerminalTab
        key={tab.id}
        terminalId={tab.terminalId}
        onRestart={() => {
          runAction(openTerminalTab(context, tab.id));
        }}
      />
    );
  }
  if (isSessionMode) {
    return (
      <main className="flex min-w-0 flex-1 flex-col">
        <NewSessionWelcome
          repoName={repoName}
          context={store.getNewSessionContext(cwd)}
          cwd={cwd}
          isPickerOpen={isModelPickerOpen}
          onCreated={(sessionId) => {
            turnIntoSessionTab(context, tab?.id, sessionId);
          }}
        />
      </main>
    );
  }
  return (
    <NewTabChooser
      title={title}
      onPickSession={() => {
        navigate('worktree', { cwd, tabId: tab?.id, isSessionMode: true });
      }}
      onPickTerminal={() => {
        runAction(openTerminalTab(context, tab?.id));
      }}
    />
  );
}

/** 주소와 키보드가 탭을 바꾸는 외부 입력이라서, 탭 화면이 열려 있는 동안만 그 입력을 탭 저장소에 연결합니다. */
function TabEffects({
  context,
  activeTab,
  sessionId,
}: {
  context: TabContext;
  activeTab: WorktreeTab | undefined;
  sessionId: string | undefined;
}) {
  /** `#/session/<ID>` 주소가 가리키는 세션의 탭이 아직 없으면 서버 파일에 탭을 더합니다. */
  useEffect(() => {
    if (sessionId === undefined) return;
    const hasTab = context.tabs.tabs.some(
      (tab) => tab.kind === 'session' && tab.sessionId === sessionId,
    );
    if (hasTab) return;
    const added: WorktreeTab = {
      id: crypto.randomUUID().replaceAll('-', '').slice(0, 10),
      kind: 'session',
      sessionId,
    };
    runAction(
      context.actions.saveTabs(context.cwd, {
        tabs: [...context.tabs.tabs, added],
        activeTabId: added.id,
      }),
    );
  }, [context, sessionId]);

  /** 창 전체에서 탭 단축키(⌘T, ⌘N, ⇧⌘S, ⇧⌘T)를 받으려면 window 이벤트를 구독해야 합니다. */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      const key = event.key.toLowerCase();
      const newTabId = activeTab?.kind === 'new' ? activeTab.id : undefined;
      if (event.shiftKey && key === 's') {
        event.preventDefault();
        if (newTabId)
          navigate('worktree', { cwd: context.cwd, tabId: newTabId, isSessionMode: true });
        else openNewTab(context, true);
      } else if (event.shiftKey && key === 't') {
        event.preventDefault();
        runAction(openTerminalTab(context, newTabId));
      } else if (key === 't') {
        event.preventDefault();
        openNewTab(context);
      } else if (key === 'n') {
        event.preventDefault();
        openNewTab(context, true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [context, activeTab]);
  return null;
}

/** 워크트리 하나의 탭 화면입니다. 위에 저장소·워크트리 이름과 diff 칩, 그 아래 탭 줄, 나머지는 고른 탭의 내용입니다. */
export function WorktreeScreen({ state }: { state: RouteState }) {
  const store = useStore();
  const { actions, sidebar } = store;
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const { isOpen: isPanelOpen } = usePanelState();

  const explicitView =
    state.sessionId === undefined ? undefined : store.getSession(state.sessionId);
  const isDefaultEntry = state.cwd === undefined && state.sessionId === undefined;
  const defaultView =
    isDefaultEntry && store.defaultSessionId !== undefined
      ? store.getSession(store.defaultSessionId)
      : undefined;
  const entryView = explicitView ?? defaultView;
  const entryRef = entryView && findWorktreeOfSession(sidebar.repos, entryView.record.id);
  const cwd = state.cwd ?? entryRef?.cwd ?? store.getNewSessionContext().path;
  const ref = listWorktrees(sidebar.repos).find((item) => item.cwd === cwd);
  const tabs = cwd === undefined ? undefined : store.getTabs(cwd);

  const activeTab = tabs && pickActiveTab(tabs, state.tabId, explicitView?.record.id);
  const activeTabId = activeTab?.id;
  const activeView =
    activeTab?.kind === 'session' ? store.getSession(activeTab.sessionId) : undefined;
  const context: TabContext | undefined =
    cwd && tabs ? { actions, cwd, tabs, activeTabId } : undefined;

  /** 탭 목록은 서버 파일에 있어서, 워크트리를 열 때 한 번 읽어 와야 합니다. */
  useEffect(() => {
    if (cwd) runAction(actions.loadTabs(cwd));
  }, [actions, cwd]);

  const revision = activeView?.events.filter((event) => event.type === 'tool_result').length ?? 0;
  /** 변경 목록은 서버의 git 상태라서, 워크트리를 열 때와 세션의 도구 호출이 끝날 때마다 다시 읽어야 합니다. */
  useEffect(() => {
    if (cwd) runAction(actions.loadChanges(cwd));
  }, [actions, cwd, revision]);

  if (store.status === 'loading') {
    return (
      <>
        <Sidebar data={sidebar} />
        <Notice title="세션을 불러오는 중입니다" detail="" />
      </>
    );
  }
  if (store.status === 'error') {
    return (
      <>
        <Sidebar data={sidebar} />
        <Notice title="서버에 연결하지 못했습니다" detail={store.errorMessage ?? ''} />
      </>
    );
  }
  if (cwd === undefined) {
    return (
      <>
        <Sidebar data={sidebar} />
        <Notice
          title="작업 폴더를 알 수 없습니다"
          detail={store.infoError ?? '사이드바에서 워크트리를 고릅니다.'}
        />
      </>
    );
  }

  const runningCount = ref
    ? ref.node.sessions.filter((session) => runningStatuses.has(session.record.status)).length
    : 0;
  const changes = store.getChanges(cwd);
  const diff = changes?.isRepo
    ? {
        add: changes.files.reduce((sum, file) => sum + file.add, 0),
        del: changes.files.reduce((sum, file) => sum + file.del, 0),
      }
    : null;

  return (
    <>
      {isSidebarOpen && <Sidebar data={sidebar} selectedCwd={cwd} />}
      <div className="flex min-w-0 flex-1 flex-col">
        {context ? (
          <>
            <TabEffects
              context={context}
              activeTab={activeTab}
              sessionId={explicitView?.record.id}
            />
            <TitleBar
              context={context}
              stageIndex={activeView ? getStageIndex(activeView.events) : null}
              diff={diff}
              onToggleSidebar={() => {
                setIsSidebarOpen(!isSidebarOpen);
              }}
            />
            <div className="flex min-h-0 flex-1">
              <TabContent
                tab={
                  activeTab ??
                  (explicitView && !tabs?.tabs.length
                    ? { id: 'pending', kind: 'session', sessionId: explicitView.record.id }
                    : undefined)
                }
                cwd={cwd}
                context={context}
                runningCount={runningCount}
                title={`${ref?.repo.name ?? basename(cwd)} · ${ref?.node.name ?? basename(cwd)}`}
                repoName={ref?.repo.name ?? basename(cwd)}
                isSessionMode={state.isSessionMode === true}
                isModelPickerOpen={state.isModelPickerOpen === true}
              />
            </div>
          </>
        ) : (
          <Notice title="탭을 불러오는 중입니다" detail="" />
        )}
      </div>
      {isPanelOpen && (
        <RightPanel
          cwd={cwd}
          session={
            activeView && {
              record: activeView.record,
              events: activeView.events,
              todos: activeView.todos,
            }
          }
        />
      )}
    </>
  );
}

/** 주소의 탭 ID, 주소의 세션, 마지막으로 고른 탭, 첫 탭 순으로 보여 줄 탭을 정합니다. 주소가 탭 ID를 가리키는데 그 탭이 없으면 없는 대로 둡니다. */
function pickActiveTab(
  tabs: WorktreeTabs,
  tabId: string | undefined,
  sessionId: string | undefined,
): WorktreeTab | undefined {
  if (tabId !== undefined) return tabs.tabs.find((tab) => tab.id === tabId);
  if (sessionId !== undefined) {
    return tabs.tabs.find((tab) => tab.kind === 'session' && tab.sessionId === sessionId);
  }
  return tabs.tabs.find((tab) => tab.id === tabs.activeTabId) ?? tabs.tabs[0];
}
