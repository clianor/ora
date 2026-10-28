// M1 인수 기준인 격리 스모크 테스트다 (SPEC 5.6절, 6.3절). 모두 `ora run` 진입점을 실제로 돌려 셸 자식의 환경을 확인한다.
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { oraEventSchema } from '@ora/protocol';
import type { OraEvent } from '@ora/protocol';
import { expect, test } from 'vitest';

const CLI_PATH = fileURLToPath(new URL('./main.ts', import.meta.url));
const TEST_TIMEOUT_MS = 60_000;

type Block = Record<string, unknown>;

function use(callId: string, tool: string, input: Record<string, unknown>): Block {
  return { type: 'tool_use', callId, tool, input: { intent: `${tool} 호출`, ...input } };
}

function respond(...blocks: Block[]): { content: Block[] } {
  return { content: blocks };
}

const setupResponses = [
  respond(
    use('c1', 'todo.update', {
      todos: [
        {
          id: 't1',
          content: '환경을 확인한다',
          writeScope: ['out.txt'],
          verify: { command: 'true', origin: 'repo' },
        },
      ],
    }),
  ),
  respond(use('c2', 'stage.advance', { to: 'plan', skipReason: '환경만 읽는 작업이다' })),
  respond(use('c3', 'stage.advance', { to: 'execute' })),
];

interface Project {
  readonly dir: string;
  readonly oraHome: string;
  readonly realHome: string;
}

function createProject(files: string[] = []): Project {
  const root = mkdtempSync(join(tmpdir(), 'ora-isolation-'));
  const project = {
    dir: join(root, 'project'),
    oraHome: join(root, 'ora'),
    realHome: join(root, 'real'),
  };
  mkdirSync(project.dir);
  mkdirSync(project.realHome);
  execFileSync('git', ['init', '--quiet'], { cwd: project.dir });
  for (const file of files) writeFileSync(join(project.dir, file), '# 지시\n');
  return project;
}

/** `command`를 셸 도구로 한 번 실행하는 세션을 돌리고 그 도구 결과와 transcript를 돌려준다. */
async function runShell(
  project: Project,
  command: string,
  options: { config?: object; flag?: string; resume?: boolean } = {},
) {
  const scriptPath = join(project.oraHome, 'script.json');
  mkdirSync(project.oraHome, { recursive: true });
  const sessionsDir = join(project.oraHome, 'sessions');
  const [id = ''] = options.resume === true ? readdirSync(sessionsDir) : [];
  const responses = [
    ...(options.resume === true ? [] : setupResponses),
    respond(use(options.resume === true ? 's2' : 's1', 'shell', { command })),
    respond({ type: 'text', text: '확인했습니다.' }),
  ];
  writeFileSync(scriptPath, JSON.stringify({ responses }));
  const configPath = join(project.oraHome, 'engine.config.json');
  writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, ...options.config }));
  const { promise, resolve } = Promise.withResolvers<undefined>();
  execFile(
    process.execPath,
    [
      CLI_PATH,
      ...(options.resume === true ? ['resume', id] : ['run', '환경을 확인한다']),
      '--model-script',
      scriptPath,
      '--config',
      configPath,
      ...(options.flag === undefined ? [] : ['--isolation', options.flag]),
    ],
    {
      cwd: project.dir,
      env: {
        ...process.env,
        ORA_HOME: project.oraHome,
        HOME: project.realHome,
        ORA_TEST_PLAIN: 'visible',
        ORA_TEST_SECRET: 'leaked',
      },
    },
    () => {
      resolve(undefined);
    },
  );
  await promise;
  const [sessionId] = readdirSync(sessionsDir);
  const dir = join(sessionsDir, sessionId ?? '');
  const events = readFileSync(join(dir, 'transcript.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => oraEventSchema.parse(JSON.parse(line)));
  const callId = options.resume === true ? 's2' : 's1';
  const result = events.find(
    (event): event is Extract<OraEvent, { type: 'tool_result' }> =>
      event.type === 'tool_result' && event.payload.callId === callId,
  );
  const session = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')) as {
    isolation: string;
  };
  return { events, result: result?.payload, session };
}

const PRINT_ENV =
  'printenv CLAUDE_CONFIG_DIR; printenv HOME; printenv ORA_TEST_PLAIN; printenv ORA_TEST_SECRET; true';

test(
  'harness는 도구별 설정 폴더만 격리 경로로 바꾸고 HOME은 그대로 둔다',
  async () => {
    const project = createProject();
    const { result, session } = await runShell(project, PRINT_ENV, {
      config: { isolation: 'harness' },
    });
    expect(session.isolation).toBe('harness');
    expect(result?.summary).toContain(join(project.oraHome, 'isolated', 'claude'));
    expect(result?.summary).toContain(project.realHome);
  },
  TEST_TIMEOUT_MS,
);

test(
  'clean-home은 HOME을 격리 경로로 바꾸고 허용 목록 밖의 변수를 자식에 넘기지 않는다',
  async () => {
    const project = createProject();
    const { result } = await runShell(project, PRINT_ENV, { config: { isolation: 'clean-home' } });
    expect(result?.summary).toContain(join(project.oraHome, 'isolated', 'home'));
    expect(result?.summary).not.toContain(project.realHome);
    expect(result?.summary).not.toContain('leaked');
    expect(result?.summary).not.toContain('visible');
  },
  TEST_TIMEOUT_MS,
);

test(
  'clean-home에서 하네스 파일이 있는 작업 폴더는 session_start에 남고 하네스 CLI 호출은 차단한다',
  async () => {
    const project = createProject(['CLAUDE.md']);
    const { events, result } = await runShell(project, 'claude --version', {
      config: { isolation: 'clean-home' },
    });
    expect(result).toMatchObject({ status: 'error' });
    expect(result?.summary).toContain('격리 차단');
    const start = events.find((event) => event.type === 'session_start');
    expect(start?.type === 'session_start' && start.payload.harnessFilesFound).toEqual([
      'CLAUDE.md',
    ]);
  },
  TEST_TIMEOUT_MS,
);

test(
  'none은 부모 환경변수를 그대로 자식에 넘긴다',
  async () => {
    const project = createProject();
    const { result } = await runShell(project, PRINT_ENV, { config: { isolation: 'none' } });
    expect(result?.summary).toContain('visible');
    expect(result?.summary).toContain(project.realHome);
  },
  TEST_TIMEOUT_MS,
);

test(
  '--isolation 플래그가 설정 기본값보다 앞선다',
  async () => {
    const project = createProject();
    const { result, session } = await runShell(project, PRINT_ENV, {
      config: { isolation: 'harness' },
      flag: 'clean-home',
    });
    expect(session.isolation).toBe('clean-home');
    expect(result?.summary).toContain(join(project.oraHome, 'isolated', 'home'));
  },
  TEST_TIMEOUT_MS,
);

test(
  '재개할 때 --isolation 플래그가 세션 기록의 값보다 앞서고 새 값을 session.json에 기록한다',
  async () => {
    const project = createProject();
    await runShell(project, PRINT_ENV, { config: { isolation: 'harness' } });
    const { result, session } = await runShell(project, PRINT_ENV, {
      config: { isolation: 'harness' },
      flag: 'clean-home',
      resume: true,
    });
    expect(session.isolation).toBe('clean-home');
    expect(result?.summary).toContain(join(project.oraHome, 'isolated', 'home'));
  },
  TEST_TIMEOUT_MS,
);
