import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Isolation } from '@ora/protocol';

/** `clean-home`에서 자식 프로세스에 넘기는 부모 환경변수다. 이 밖의 변수(API 키 포함)는 넘기지 않는다. */
const CLEAN_HOME_ALLOWED_KEYS = ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'USER'];

/** 격리 루트가 설정에 없으면 Ora 홈 아래 `isolated/`를 쓴다 (SPEC 4.2절, 4.5절). */
export function resolveIsolationRoot(configured: string | null, oraHome: string): string {
  return configured ?? join(oraHome, 'isolated');
}

export interface ChildEnvOptions {
  readonly isolation: Isolation;
  readonly parentEnv: NodeJS.ProcessEnv;
  readonly isolationRoot: string;
}

/**
 * 셸 도구와 검증 명령이 띄우는 자식 프로세스의 환경을 만든다 (SPEC 5.6절).
 * 사용자 설정 폴더는 복사하지도 고치지도 않는다. 환경변수로 도구가 Ora의 빈 격리 폴더를 쓰게 할 뿐이다.
 * `HOME`을 다루는 코드는 이 모듈에만 둔다.
 */
export function createChildEnv(options: ChildEnvOptions): NodeJS.ProcessEnv {
  const { isolation, parentEnv, isolationRoot } = options;
  if (isolation === 'none') return { ...parentEnv };

  const dir = (name: string): string => {
    const path = join(isolationRoot, name);
    mkdirSync(path, { recursive: true });
    return path;
  };
  // Codex는 `CODEX_HOME`을 따른다 (공식 문서 environment-variables 페이지).
  const harnessOverrides = {
    CLAUDE_CONFIG_DIR: dir('claude'),
    PI_CODING_AGENT_DIR: dir('pi-agent'),
    CODEX_HOME: dir('codex'),
  };
  if (isolation === 'harness') return { ...parentEnv, ...harnessOverrides };
  const allowed = Object.fromEntries(
    CLEAN_HOME_ALLOWED_KEYS.flatMap((key) => {
      const value = parentEnv[key];
      return value === undefined ? [] : [[key, value] as const];
    }),
  );
  return {
    ...allowed,
    ...harnessOverrides,
    HOME: dir('home'),
    XDG_CONFIG_HOME: dir('home/.config'),
    XDG_DATA_HOME: dir('home/.local/share'),
    XDG_STATE_HOME: dir('home/.local/state'),
    XDG_CACHE_HOME: dir('home/.cache'),
  };
}
