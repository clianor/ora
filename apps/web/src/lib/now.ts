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
