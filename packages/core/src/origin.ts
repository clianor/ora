import type { Evidence } from '@ora/protocol';

/** 파일의 절대 경로에서 `크기:수정시각`으로 가는 표다. 내용은 읽지 않는다. */
export type FileStamps = Readonly<Record<string, string>>;

export interface OriginInput {
  readonly command: string;
  readonly cwd: string;
  /** 첫 작업 요청, 이후 사용자 메시지, 조향의 원문이다. */
  readonly instructions: readonly string[];
  /** 파일 도구가 처음 고치기 직전의 내용이다. `null`은 그때 없던 파일이다. */
  readonly baselines: Readonly<Record<string, string | null>>;
  /** 세션 시작 시점의 표다. 없으면(재개한 세션) 바뀌었는지 알 수 없다. */
  readonly start?: FileStamps;
  readonly current: FileStamps;
}

function resolvePath(cwd: string, token: string): string {
  const parts: string[] = [];
  for (const part of `${token.startsWith('/') ? '' : `${cwd}/`}${token}`.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '' && part !== '.') parts.push(part);
  }
  return `/${parts.join('/')}`;
}

const SCRIPT_COMMAND = /(?:^|[\s;&|])(?:npm|pnpm|yarn|bun)\s+(?:run\s+\S+|test|t)(?=\s|$)/;
/** 파일 인자 없이 기본 패턴으로 테스트 파일을 찾는 명령이다. 대상을 알려면 폴더를 훑어야 한다. */
export const NODE_TEST = /(?:^|[\s;&|])node\s(?:[^;&|]*\s)?--test(?=\s|$)/;
const NODE_TEST_FILE =
  /(?:^|\/)(?:(?:.*[-_.])?test\.[cm]?js|test-[^/]*\.[cm]?js)$|(?:^|\/)test\/.*\.[cm]?js$/;

/** 명령이 가리킬 수 있는 파일의 절대 경로다. 실제로 있는지는 호출하는 쪽이 `stat`으로 거른다. */
export function commandCandidates(command: string, cwd: string): string[] {
  const paths = command
    .split(/\s+/)
    .map((raw) => raw.replace(/^["']+|["']+$/g, ''))
    .filter((token) => token !== '' && !token.startsWith('-'))
    .map((token) => resolvePath(cwd, token));
  if (SCRIPT_COMMAND.test(command)) paths.push(`${resolvePath(cwd, '.')}/package.json`);
  return paths;
}

/** 명령 토큰 가운데 작업 폴더 안에 실제로 있는 파일과, 스크립트 명령의 `package.json`이다. 파일 인자가 없는 `node --test`는 기본 테스트 파일 패턴으로 찾는다. */
export function findCommandFiles(command: string, cwd: string, current: FileStamps): string[] {
  const found = new Set<string>();
  for (const raw of command.split(/\s+/)) {
    const token = raw.replace(/^["']+|["']+$/g, '');
    if (token === '' || token.startsWith('-')) continue;
    const path = resolvePath(cwd, token);
    if (Object.hasOwn(current, path)) found.add(path);
  }
  const root = resolvePath(cwd, '.');
  if (SCRIPT_COMMAND.test(command) && Object.hasOwn(current, `${root}/package.json`)) {
    found.add(`${root}/package.json`);
  }
  if (found.size === 0 && NODE_TEST.test(command)) {
    for (const path of Object.keys(current)) {
      if (path.startsWith(`${root}/`) && NODE_TEST_FILE.test(path.slice(root.length + 1))) {
        found.add(path);
      }
    }
  }
  return [...found];
}

export function classifyOrigin(input: OriginInput): Evidence['origin'] {
  const command = input.command.trim();
  if (input.instructions.some((text) => text.includes(command))) return 'user';
  const { start } = input;
  if (start === undefined) return 'model';
  const files = findCommandFiles(command, input.cwd, input.current);
  if (files.length === 0) return 'model';
  const untouched = files.every(
    (path) =>
      !Object.hasOwn(input.baselines, path) &&
      start[path] !== undefined &&
      start[path] === input.current[path],
  );
  return untouched ? 'repo' : 'model';
}
