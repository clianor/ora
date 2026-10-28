import { createContext, useContext, type ReactNode } from 'react';
import type { OraActions, OraStore } from './model.ts';

const StoreContext = createContext<OraStore | null>(null);

export function StoreProvider({ store, children }: { store: OraStore; children: ReactNode }) {
  return <StoreContext value={store}>{children}</StoreContext>;
}

export function useStore(): OraStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('StoreProvider 안에서만 저장소를 쓸 수 있습니다.');
  return store;
}

export function useActions(): OraActions {
  return useStore().actions;
}

/** 화면 이벤트 핸들러가 비동기 요청을 보낼 때 실패를 콘솔에 남깁니다. */
export function runAction(request: Promise<void>): void {
  request.catch((error: unknown) => {
    console.error(error);
  });
}
