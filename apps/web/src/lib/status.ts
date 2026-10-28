import type { SessionStatus } from '@ora/protocol';

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
