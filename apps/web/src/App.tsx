import { useEffect, useState } from 'react';
import { CommandPalette } from './components/CommandPalette.tsx';
import { Header } from './components/Header.tsx';
import { AccountsPage } from './components/Accounts.tsx';
import { HistoryScreen } from './components/History.tsx';
import { AppearancePage, SettingsNav } from './components/Settings.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { focusTodoPanel } from './components/TodoPanel.tsx';
import { EmptyWelcome } from './components/Welcome.tsx';
import { WorktreeScreen } from './components/WorktreeScreen.tsx';
import { navigate, setPaletteOpen, useRouteState, type RouteState } from './lib/route.ts';
import { useStore } from './store.tsx';

function useShortcuts(state: RouteState) {
  /** 창 전체에서 키보드 단축키(⌘K, ⌘Y, ⌘,, ⌘1)를 받으려면 window 이벤트를 구독해야 합니다. */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.key === 'k') {
        event.preventDefault();
        setPaletteOpen(!state.isPaletteOpen);
      } else if (event.key === 'y') {
        event.preventDefault();
        navigate('history');
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
  }, [state.isPaletteOpen]);
}

function Screen({ state }: { state: RouteState }) {
  const store = useStore();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  switch (state.route) {
    case 'worktree':
      return <WorktreeScreen state={state} />;
    case 'history':
      return <HistoryScreen />;
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
    case 'empty':
      if (store.empty.repos.length === 0) {
        return (
          <WorktreeScreen state={{ route: 'worktree', isPaletteOpen: false, paletteQuery: '' }} />
        );
      }
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
      <Screen key={state.route} state={state} />
      {state.isPaletteOpen && (
        <CommandPalette
          repos={store.sidebar.repos}
          initialQuery={state.paletteQuery}
          onClose={() => {
            setPaletteOpen(false);
          }}
        />
      )}
    </div>
  );
}
