import { useSyncExternalStore } from 'react';

export type Route = 'session' | 'new' | 'empty' | 'settings';

export interface RouteState {
  route: Route;
  /** `#/session/<세션 ID>`의 세션 ID입니다. 없으면 저장소가 정한 기본 세션을 엽니다. */
  sessionId?: string;
  /** `#/new?cwd=<경로>`의 작업 폴더입니다. 없으면 서버 기본 폴더입니다. */
  cwd?: string;
  isPaletteOpen: boolean;
  paletteQuery: string;
}

const fixedRoutes: readonly string[] = ['new', 'empty', 'settings'];

/**
 * `#/session/<ID>`, `#/new`, `#/empty`, `#/settings`, `#/palette?q=검색어`(기본 세션 위에 팔레트)를 읽습니다.
 * `?palette=1`은 어느 화면에서든 팔레트를 엽니다. 그 밖의 한 단계 경로(`#/question` 등)는 세션 ID로 봅니다.
 */
function parseHash(hash: string): RouteState {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(query);
  const paletteQuery = params.get('q') ?? '';
  const [first = '', second] = path.split('/');
  if (first === 'palette') return { route: 'session', isPaletteOpen: true, paletteQuery };
  const isPaletteOpen = params.get('palette') === '1';
  if (fixedRoutes.includes(first)) {
    return {
      route: first as Route,
      cwd: params.get('cwd') ?? undefined,
      isPaletteOpen,
      paletteQuery,
    };
  }
  const sessionId = first === 'session' || first === '' ? second : first;
  return { route: 'session', sessionId, isPaletteOpen, paletteQuery };
}

export function hashFor(route: Route, options: { sessionId?: string; cwd?: string } = {}): string {
  if (route === 'session' && options.sessionId) return `#/session/${options.sessionId}`;
  if (route === 'new' && options.cwd) return `#/new?cwd=${encodeURIComponent(options.cwd)}`;
  return `#/${route}`;
}

export function navigate(
  route: Route,
  options: { sessionId?: string; cwd?: string; isPaletteOpen?: boolean } = {},
): void {
  const base = hashFor(route, options);
  const joiner = base.includes('?') ? '&' : '?';
  window.location.hash = options.isPaletteOpen ? `${base}${joiner}palette=1` : base;
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
