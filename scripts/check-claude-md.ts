import { execFileSync } from 'node:child_process';
import { existsSync, globSync, readFileSync, statSync } from 'node:fs';

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
  if (!existsSync(topDirectory) || !statSync(topDirectory).isDirectory()) return undefined;
  const exists = path.includes('*') ? globSync(path).length > 0 : existsSync(path);
  return exists ? undefined : `없는 경로: ${span}`;
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
