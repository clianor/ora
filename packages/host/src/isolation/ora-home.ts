import { homedir } from 'node:os';
import { join } from 'node:path';

/** `ORA_HOME` 환경변수가 있으면 그 경로를, 없으면 홈 디렉터리 아래 `.ora`를 Ora 홈으로 쓴다 (SPEC 4.5절). */
export function resolveOraHome(env: NodeJS.ProcessEnv): string {
  return env.ORA_HOME ?? join(homedir(), '.ora');
}
