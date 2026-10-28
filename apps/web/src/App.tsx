import { useEffect, useState } from 'react';
import { CommandPalette } from './components/CommandPalette.tsx';
import { Header } from './components/Header.tsx';
import { AppearancePage, SettingsNav } from './components/Settings.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { focusTodoPanel } from './components/TodoPanel.tsx';
import { EmptyWelcome, NewSessionWelcome } from './components/Welcome.tsx';
import { Workbench } from './components/Workbench.tsx';
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

function SessionScreen({ sessionId }: { sessionId: string | undefined }) {
  const store = useStore();
  const view = store.getSession(sessionId ?? store.defaultSessionId ?? '');
  if (!view) {
    return (
      <>
        <Sidebar data={store.sidebar} />
        <main className="flex min-w-0 flex-1 flex-col items-center justify-center gap-1">
          <h1 className="text-sm leading-5 font-semibold text-foreground">
            세션을 찾지 못했습니다
          </h1>
          <p className="text-xs leading-4 text-foreground-subtle">
            사이드바에서 다른 세션을 고릅니다.
          </p>
        </main>
      </>
    );
  }
  return <Workbench sidebar={store.sidebar} view={view} />;
}

function Screen({ state }: { state: RouteState }) {
  const store = useStore();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const toggle = () => {
    setIsSidebarOpen(!isSidebarOpen);
  };
  switch (state.route) {
    case 'session':
      return <SessionScreen sessionId={state.sessionId} />;
    case 'settings':
      return (
        <>
          <SettingsNav />
          <main className="flex min-w-0 flex-1 flex-col">
            <AppearancePage />
          </main>
        </>
      );
    case 'new':
      return (
        <>
          {isSidebarOpen && <Sidebar data={store.sidebar} selectedWorktree="ora/main" />}
          <main className="flex min-w-0 flex-1 flex-col">
            <Header title="새 세션" repoLabel="ora · main" onToggleSidebar={toggle} />
            <NewSessionWelcome context={store.newSession} />
          </main>
        </>
      );
    case 'empty':
      return (
        <>
          {isSidebarOpen && <Sidebar data={{ ...store.sidebar, repos: [] }} />}
          <main className="flex min-w-0 flex-1 flex-col">
            <Header onToggleSidebar={toggle} />
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
