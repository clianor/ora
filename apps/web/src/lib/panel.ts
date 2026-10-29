import { useSyncExternalStore } from 'react';

export type PanelTab = 'todo' | 'changes';

interface PanelState {
  isOpen: boolean;
  /** 사용자가 알약 탭으로 직접 고른 탭입니다. 저장하지 않으므로 새로 열면 비어 있습니다. */
  pickedTab?: PanelTab;
}

// 접힘 상태는 테마(`ora-theme`)처럼 localStorage에 저장해 새로 열어도 유지합니다.
const storageKey = 'ora-right-panel';
const listeners = new Set<() => void>();

// 저장소 접근이 막힌 환경(시크릿 모드, 정책)에서는 저장하지 않고 열린 상태로 동작합니다.
function readIsOpen(): boolean {
  // 시안 확인용 `&panel=closed` 주소는 저장한 접힘 상태를 건드리지 않고 이번에만 접습니다.
  if (window.location.hash.includes('panel=closed')) return false;
  try {
    return localStorage.getItem(storageKey) !== 'closed';
  } catch {
    return true;
  }
}

let state: PanelState = { isOpen: readIsOpen() };

function commit(next: PanelState): void {
  state = next;
  listeners.forEach((listener) => {
    listener();
  });
}

export function setPanelOpen(isOpen: boolean): void {
  try {
    localStorage.setItem(storageKey, isOpen ? 'open' : 'closed');
  } catch {
    // 저장하지 못해도 이 탭에는 바로 적용합니다.
  }
  commit({ ...state, isOpen });
}

export function togglePanel(): void {
  setPanelOpen(!state.isOpen);
}

export function pickPanelTab(pickedTab: PanelTab): void {
  commit({ ...state, pickedTab });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePanelState(): PanelState {
  return useSyncExternalStore(subscribe, () => state);
}
