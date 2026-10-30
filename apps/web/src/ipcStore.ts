import { createHttpStore, type StoreTransport } from './httpStore.ts';
import type { OraStoreSource } from './model.ts';

/** 흐름 하나가 preload를 거쳐 오는 메시지입니다. 이벤트는 메인 프로세스가 묶어서 보냅니다. */
type BridgeStreamMessage =
  | { kind: 'open' }
  | { kind: 'items'; items: { name?: string; data: unknown }[] }
  | { kind: 'end' }
  | { kind: 'error'; status: number; message: string };

/** preload가 `contextBridge`로 노출하는 API입니다. `apps/desktop/src/preload/index.ts`가 같은 모양을 구현합니다. */
export interface OraBridge {
  request(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  subscribe(path: string, listener: (message: BridgeStreamMessage) => void): () => void;
}

declare global {
  interface Window {
    /** Electron preload가 있을 때만 있습니다. */
    ora?: OraBridge;
  }
}

function createIpcTransport(bridge: OraBridge): StoreTransport {
  return {
    request: (path, init) => bridge.request(init?.method ?? 'GET', path, init?.body),
    openStream: (path, handlers) => {
      let isClosed = false;
      const unsubscribe = bridge.subscribe(path, (message) => {
        if (isClosed) return;
        if (message.kind === 'open') handlers.onOpen();
        else if (message.kind === 'items') {
          for (const item of message.items) handlers.onMessage(item.name, item.data);
        } else {
          isClosed = true;
          if (message.kind === 'error') handlers.onError();
        }
      });
      return {
        close: () => {
          isClosed = true;
          unsubscribe();
        },
        get isClosed() {
          return isClosed;
        },
      };
    },
  };
}

/** Electron preload가 노출한 IPC로 엔진 호스트와 통신하는 저장소입니다. 로컬 HTTP 서버를 거치지 않습니다. */
export function createIpcStore(bridge: OraBridge): OraStoreSource {
  return createHttpStore(createIpcTransport(bridge));
}
