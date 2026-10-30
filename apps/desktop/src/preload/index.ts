import { contextBridge, ipcRenderer } from 'electron';

interface StreamMessage {
  kind: 'open' | 'items' | 'end' | 'error';
}

const listeners = new Map<number, (message: StreamMessage) => void>();
let nextStreamId = 1;

ipcRenderer.on('ora:stream', (_event, id: number, message: StreamMessage) => {
  listeners.get(id)?.(message);
});

// 렌더러에는 이 두 함수만 노출한다. `apps/web/src/ipcStore.ts`의 `OraBridge`가 같은 모양이다.
contextBridge.exposeInMainWorld('ora', {
  request: (method: string, path: string, body?: unknown): Promise<unknown> =>
    ipcRenderer.invoke('ora:request', { method, path, body }),
  subscribe: (path: string, listener: (message: StreamMessage) => void): (() => void) => {
    const id = nextStreamId;
    nextStreamId += 1;
    listeners.set(id, listener);
    ipcRenderer.send('ora:subscribe', id, path);
    return () => {
      listeners.delete(id);
      ipcRenderer.send('ora:unsubscribe', id);
    };
  },
});
