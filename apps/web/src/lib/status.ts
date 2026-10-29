import type { PermissionMode, SessionStatus } from '@ora/protocol';

/** 세션 상태를 화면에 적는 글자입니다. 상태 점의 색과 함께 글자로도 상태를 알립니다. */
export const statusLabel: Record<SessionStatus, string> = {
  created: '준비 중',
  running: '실행 중',
  awaiting_approval: '승인 대기',
  awaiting_user: '답변 대기',
  interrupted: '중간에 멈춤',
  completed: '완료',
  stopped: '중지됨',
  failed: '실패',
  crashed: '중간에 멈춤, 재개 가능',
  merge_pending: '병합 대기',
  conflicted: '충돌',
  merged: '병합됨',
  archived: '보관됨',
};

/** 권한 모드를 입력창 칩에 적는 글자입니다(SPEC 5.1절). */
export const permissionLabel: Record<PermissionMode, string> = {
  'always-ask': '항상 묻기',
  write: '쓰기 허용',
  'bypass-permissions': '승인 생략',
};

/** 같은 폴더에서 동시에 도는 세션으로 세는 상태입니다. */
export const runningStatuses = new Set<SessionStatus>([
  'created',
  'running',
  'awaiting_approval',
  'awaiting_user',
]);

export const historyFilters = ['전체', '실행 중', '승인 대기', '완료', '실패·멈춤'] as const;
export type HistoryFilter = (typeof historyFilters)[number];

export type StatusKind = '실행 중' | '승인 대기' | '완료' | '실패' | '멈춤';

/** 아이콘과 색을 정하는 분류입니다. 새 상태를 더하면 여기서 컴파일이 깨집니다. */
export const statusKindOf: Record<SessionStatus, StatusKind> = {
  created: '실행 중',
  running: '실행 중',
  awaiting_approval: '승인 대기',
  awaiting_user: '승인 대기',
  interrupted: '멈춤',
  completed: '완료',
  stopped: '멈춤',
  failed: '실패',
  crashed: '멈춤',
  merge_pending: '완료',
  conflicted: '실패',
  merged: '완료',
  archived: '완료',
};

export function matchesHistoryFilter(filter: HistoryFilter, status: SessionStatus): boolean {
  const kind = statusKindOf[status];
  if (filter === '실패·멈춤') return kind === '실패' || kind === '멈춤';
  return filter === '전체' || filter === kind;
}

const shortStatusText: Record<SessionStatus, string> = {
  created: '실행 중',
  running: '실행 중',
  awaiting_approval: '승인 대기',
  awaiting_user: '답변 대기',
  interrupted: '멈춤',
  completed: '완료',
  stopped: '멈춤',
  failed: '실패',
  crashed: '멈춤',
  merge_pending: '완료',
  conflicted: '실패',
  merged: '완료',
  archived: '완료',
};

/** 기록 줄의 짧은 상태 글자입니다. 엔진이 막혀서 멈췄으면 "막혀서 멈춤"입니다. 자세한 설명은 `statusLabel`을 `title`에 씁니다. */
export function getShortStatusText(status: SessionStatus, endReason: string | undefined): string {
  return status === 'stopped' && endReason === 'blocked' ? '막혀서 멈춤' : shortStatusText[status];
}
