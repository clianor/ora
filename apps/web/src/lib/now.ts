import { useSyncExternalStore } from 'react';

const tickMs = 1000;

function subscribe(listener: () => void): () => void {
  const timer = setInterval(listener, tickMs);
  return () => {
    clearInterval(timer);
  };
}

const getSecond = (): number => Math.floor(Date.now() / tickMs) * tickMs;

/** 1초마다 갱신하는 현재 시각(epoch ms)입니다. 남은 시간 표시처럼 시계를 따라가는 글자에 씁니다. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSecond);
}

/** 사이드바 세션 줄의 경과 시간입니다. 1분 미만은 "방금", 그 뒤는 분, 시간, 일 단위로 줄여 적습니다. */
export function formatShortElapsed(startedAt: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 60_000));
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${String(minutes)}분`;
  if (minutes < 1440) return `${String(Math.floor(minutes / 60))}시간`;
  return `${String(Math.floor(minutes / 1440))}일`;
}
