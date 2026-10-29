import { useEffect, useState } from 'react';
import { CommandPalette } from './components/CommandPalette.tsx';
import { Header } from './components/Header.tsx';
import { AccountsPage } from './components/Accounts.tsx';
import { AppearancePage, SettingsNav } from './components/Settings.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { focusTodoPanel } from './components/TodoPanel.tsx';
import { EmptyWelcome, NewSessionWelcome } from './components/Welcome.tsx';
import { Workbench } from './components/Workbench.tsx';
import { basename } from './lib/path.ts';
import { navigate, useRouteState, type RouteState } from './lib/route.ts';
import { useStore } from './store.tsx';

function useShortcuts(state: RouteState) {
  /** 창 전체에서 키보드 단축키(⌘K, ⌘N, ⌘,, ⌘1)를 받으려면 window 이벤트를 구독해야 합니다. */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.key === 'k') {
        event.preventDefault();
        navigate(state.route, {
          sessionId: state.sessionId,
          isPaletteOpen: !state.isPaletteOpen,
        });
      } else if (event.key === 'n') {
        event.preventDefault();
        navigate('new');
      } else if (event.key === ',') {
        event.preventDefault();
        navigate('settings');
      } else if (event.key === '1') {
        event.preventDefault();
        focusTodoPanel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [state.route, state.sessionId, state.isPaletteOpen]);
}

function NewScreen({ cwd, isPickerOpen }: { cwd?: string; isPickerOpen?: boolean }) {
  const store = useStore();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const context = store.getNewSessionContext(cwd);
  return (
    <>
      {isSidebarOpen && <Sidebar data={store.sidebar} selectedCwd={context.path} />}
      <main className="flex min-w-0 flex-1 flex-col">
        <Header
          title="새 세션"
          repoLabel={context.path === undefined ? undefined : basename(context.path)}
          repoTitle={context.path}
          onToggleSidebar={() => {
            setIsSidebarOpen(!isSidebarOpen);
          }}
        />
        {store.infoError && (
          <p
            role="alert"
            className="mx-5 rounded-md bg-danger-subtle px-3 py-2 text-xs leading-[18px] text-danger"
          >
            {store.infoError}
          </p>
        )}
        <NewSessionWelcome context={context} cwd={cwd} isPickerOpen={isPickerOpen} />
      </main>
    </>
  );
}

function Notice({ title, detail }: { title: string; detail: string }) {
  const store = useStore();
  return (
    <>
      <Sidebar data={store.sidebar} />
      <main className="flex min-w-0 flex-1 flex-col items-center justify-center gap-1">
        <h1 className="text-sm leading-5 font-semibold text-foreground">{title}</h1>
        <p role="status" className="text-xs leading-4 text-foreground-subtle">
          {detail}
        </p>
      </main>
    </>
  );
}

function SessionScreen({ sessionId }: { sessionId: string | undefined }) {
  const store = useStore();
  if (store.status === 'loading') return <Notice title="세션을 불러오는 중입니다" detail="" />;
  if (store.status === 'error') {
    return <Notice title="서버에 연결하지 못했습니다" detail={store.errorMessage ?? ''} />;
  }
  const id = sessionId ?? store.defaultSessionId;
  if (id === undefined) return <NewScreen />;
  const view = store.getSession(id);
  if (!view) {
    return <Notice title="세션을 찾지 못했습니다" detail="사이드바에서 다른 세션을 고릅니다." />;
  }
  return <Workbench sidebar={store.sidebar} view={view} />;
}

function Screen({ state }: { state: RouteState }) {
  const store = useStore();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  switch (state.route) {
    case 'session':
      return <SessionScreen sessionId={state.sessionId} />;
    case 'settings': {
      const page = state.settingsPage ?? 'appearance';
      return (
        <>
          <SettingsNav current={page} />
          <main className="flex min-w-0 flex-1 flex-col">
            {page === 'accounts' ? <AccountsPage /> : <AppearancePage />}
          </main>
        </>
      );
    }
    case 'new':
      return <NewScreen cwd={state.cwd} isPickerOpen={state.isModelPickerOpen} />;
    case 'empty':
      if (store.empty.repos.length === 0) return <NewScreen />;
      return (
        <>
          {isSidebarOpen && <Sidebar data={{ ...store.sidebar, repos: [] }} />}
          <main className="flex min-w-0 flex-1 flex-col">
            <Header
              onToggleSidebar={() => {
                setIsSidebarOpen(!isSidebarOpen);
              }}
            />
            <EmptyWelcome empty={store.empty} />
          </main>
        </>
      );
  }
}

export function App() {
  const state = useRouteState();
  const store = useStore();
  useShortcuts(state);
  return (
    <div className="flex h-full overflow-hidden bg-background">
      <Screen key={`${state.route}/${state.sessionId ?? ''}`} state={state} />
      {state.isPaletteOpen && (
        <CommandPalette
          repos={store.sidebar.repos}
          initialQuery={state.paletteQuery}
          onClose={() => {
            navigate(state.route, { sessionId: state.sessionId });
          }}
        />
      )}
    </div>
  );
}
