import { useSyncExternalStore } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';

// index.html의 인라인 스크립트가 같은 키를 읽어 첫 화면을 그리기 전에 모드를 적용합니다.
const storageKey = 'ora-theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

// 저장소 접근이 막힌 환경(시크릿 모드, 정책)에서는 저장하지 않고 system으로 동작합니다.
function readMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(storageKey);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

let mode = readMode();

function applyMode(): void {
  const isDark = mode === 'dark' || (mode === 'system' && media.matches);
  document.documentElement.classList.toggle('dark', isDark);
}

applyMode();
// 시스템 모드는 OS 설정이 바뀌면 바로 반영합니다.
media.addEventListener('change', applyMode);

function notify(): void {
  listeners.forEach((listener) => {
    listener();
  });
}

export function setThemeMode(next: ThemeMode): void {
  mode = next;
  try {
    localStorage.setItem(storageKey, next);
  } catch {
    // 저장하지 못해도 이 탭에는 바로 적용합니다.
  }
  applyMode();
  notify();
}

// 다른 탭이 모드를 바꾸면 이 탭도 맞춥니다.
window.addEventListener('storage', (event) => {
  if (event.key !== null && event.key !== storageKey) return;
  mode = readMode();
  applyMode();
  notify();
});

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribe, () => mode);
}
