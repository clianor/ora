/** 키보드 단축키의 정본 목록입니다. 설정 › 키보드 단축키 화면과 실제 키 처리(App, WorktreeScreen, CommandPalette)가 이 목록 하나를 씁니다. */

export type ShortcutId =
  | 'palette'
  | 'history'
  | 'settings'
  | 'todoPanel'
  | 'togglePanel'
  | 'newTab'
  | 'newSession'
  | 'openSessionInTab'
  | 'newTerminal';

type ShortcutGroup = '이동' | '탭' | '화면';

interface Shortcut {
  id: ShortcutId;
  group: ShortcutGroup;
  label: string;
  /** 화면에 보이는 키 조합입니다. */
  keys: string;
  /** ⌘(또는 Ctrl)를 누른 키 입력이 이 단축키인지 가립니다. */
  matches: (event: KeyboardEvent) => boolean;
}

const byKey = (key: string) => (event: KeyboardEvent) => event.key.toLowerCase() === key;

/**
 * 목록 순서가 판정 순서입니다. ⌥⌘B는 ⌥를 누르면 `event.key`가 다른 글자로 바뀌므로 물리 키(`code`)로 가르고, 다른 단축키보다 먼저 봅니다.
 * ⇧⌘T는 ⌘T보다 먼저 봅니다.
 */
export const shortcuts: readonly Shortcut[] = [
  {
    id: 'togglePanel',
    group: '화면',
    label: '오른쪽 패널 열기·접기',
    keys: '⌥⌘B',
    matches: (event) => event.altKey && event.code === 'KeyB',
  },
  { id: 'palette', group: '이동', label: '명령 팔레트', keys: '⌘K', matches: byKey('k') },
  { id: 'history', group: '이동', label: '기록', keys: '⌘Y', matches: byKey('y') },
  { id: 'settings', group: '이동', label: '설정', keys: '⌘,', matches: byKey(',') },
  { id: 'todoPanel', group: '이동', label: '할 일 패널로 이동', keys: '⌘1', matches: byKey('1') },
  {
    id: 'openSessionInTab',
    group: '탭',
    label: '새 탭에서 세션 열기',
    keys: '⇧⌘S',
    matches: (event) => event.shiftKey && event.key.toLowerCase() === 's',
  },
  {
    id: 'newTerminal',
    group: '탭',
    label: '터미널 열기',
    keys: '⇧⌘T',
    matches: (event) => event.shiftKey && event.key.toLowerCase() === 't',
  },
  { id: 'newTab', group: '탭', label: '새 탭', keys: '⌘T', matches: byKey('t') },
  { id: 'newSession', group: '탭', label: '새 세션', keys: '⌘N', matches: byKey('n') },
];

/** ⌘(또는 Ctrl)를 누른 키 입력과 맞는 단축키입니다. `ids`로 받을 단축키를 좁힙니다. */
export function findShortcut(
  event: KeyboardEvent,
  ids: readonly ShortcutId[],
): ShortcutId | undefined {
  if (!event.metaKey && !event.ctrlKey) return undefined;
  return shortcuts.find((shortcut) => ids.includes(shortcut.id) && shortcut.matches(event))?.id;
}

export function shortcutKeys(id: ShortcutId): string {
  return shortcuts.find((shortcut) => shortcut.id === id)?.keys ?? '';
}

/** 명령 팔레트가 떠 있을 때 쓰는 키입니다. */
export const paletteKeys = [
  { action: 'move', label: '위아래로 고르기', keys: '↑ ↓' },
  { action: 'run', label: '실행', keys: '↵' },
  { action: 'close', label: '닫기', keys: 'Esc' },
] as const;

const paletteEventKeys: Record<string, 'up' | 'down' | 'run'> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  Enter: 'run',
};

export function findPaletteAction(key: string): 'up' | 'down' | 'run' | undefined {
  return paletteEventKeys[key];
}
