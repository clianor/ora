import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { OraActions, OraStore, OraStoreSource } from './model.ts';

const StoreContext = createContext<OraStoreSource | null>(null);

export function StoreProvider({
  source,
  children,
}: {
  source: OraStoreSource;
  children: ReactNode;
}) {
  return <StoreContext value={source}>{children}</StoreContext>;
}

/** 저장소의 현재 시점을 읽습니다. 저장소가 바뀌면 이 훅을 쓰는 화면이 다시 그려집니다. */
export function useStore(): OraStore {
  const source = useContext(StoreContext);
  if (!source) throw new Error('StoreProvider 안에서만 저장소를 쓸 수 있습니다.');
  return useSyncExternalStore(source.subscribe, source.getSnapshot);
}

export function useActions(): OraActions {
  return useStore().actions;
}

/** 화면 이벤트 핸들러가 비동기 요청을 보낼 때 실패를 콘솔에 남깁니다. */
export function runAction(request: Promise<unknown>): void {
  request.catch((error: unknown) => {
    console.error(error);
  });
}
