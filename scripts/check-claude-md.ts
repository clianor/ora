import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';

const manifest: unknown = JSON.parse(readFileSync('package.json', 'utf8'));
if (
  typeof manifest !== 'object' ||
  manifest === null ||
  !('scripts' in manifest) ||
  typeof manifest.scripts !== 'object' ||
  manifest.scripts === null
) {
  throw new Error('package.json에 scripts 객체가 없습니다.');
}
const scripts = Object.keys(manifest.scripts);
const pnpmBuiltins = ['install', 'exec', 'add', 'remove', 'update', 'dlx', 'why', 'licenses'];

const instructionFiles = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '*CLAUDE.md', '*AGENTS.md'],
  {
    encoding: 'utf8',
  },
)
  .split('\n')
  .filter(Boolean);

// 로컬 디스크 대신 git 파일 목록으로 판정한다. 그래야 gitignore된 빌드 결과물이 있는 로컬과 새로 체크아웃한 CI가 같은 결과를 낸다.
const repoFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);

function findProblem(span: string): string | undefined {
  const scriptName =
    /^pnpm (?:run )?([a-z][\w:-]*)/.exec(span)?.[1] ?? /^(check:[\w-]+)$/.exec(span)?.[1];
  if (scriptName !== undefined) {
    if (scripts.includes(scriptName) || pnpmBuiltins.includes(scriptName)) return undefined;
    return `package.json에 없는 스크립트: ${scriptName}`;
  }

  if (/\s/.test(span) || !span.includes('/')) return undefined;
  const path = span.replace(/^\.\//, '');
  const topDirectory = path.split('/')[0] ?? '';
  // 첫 구간이 저장소의 디렉터리일 때만 경로로 본다. 세션 디렉터리 안의 경로(`artifacts/…`)와 URL을 이 조건이 거른다.
  if (!repoFiles.some((file) => file.startsWith(`${topDirectory}/`))) return undefined;
  // git 목록에는 파일만 있으므로, 디렉터리나 디렉터리 글롭(`apps/*`)은 그 아래 파일로 맞춘다.
  const under = `${path.replace(/\/$/, '')}/**`;
  if (repoFiles.some((file) => matchesGlob(file, path) || matchesGlob(file, under))) {
    return undefined;
  }
  // gitignore된 경로(빌드 결과물 위치 안내 등)는 체크아웃에 없으므로 확인할 수 없어 건너뛴다.
  if (spawnSync('git', ['check-ignore', '-q', path]).status === 0) return undefined;
  return `없는 경로: ${span}`;
}

const problems = instructionFiles.flatMap((file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line, index) =>
      [...line.matchAll(/`([^`]+)`/g)].flatMap(([, span = '']) => {
        const problem = findProblem(span);
        return problem === undefined ? [] : [`${file}:${index + 1} ${problem}`];
      }),
    ),
);

if (problems.length > 0) {
  console.error('지시 파일이 존재하지 않는 대상을 가리킵니다.');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
