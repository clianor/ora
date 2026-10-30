import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import 'virtual:ora-tokens.css';
import './app.css';
import { createFixtureStore } from './fixtures.ts';
import { createHttpStore } from './httpStore.ts';
import { createIpcStore } from './ipcStore.ts';
import './lib/theme.ts';
import type { OraStoreSource } from './model.ts';
import { StoreProvider } from './store.tsx';

/**
 * Electron preload가 `window.ora`를 노출하면 IPC 저장소를 씁니다.
 * `ora serve`가 제공한 페이지는 `/api/sessions`가 JSON으로 답합니다(토큰이 없으면 401 JSON).
 * Vite 개발 서버처럼 그 경로가 없으면 index.html이 오므로 고정 예시 데이터 저장소를 씁니다.
 */
async function chooseStore(): Promise<OraStoreSource> {
  if (window.ora !== undefined) return createIpcStore(window.ora);
  try {
    const response = await fetch('/api/sessions', { credentials: 'same-origin' });
    if ((response.headers.get('content-type') ?? '').includes('application/json')) {
      return createHttpStore();
    }
  } catch {
    // 서버에 닿지 못하면 고정 예시 데이터로 화면을 보여 줍니다.
  }
  return createFixtureStore();
}

const container = document.getElementById('root');
if (!container) throw new Error('#root 요소를 찾지 못했습니다.');
const root = createRoot(container);

chooseStore()
  .then((source) => {
    root.render(
      <StrictMode>
        <StoreProvider source={source}>
          <App />
        </StoreProvider>
      </StrictMode>,
    );
  })
  .catch((error: unknown) => {
    console.error(error);
  });
