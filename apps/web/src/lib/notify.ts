import { useEffect, useSyncExternalStore } from 'react';
import type { OraEvent } from '@ora/protocol';
import type { OraStore, SessionView } from '../model.ts';
import { navigate } from './route.ts';
import { runningStatuses } from './status.ts';
import { listWorktrees } from './worktrees.ts';

export type NotifyKind = 'approval' | 'question' | 'done' | 'failed' | 'cost';

export const notifyKinds: readonly NotifyKind[] = [
  'approval',
  'question',
  'done',
  'failed',
  'cost',
];

type Prefs = Record<NotifyKind, boolean>;

// 사건별 켜기는 테마(`ora-theme`)와 같이 localStorage에 저장합니다. 저장하지 못하는 환경에서는 모두 켠 채로 이번 탭에만 적용합니다.
const storageKey = 'ora-notify';
const listeners = new Set<() => void>();
const allOn: Prefs = { approval: true, question: true, done: true, failed: true, cost: true };

function readPrefs(): Prefs {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null) return allOn;
    const saved = parsed as Partial<Record<NotifyKind, unknown>>;
    return Object.fromEntries(notifyKinds.map((kind) => [kind, saved[kind] !== false])) as Prefs;
  } catch {
    return allOn;
  }
}

const appStartedAt = Date.now();
const seen = new Map<string, number>();
let prefs = readPrefs();

export function setNotifyEnabled(kind: NotifyKind, isEnabled: boolean): void {
  prefs = { ...prefs, [kind]: isEnabled };
  try {
    localStorage.setItem(storageKey, JSON.stringify(prefs));
  } catch {
    // 저장하지 못해도 이 탭에는 바로 적용합니다.
  }
  listeners.forEach((listener) => {
    listener();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useNotifyPrefs(): Prefs {
  return useSyncExternalStore(subscribe, () => prefs);
}

export type PermissionState = NotificationPermission | 'unsupported';

const permissionListeners = new Set<() => void>();
const readPermission = (): PermissionState =>
  typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
let permission = readPermission();

export function usePermissionState(): PermissionState {
  return useSyncExternalStore(
    (listener) => {
      permissionListeners.add(listener);
      return () => permissionListeners.delete(listener);
    },
    () => permission,
  );
}

export async function requestPermission(): Promise<void> {
  if (typeof Notification === 'undefined') return;
  await Notification.requestPermission();
  permission = readPermission();
  permissionListeners.forEach((listener) => {
    listener();
  });
}

interface NotifyMessage {
  kind: NotifyKind;
  /** 본문 첫 줄에 쓰는 사건 문구입니다. */
  headline: string;
  /** 본문 둘째 줄에 쓰는 세션 제목과 요점입니다. */
  detail: string;
}

/** 알림 제목입니다. 저장소 이름만 씁니다. */
export function formatNotifyTitle(repoLabel: string): string {
  return `Ora · ${repoLabel.split(' · ')[0] ?? repoLabel}`;
}

/** 이벤트 하나가 알릴 사건이면 알림 문구를 만듭니다. 알리지 않는 이벤트는 undefined입니다. */
function describeEvent(event: OraEvent, title: string): NotifyMessage | undefined {
  switch (event.type) {
    case 'approval_request': {
      const { detail } = event.payload;
      const point = detail.kind === 'shell' ? `$ ${detail.command}` : event.payload.tool;
      return { kind: 'approval', headline: '승인이 필요합니다', detail: `${title} · ${point}` };
    }
    case 'question':
      return {
        kind: 'question',
        headline: '질문에 답이 필요합니다',
        detail: `${title} · ${event.payload.questions[0]?.question ?? ''}`,
      };
    case 'cost_guard':
      return event.payload.outcome === 'warn'
        ? {
            kind: 'cost',
            headline: `비용 상한의 ${event.payload.ratioPct}%를 썼습니다`,
            detail: `${title} · 상한에 닿으면 다음 요청을 보내지 않고 멈춥니다`,
          }
        : undefined;
    case 'session_end': {
      const summary = event.payload.summary.split('\n')[0] ?? '';
      const { status } = event.payload;
      if (status === 'completed') {
        return { kind: 'done', headline: '작업을 마쳤습니다', detail: `${title} · ${summary}` };
      }
      if (status === 'failed' || status === 'stopped') {
        return {
          kind: 'failed',
          headline: status === 'failed' ? '작업이 실패했습니다' : '작업이 멈췄습니다',
          detail: `${title} · ${summary}`,
        };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

let isApprovalScrollRequested = false;

/** 알림에서 승인 대기로 들어온 뒤 승인 카드가 나타나면 한 번 스크롤하도록 요청합니다. */
function requestApprovalScroll(): void {
  isApprovalScrollRequested = true;
}

/** 승인 카드를 감싼 요소의 ref 콜백입니다. 요청이 있으면 그 요소로 스크롤하고 요청을 지웁니다. */
export function scrollIfRequested(node: HTMLElement | null): void {
  if (node === null || !isApprovalScrollRequested) return;
  isApprovalScrollRequested = false;
  node.scrollIntoView({ block: 'center' });
}

function isWindowUnseen(): boolean {
  return document.visibilityState !== 'visible' || !document.hasFocus();
}

function sendNotification(message: NotifyMessage, view: SessionView, sessionId: string): void {
  const notification = new Notification(formatNotifyTitle(view.repoLabel), {
    body: `${message.headline}\n${message.detail}`,
    tag: `${sessionId}:${message.kind}`,
  });
  notification.onclick = () => {
    window.focus();
    if (message.kind === 'approval') requestApprovalScroll();
    navigate('worktree', { sessionId });
    notification.close();
  };
}

/** 설정 › 알림의 테스트 알림입니다. 창을 보고 있어도 보냅니다. */
export function sendTestNotification(): void {
  if (readPermission() !== 'granted') return;
  const notification = new Notification('Ora · 테스트', {
    body: '알림이 켜져 있습니다\n알림을 누르면 해당 세션 탭으로 이동합니다',
  });
  notification.onclick = () => {
    window.focus();
    notification.close();
  };
}

/**
 * 진행 중인 세션의 이벤트를 구독해 데스크톱 알림을 보냅니다. 같은 사건은 이벤트 seq로 한 번만 알리고,
 * 앱을 연 시각 이전 이벤트(다시 불러온 지난 기록)는 알리지 않습니다.
 */
export function useDesktopNotifications(store: OraStore): void {
  const current = useNotifyPrefs();
  const { sidebar, watchSession, getSession } = store;
  const liveIds = listWorktrees(sidebar.repos)
    .flatMap(({ node }) => node.sessions)
    .filter((session) => runningStatuses.has(session.record.status))
    .map((session) => session.record.id);
  const watchKey = liveIds.join(',');

  /** 브라우저 Notification API와 세션 이벤트 구독은 React 밖의 시스템이라 효과로 맞춥니다. */
  useEffect(() => {
    const stops = watchKey === '' ? [] : watchKey.split(',').map((id) => watchSession(id));
    return () => {
      stops.forEach((stop) => {
        stop();
      });
    };
  }, [watchKey, watchSession]);

  /** 새 이벤트를 훑는 일은 저장소가 바뀔 때마다 한 번이면 충분해 렌더 뒤에 실행합니다. */
  useEffect(() => {
    if (readPermission() !== 'granted' || !isWindowUnseen()) return;
    for (const id of liveIds) {
      const view = getSession(id);
      if (view === undefined) continue;
      const lastNotified = seen.get(id) ?? 0;
      for (const event of view.events) {
        if (event.seq <= lastNotified) continue;
        seen.set(id, event.seq);
        if (Date.parse(event.ts) < appStartedAt) continue;
        const message = describeEvent(event, view.record.title);
        if (message === undefined || !current[message.kind]) continue;
        sendNotification(message, view, id);
      }
    }
  });
}
