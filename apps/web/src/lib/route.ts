import { useSyncExternalStore } from 'react';

export type Route = 'worktree' | 'history' | 'empty' | 'settings';

export type SettingsPage = 'appearance' | 'accounts' | 'cost' | 'notifications' | 'mcp' | 'skills';

const settingsPages: readonly string[] = ['accounts', 'cost', 'notifications', 'mcp', 'skills'];

export interface RouteState {
  route: Route;
  /** `#/worktree?cwd=<경로>`의 작업 폴더입니다. 없으면 세션이 속한 워크트리, 그것도 없으면 서버 기본 폴더입니다. */
  cwd?: string;
  /** `&tab=<탭 ID>`의 탭입니다. 없으면 마지막으로 고른 탭을 엽니다. */
  tabId?: string;
  /** `#/session/<세션 ID>`의 세션 ID입니다. 그 세션이 속한 워크트리의 탭 화면으로 이어집니다. */
  sessionId?: string;
  /** `&mode=session`은 새 탭에서 "세션"을 고른 상태입니다. */
  isSessionMode?: boolean;
  /** `#/settings/accounts`, `#/settings/cost`, `#/settings/notifications`, `#/settings/mcp`는 각 페이지이고, 그 밖의 `#/settings`는 모양 페이지입니다. */
  settingsPage?: SettingsPage;
  /** `&picker=1`은 새 세션 화면에서 모델 고르기 팝오버를 연 채로 엽니다. */
  isModelPickerOpen?: boolean;
  isPaletteOpen: boolean;
  paletteQuery: string;
}

const fixedRoutes: readonly string[] = ['history', 'empty', 'settings'];

/**
 * `#/worktree?cwd=&tab=`, `#/history`, `#/empty`, `#/settings`, `#/palette?q=검색어`를 읽습니다.
 * `#/session/<ID>`와 그 밖의 한 단계 경로(`#/question` 등)는 세션 ID로 보고, 빈 경로는 기본 세션을 가리킵니다.
 * `?palette=1`은 어느 화면에서든 팔레트를 엽니다.
 */
function parseHash(hash: string): RouteState {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(query);
  const paletteQuery = params.get('q') ?? '';
  const [first = '', second] = path.split('/');
  if (first === 'palette') return { route: 'worktree', isPaletteOpen: true, paletteQuery };
  const isPaletteOpen = params.get('palette') === '1';
  if (fixedRoutes.includes(first)) {
    return {
      route: first as Route,
      settingsPage:
        first === 'settings' && second !== undefined && settingsPages.includes(second)
          ? (second as SettingsPage)
          : 'appearance',
      cwd: params.get('cwd') ?? undefined,
      isPaletteOpen,
      paletteQuery,
    };
  }
  if (first === 'worktree') {
    return {
      route: 'worktree',
      cwd: params.get('cwd') ?? undefined,
      tabId: params.get('tab') ?? undefined,
      isSessionMode: params.get('mode') === 'session' || params.get('picker') === '1',
      isModelPickerOpen: params.get('picker') === '1',
      isPaletteOpen,
      paletteQuery,
    };
  }
  const sessionId = first === 'session' || first === '' ? second : first;
  return { route: 'worktree', sessionId, isPaletteOpen, paletteQuery };
}

interface HashOptions {
  sessionId?: string;
  cwd?: string;
  tabId?: string;
  isSessionMode?: boolean;
}

export function hashFor(route: Route, options: HashOptions = {}): string {
  if (route === 'worktree' && options.cwd) {
    const params = new URLSearchParams({ cwd: options.cwd });
    if (options.tabId) params.set('tab', options.tabId);
    if (options.isSessionMode) params.set('mode', 'session');
    return `#/worktree?${params.toString()}`;
  }
  if (route === 'worktree' && options.sessionId) return `#/session/${options.sessionId}`;
  return `#/${route}`;
}

export function navigate(
  route: Route,
  options: HashOptions & { isPaletteOpen?: boolean } = {},
): void {
  const base = hashFor(route, options);
  const joiner = base.includes('?') ? '&' : '?';
  window.location.hash = options.isPaletteOpen ? `${base}${joiner}palette=1` : base;
}

export function navigateToSettings(page: SettingsPage): void {
  window.location.hash = `#/settings/${page}`;
}

/** 지금 주소에 `palette=1`을 더하거나 뺍니다. 팔레트는 어느 화면 위에도 뜹니다. */
export function setPaletteOpen(isOpen: boolean): void {
  const [path = '', query = ''] = window.location.hash.split('?');
  const params = new URLSearchParams(query);
  params.delete('palette');
  params.delete('q');
  if (isOpen) params.set('palette', '1');
  const rest = params.toString();
  window.location.hash = rest === '' ? path : `${path}?${rest}`;
}

function subscribe(listener: () => void): () => void {
  window.addEventListener('hashchange', listener);
  return () => {
    window.removeEventListener('hashchange', listener);
  };
}

let cachedHash = '';
let cachedState = parseHash(cachedHash);

function getSnapshot(): RouteState {
  const hash = window.location.hash;
  if (hash !== cachedHash) {
    cachedHash = hash;
    cachedState = parseHash(hash);
  }
  return cachedState;
}

export function useRouteState(): RouteState {
  return useSyncExternalStore(subscribe, getSnapshot);
}
