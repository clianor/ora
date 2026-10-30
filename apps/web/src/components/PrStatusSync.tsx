import { useEffect } from 'react';
import { runAction, useStore } from '../store.tsx';

const POLL_MS = 60_000;

/**
 * 저장소마다 PR 상태를 읽습니다. 앱을 열 때 한 번, 창이 앞에 있는 동안 60초마다, 창에 포커스가 돌아올 때 읽습니다.
 * 서버가 GitHub 변경 여부를 조건부 요청으로 먼저 확인하므로 바뀐 것이 없으면 사용 한도를 쓰지 않습니다.
 */
export function PrStatusSync() {
  const { sidebar, actions } = useStore();
  const repoKey = sidebar.repos
    .flatMap((repo) => (repo.path === undefined ? [] : [repo.path]))
    .join('\n');

  /** 창 포커스와 타이머는 브라우저 창 상태라서 렌더 결과로 계산할 수 없고, 이 저장소에는 구독 훅 라이브러리가 없어 effect로 맞춥니다. */
  useEffect(() => {
    const repos = repoKey === '' ? [] : repoKey.split('\n');
    const refreshAll = (mode: 'read' | 'focus') => {
      if (document.visibilityState === 'hidden') return;
      for (const repo of repos) runAction(actions.refreshPrStatus(repo, mode));
    };
    refreshAll('read');
    const timer = setInterval(() => {
      refreshAll('read');
    }, POLL_MS);
    const handleFocus = () => {
      refreshAll('focus');
    };
    window.addEventListener('focus', handleFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', handleFocus);
    };
  }, [actions, repoKey]);

  return null;
}
