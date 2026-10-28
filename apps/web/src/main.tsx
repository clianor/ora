import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import 'virtual:ora-tokens.css';
import './app.css';
import { createFixtureStore } from './fixtures.ts';
import './lib/theme.ts';
import { StoreProvider } from './store.tsx';

const container = document.getElementById('root');
if (!container) throw new Error('#root 요소를 찾지 못했습니다.');

// 엔진 연결 전에는 고정 예시 데이터 저장소를 넣습니다. 서버 응답 구현으로 바꾸려면 이 한 줄만 바꿉니다.
const store = createFixtureStore();

createRoot(container).render(
  <StrictMode>
    <StoreProvider store={store}>
      <App />
    </StoreProvider>
  </StrictMode>,
);
