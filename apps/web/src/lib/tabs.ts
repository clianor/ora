import type { WorktreeTab, WorktreeTabs } from '@ora/protocol';
import { clearComposerDraft } from './composerDraft.ts';
import type { OraActions } from '../model.ts';
import { runAction } from '../store.tsx';
import { navigate } from './route.ts';

/** 탭을 바꾸는 동작이 함께 읽는 값입니다. `activeTabId`는 지금 화면에 보이는 탭입니다. */
export interface TabContext {
  actions: OraActions;
  cwd: string;
  tabs: WorktreeTabs;
  activeTabId?: string;
}

const defaultTerminalSize = { cols: 100, rows: 30 };

function createTabId(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 10);
}

/** 탭을 저장하고 그 탭을 엽니다. 같은 ID의 탭이 있으면 그 자리를 바꾸고, 없으면 맨 뒤에 더합니다. */
function placeTab(context: TabContext, tab: WorktreeTab, isSessionMode = false): void {
  const exists = context.tabs.tabs.some((item) => item.id === tab.id);
  const tabs = exists
    ? context.tabs.tabs.map((item) => (item.id === tab.id ? tab : item))
    : [...context.tabs.tabs, tab];
  runAction(context.actions.saveTabs(context.cwd, { tabs, activeTabId: tab.id }));
  navigate('worktree', { cwd: context.cwd, tabId: tab.id, isSessionMode });
}

/** 그 세션의 탭이 이미 있으면 그 탭을 열고, 없으면 맨 뒤에 탭을 더해 엽니다. */
export function openSessionTab(context: TabContext, sessionId: string): void {
  const existing = context.tabs.tabs.find(
    (tab) => tab.kind === 'session' && tab.sessionId === sessionId,
  );
  placeTab(context, existing ?? { id: createTabId(), kind: 'session', sessionId });
}

export function openNewTab(context: TabContext, isSessionMode = false): void {
  placeTab(
    context,
    { id: createTabId(), kind: 'new', ...(isSessionMode ? { isSessionMode: true } : {}) },
    isSessionMode,
  );
}

/** 고르기 화면의 새 탭을 세션 모드(입력창이 보이는 상태)로 바꿔 저장하고 엽니다. 탭이 아직 없으면 주소로만 엽니다. */
export function openSessionMode(context: TabContext, tabId: string | undefined): void {
  if (tabId === undefined) {
    navigate('worktree', { cwd: context.cwd, isSessionMode: true });
    return;
  }
  const tabs = context.tabs.tabs.map((tab) =>
    tab.id === tabId && tab.kind === 'new' ? { ...tab, isSessionMode: true } : tab,
  );
  runAction(context.actions.saveTabs(context.cwd, { tabs, activeTabId: tabId }));
  navigate('worktree', { cwd: context.cwd, tabId, isSessionMode: true });
}

/** 새 탭(또는 `tabId`가 없을 때 맨 뒤의 새 탭)을 세션 탭으로 바꿉니다. */
export function turnIntoSessionTab(
  context: TabContext,
  tabId: string | undefined,
  sessionId: string,
): void {
  placeTab(context, { id: tabId ?? createTabId(), kind: 'session', sessionId });
}

/** 서버에서 터미널을 만들어 그 탭을 터미널 탭으로 바꿉니다. 끝난 터미널 탭에서 "새로 열기"를 눌러도 같은 동작입니다. */
export async function openTerminalTab(
  context: TabContext,
  tabId: string | undefined,
): Promise<void> {
  const terminalId = await context.actions.createTerminal(context.cwd, defaultTerminalSize);
  placeTab(context, { id: tabId ?? createTabId(), kind: 'terminal', terminalId });
}

export function selectTab(context: TabContext, tabId: string): void {
  runAction(context.actions.saveTabs(context.cwd, { ...context.tabs, activeTabId: tabId }));
  navigate('worktree', { cwd: context.cwd, tabId });
}

/** 탭을 닫습니다. 세션 탭을 닫아도 세션은 멈추지 않습니다. 보고 있던 탭을 닫으면 이웃 탭으로 옮깁니다. */
export function closeTab(context: TabContext, tab: WorktreeTab, shouldKillTerminal: boolean): void {
  clearComposerDraft(tab.id);
  const index = context.tabs.tabs.findIndex((item) => item.id === tab.id);
  const rest = context.tabs.tabs.filter((item) => item.id !== tab.id);
  if (tab.kind === 'terminal' && shouldKillTerminal) {
    runAction(context.actions.killTerminal(tab.terminalId));
  }
  if (tab.id !== context.activeTabId) {
    runAction(context.actions.saveTabs(context.cwd, { ...context.tabs, tabs: rest }));
    return;
  }
  const next = rest[Math.min(index, rest.length - 1)];
  runAction(context.actions.saveTabs(context.cwd, { tabs: rest, activeTabId: next?.id }));
  navigate('worktree', { cwd: context.cwd, tabId: next?.id });
}
