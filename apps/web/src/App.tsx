import { useEffect, useState } from 'react';
import { CommandPalette } from './components/CommandPalette.tsx';
import { Header } from './components/Header.tsx';
import { AccountsPage } from './components/Accounts.tsx';
import { HistoryScreen } from './components/History.tsx';
import { AppearancePage, SettingsNav } from './components/Settings.tsx';
import { McpPage } from './components/McpPage.tsx';
import { SkillsPage } from './components/SkillsPage.tsx';
import { MemoryPage } from './components/MemoryPage.tsx';
import { GeneralPage, IsolationPage, KeysPage } from './components/EngineSettings.tsx';
import { ModelsPage } from './components/ModelsPage.tsx';
import { PermissionsPage } from './components/PermissionsPage.tsx';
import { CostPage, NotificationsPage } from './components/SettingsPages.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { focusTodoPanel } from './components/RightPanel.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { EmptyWelcome } from './components/Welcome.tsx';
import { WorktreeScreen } from './components/WorktreeScreen.tsx';
import { togglePanel } from './lib/panel.ts';
import { navigate, setPaletteOpen, useRouteState, type RouteState } from './lib/route.ts';
import { findShortcut } from './lib/shortcuts.ts';
import { useDesktopNotifications } from './lib/notify.ts';
import { useStore } from './store.tsx';

function useShortcuts(state: RouteState) {
  /** 창 전체에서 키보드 단축키(⌘K, ⌘Y, ⌘,, ⌘1, ⌥⌘B)를 받으려면 window 이벤트를 구독해야 합니다. */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const id = findShortcut(event, [
        'togglePanel',
        'palette',
        'history',
        'settings',
        'todoPanel',
      ]);
      if (id === undefined) return;
      event.preventDefault();
      if (id === 'togglePanel') togglePanel();
      else if (id === 'palette') setPaletteOpen(!state.isPaletteOpen);
      else if (id === 'history') navigate('history');
      else if (id === 'settings') navigate('settings');
      else focusTodoPanel();
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
            {page === 'general' && <GeneralPage />}
            {page === 'keys' && <KeysPage />}
            {page === 'models' && <ModelsPage />}
            {page === 'permissions' && <PermissionsPage />}
            {page === 'isolation' && <IsolationPage />}
            {page === 'cost' && <CostPage />}
            {page === 'notifications' && <NotificationsPage />}
            {page === 'mcp' && <McpPage />}
            {page === 'skills' && <SkillsPage cwd={state.cwd} />}
            {page === 'memory' && <MemoryPage cwd={state.cwd} />}
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
