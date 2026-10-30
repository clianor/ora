import { homedir } from 'node:os';
import { join } from 'node:path';

/** `ORA_HOME` 환경변수가 있으면 그 경로를, 없으면 홈 디렉터리 아래 `.ora`를 Ora 홈으로 쓴다 (SPEC 4.5절). */
export function resolveOraHome(env: NodeJS.ProcessEnv): string {
  return env.ORA_HOME ?? join(homedir(), '.ora');
}

/** 맨 앞 `~`를 홈 디렉터리로 푼다. `~`로 시작하지 않는 경로는 그대로 돌려준다. */
export function expandHomePath(path: string): string {
  return path === '~' || path.startsWith('~/') ? `${homedir()}${path.slice(1)}` : path;
}
