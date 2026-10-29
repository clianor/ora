import { useEffect, useState } from 'react';
import { CommandPalette } from './components/CommandPalette.tsx';
import { Header } from './components/Header.tsx';
import { AccountsPage } from './components/Accounts.tsx';
import { HistoryScreen } from './components/History.tsx';
import { AppearancePage, SettingsNav } from './components/Settings.tsx';
import { McpPage } from './components/McpPage.tsx';
import { SkillsPage } from './components/SkillsPage.tsx';
import { CostPage, NotificationsPage } from './components/SettingsPages.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { focusTodoPanel } from './components/RightPanel.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { EmptyWelcome } from './components/Welcome.tsx';
import { WorktreeScreen } from './components/WorktreeScreen.tsx';
import { togglePanel } from './lib/panel.ts';
import { navigate, setPaletteOpen, useRouteState, type RouteState } from './lib/route.ts';
import { useDesktopNotifications } from './lib/notify.ts';
import { useStore } from './store.tsx';

function useShortcuts(state: RouteState) {
  /** 창 전체에서 키보드 단축키(⌘K, ⌘Y, ⌘,, ⌘1, ⌥⌘B)를 받으려면 window 이벤트를 구독해야 합니다. */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      // ⌥를 누르면 event.key가 다른 글자로 바뀌므로 물리 키(code)로 판정합니다.
      if (event.altKey && event.code === 'KeyB') {
        event.preventDefault();
        togglePanel();
      } else if (event.key === 'k') {
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
          <SettingsNav current={page} {...(state.cwd === undefined ? {} : { cwd: state.cwd })} />
          <main className="flex min-w-0 flex-1 flex-col">
            {page === 'accounts' && <AccountsPage />}
            {page === 'cost' && <CostPage />}
            {page === 'notifications' && <NotificationsPage />}
            {page === 'mcp' && <McpPage />}
            {page === 'skills' && <SkillsPage cwd={state.cwd} />}
            {page === 'appearance' && <AppearancePage />}
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
  useDesktopNotifications(store);
  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex min-h-0 flex-1">
        <Screen key={state.route} state={state} />
      </div>
      <StatusBar />
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
