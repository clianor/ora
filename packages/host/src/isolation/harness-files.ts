import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const HARNESS_FILE_NAMES = ['.claude', '.agents', '.pi', 'AGENTS.md', 'CLAUDE.md'];

/** 작업 폴더에서 git 저장소 루트까지 위로 올라가며 본 디렉터리다. 저장소가 아니면 작업 폴더만 본다. 저장소 루트에 가까운 쪽이 앞에 온다. */
export function listSearchDirs(cwd: string, gitRoot: string | undefined): string[] {
  if (gitRoot === undefined) return [cwd];
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    dirs.unshift(dir);
    if (dir === gitRoot || dirname(dir) === dir) return dirs;
  }
}

/** `clean-home` 세션이 시작할 때 작업 폴더에 있는 하네스 파일과 디렉터리를 저장소 루트 기준 상대 경로로 돌려준다 (SPEC 5.6절). */
export function findHarnessFiles(cwd: string, gitRoot: string | undefined): string[] {
  return listSearchDirs(cwd, gitRoot).flatMap((dir) =>
    HARNESS_FILE_NAMES.filter((name) => existsSync(join(dir, name))).map(
      (name) => relative(gitRoot ?? cwd, join(dir, name)) || name,
    ),
  );
}
