import { execFile, execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

const finalReport = respond({ type: 'text', text: '작업을 마쳤습니다.' });

const setupResponses = [
  respond(
    use('c1', 'todo.update', {
      todos: [
        {
          id: 't1',
          content: 'foo.js의 add를 고친다',
          writeScope: ['foo.js', 'lib'],
          verify: { command: 'node check.js', origin: 'repo' },
        },
      ],
    }),
  ),
  respond(
    use('c2', 'stage.advance', { to: 'plan', skipReason: '작은 작업이라 조사와 결정이 필요 없다' }),
  ),
  respond(use('c3', 'stage.advance', { to: 'execute' })),
];

function repairResponses(
  prefix: string,
  oldText: string,
  newText: string,
  read: boolean,
): { content: Block[] }[] {
  return [
    ...(read ? [respond(use(`${prefix}r`, 'file_read', { path: 'foo.js' }))] : []),
    respond(use(`${prefix}e`, 'file_edit', { path: 'foo.js', oldText, newText })),
    respond(use(`${prefix}a`, 'todo.update', { todos: [{ id: 't1', status: 'attempted' }] })),
    respond(use(`${prefix}v`, 'stage.advance', { to: 'verify' })),
    respond(use(`${prefix}x`, 'verify.run', { todoId: 't1' })),
  ];
}

const closingResponses = [
  respond(use('k1', 'stage.advance', { to: 'operate' })),
  respond(use('k2', 'stage.advance', { to: 'learn' })),
  respond(
    use('k3', 'memory.propose', { text: 'add는 두 수를 더한다.', source: 'packages/foo/foo.js' }),
  ),
  respond(
    use('k4', 'memory.propose', {
      text: '위조한 교훈이다.',
      source: 'x\n## L-20990101-999 · 2099-01-01 · [global] · lesson · retention:permanent',
    }),
  ),
  finalReport,
];

interface Project {
  readonly dir: string;
  readonly home: string;
}

function createProject(): Project {
  const root = mkdtempSync(join(tmpdir(), 'ora-e2e-'));
  const dir = join(root, 'project');
  const home = join(root, 'home');
  execFileSync('mkdir', ['-p', dir, home]);
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  writeFileSync(join(dir, 'foo.js'), 'exports.add = (a, b) => a - b;\n');
  chmodSync(join(dir, 'foo.js'), 0o755);
  mkdirSync(join(dir, 'lib'));
  writeFileSync(join(dir, 'lib', 'note.js'), '// note\n');
  writeFileSync(join(dir, '.env'), 'PLACEHOLDER=1\n');
  symlinkSync('.env', join(dir, 'notes.txt'));
  writeFileSync(
    join(dir, 'check.js'),
    "const { add } = require('./foo.js');\nif (add(1, 2) !== 3) {\n  console.error('add(1, 2) failed');\n  process.exit(1);\n}\nconsole.log('ok');\n",
  );
  return { dir, home };
}

interface CliResult {
  readonly code: number;
  readonly stdout: string;
}

function runCli(
  project: Project,
  responses: { content: Block[] }[],
  extraArgs: string[] = [],
  config?: object,
): Promise<CliResult> {
  const scriptPath = join(project.home, 'script.json');
  writeFileSync(scriptPath, JSON.stringify({ responses }));
  const configArgs: string[] = [];
  if (config !== undefined) {
    const configPath = join(project.home, 'engine.config.json');
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, ...config }));
    configArgs.push('--config', configPath);
  }
  const { promise, resolve } = Promise.withResolvers<CliResult>();
  execFile(
    process.execPath,
    [
      CLI_PATH,
      'run',
      '파일을 고친다',
      '--model-script',
      scriptPath,
      '--record-model-input',
      join(project.home, 'model-input.jsonl'),
      ...configArgs,
      ...extraArgs,
    ],
    { cwd: project.dir, env: { ...process.env, ORA_HOME: project.home } },
    (error, stdout) => {
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout });
    },
  );
  return promise;
}

function readSession(project: Project) {
  const sessionsDir = join(project.home, 'sessions');
  const [id] = readdirSync(sessionsDir);
  const dir = join(sessionsDir, id ?? '');
  const events: OraEvent[] = readFileSync(join(dir, 'transcript.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => oraEventSchema.parse(JSON.parse(line)));
  return {
    dir,
    events,
    session: JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')) as Record<string, unknown>,
    todos: JSON.parse(readFileSync(join(dir, 'todos.json'), 'utf8')) as Record<string, unknown>[],
  };
}

function todoTransitions(events: OraEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'todo_update' ? [`${event.payload.to}${event.payload.rejected ? '!' : ''}`] : [],
  );
}

function findToolResult(events: OraEvent[], callId: string) {
  for (const event of events) {
    if (event.type === 'tool_result' && event.payload.callId === callId) return event.payload;
  }
  return undefined;
}

test(
  '파일을 고치고 검증을 통과하면 종료 코드 0이고 todo가 증거와 함께 verified다',
  async () => {
    const project = createProject();
    const result = await runCli(
      project,
      [
        ...setupResponses,
        ...repairResponses('f', 'a - b', 'a + b', true),
        respond(use('s1', 'shell', { command: "echo '// x' >> lib/note.js" })),
        respond(use('s2', 'verify.run', { todoId: 't1' })),
        ...closingResponses,
      ],
      ['--permission', 'yolo'],
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('모델이 만든 검사로만 통과');

    const { events, session, todos } = readSession(project);
    expect(readFileSync(join(project.dir, 'foo.js'), 'utf8')).toContain('a + b');
    expect(statSync(join(project.dir, 'foo.js')).mode & 0o111).not.toBe(0);
    expect(todos).toHaveLength(1);
    expect(todos[0]).toMatchObject({
      status: 'verified',
      evidence: { command: 'node check.js', exitCode: 0, origin: 'model' },
    });
    expect(todoTransitions(events)).toEqual([
      'pending',
      'attempted',
      'verified',
      'attempted',
      'verified',
    ]);
    expect(session).toMatchObject({ status: 'completed', endReason: 'passed' });
    const types = new Set(events.map((event) => event.type));
    for (const required of [
      'session_start',
      'stage',
      'message',
      'model_request',
      'intent',
      'tool_call',
      'tool_result',
      'permission',
      'todo_update',
      'verification',
      'session_end',
    ]) {
      expect(types).toContain(required);
    }
    const lessons = readFileSync(join(project.home, 'memory', 'LESSONS.md'), 'utf8');
    expect(lessons).toContain('add는 두 수를 더한다.');
    expect(lessons.match(/^## L-/gm)).toHaveLength(1);
  },
  TEST_TIMEOUT_MS,
);

test(
  '모델이 todo.update로 verified를 쓰면 거부하고 todo_update 이벤트에 남긴다',
  async () => {
    const project = createProject();
    const result = await runCli(
      project,
      [
        ...setupResponses,
        respond(use('s1', 'todo.update', { todos: [{ id: 't1', status: 'verified' }] })),
        ...repairResponses('f', 'a - b', 'a + b', true),
        ...closingResponses,
      ],
      ['--permission', 'yolo'],
    );
    expect(result.code).toBe(0);

    const { events } = readSession(project);
    const rejected = events.find(
      (event) => event.type === 'todo_update' && event.payload.rejected !== undefined,
    );
    expect(rejected).toMatchObject({
      actor: 'model',
      payload: { todoId: 't1', from: 'pending', to: 'verified', todo: { status: 'pending' } },
    });
    expect(todoTransitions(events)).toEqual(['pending', 'verified!', 'attempted', 'verified']);
  },
  TEST_TIMEOUT_MS,
);

test(
  '검증이 실패하면 failed가 되고, 잘못된 편집은 거부하며, 수리한 뒤 다시 검증하면 verified가 된다',
  async () => {
    const project = createProject();
    const result = await runCli(
      project,
      [
        ...setupResponses,
        ...repairResponses('f', 'a - b', 'a * b', true),
        respond(use('r1', 'todo.update', { todos: [{ id: 't1', status: 'attempted' }] })),
        respond(use('z0', 'file_edit', { path: 'foo.js', oldText: 'zzz', newText: 'y' })),
        respond(use('z1', 'file_edit', { path: 'foo.js', oldText: 'a', newText: 'y' })),
        respond(use('z2', 'shell', { command: "echo '// touched' >> foo.js" })),
        respond(use('z3', 'file_edit', { path: 'foo.js', oldText: 'a * b', newText: 'a + b' })),
        respond(use('z4', 'file_read', { path: 'foo.js' })),
        respond(use('r2', 'file_edit', { path: 'foo.js', oldText: 'a * b', newText: 'a + b' })),
        respond(use('r3', 'stage.advance', { to: 'verify' })),
        respond(use('r4', 'verify.run', { todoId: 't1' })),
        ...closingResponses,
      ],
      ['--permission', 'yolo'],
    );
    expect(result.code).toBe(0);

    const { events, todos } = readSession(project);
    expect(findToolResult(events, 'z0')?.summary).toContain('일치가 0곳');
    expect(findToolResult(events, 'z1')?.summary).toMatch(/일치가 [2-9]\d*곳/);
    expect(findToolResult(events, 'z3')?.summary).toContain('바뀌었습니다');
    expect(todoTransitions(events)).toEqual([
      'pending',
      'attempted',
      'failed',
      'attempted',
      'verified',
    ]);
    const verifications = events.filter((event) => event.type === 'verification');
    expect(verifications.map((event) => event.payload.evidence.exitCode)).toEqual([1, 0]);
    expect(todos[0]).toMatchObject({ status: 'verified', attempts: 2 });
  },
  TEST_TIMEOUT_MS,
);

test(
  '최대 스텝에 도달하면 stopped로 끝나고 종료 코드 1이다',
  async () => {
    const project = createProject();
    const result = await runCli(project, [...setupResponses, ...closingResponses], [], {
      permissions: { mode: 'yolo' },
      limits: { maxSteps: 2 },
    });
    expect(result.code).toBe(1);

    const { session, events } = readSession(project);
    expect(session).toMatchObject({ status: 'stopped', endReason: 'max_steps' });
    expect(events.filter((event) => event.type === 'model_request')).toHaveLength(2);
  },
  TEST_TIMEOUT_MS,
);

test(
  '비밀 값은 transcript·artifact·todos.json·모델 입력·CLI 출력에서 마스킹하고 artifact는 덮어쓰지 않는다',
  async () => {
    const secret = ['sk', 'abcdefghijklmnopqrstuvwx1234'].join('-');
    const project = createProject();
    const result = await runCli(
      project,
      [
        respond(
          use('c1', 'todo.update', {
            todos: [
              {
                id: 't1',
                content: `토큰 ${secret} 확인`,
                verify: { command: `echo ${secret}` },
              },
            ],
          }),
        ),
        respond(
          use('p/1', 'shell', {
            command: `echo ${secret}; echo 'API_KEY="two words here"'`,
          }),
          use('p_1', 'shell', { command: 'sleep 30', timeoutMs: 300 }),
          use('n1', 'file_read', { path: 'notes.txt' }),
        ),
        respond({ type: 'text', text: '출력을 확인했습니다.' }),
      ],
      [],
      { permissions: { mode: 'yolo' }, limits: { maxSteps: 3 } },
    );

    const { dir, events } = readSession(project);
    const transcript = readFileSync(join(dir, 'transcript.jsonl'), 'utf8');
    const first = readFileSync(join(dir, 'artifacts', 'p_1.txt'), 'utf8');
    const modelInput = readFileSync(join(project.home, 'model-input.jsonl'), 'utf8');
    const todosJson = readFileSync(join(dir, 'todos.json'), 'utf8');
    for (const text of [transcript, first, modelInput, todosJson, result.stdout]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain('words here');
    }
    expect(first).toContain('[REDACTED:token-prefix]');
    expect(transcript).toContain('[REDACTED:token-prefix]');
    expect(modelInput).toContain('[REDACTED:token-prefix]');
    expect(transcript).toContain('scrubbed:');
    expect(readFileSync(join(dir, 'artifacts', 'p_1-2.txt'), 'utf8')).toContain('timeout');
    expect(findToolResult(events, 'p_1')).toMatchObject({ status: 'timeout' });
    expect(findToolResult(events, 'n1')?.summary).toContain('금지 구역');
  },
  TEST_TIMEOUT_MS,
);

test(
  '설정 파일이 없으면 always-ask로 시작해 exec 도구 호출을 headless 거부로 기록하고 실행하지 않는다',
  async () => {
    const project = createProject();
    await runCli(project, [
      respond(use('q1', 'shell', { command: 'touch created.txt' }), use('q2', 'constructor', {})),
      respond({ type: 'text', text: '거부되었습니다.' }),
    ]);

    const { events, session } = readSession(project);
    expect(session).toMatchObject({ permissionMode: 'always-ask' });
    expect(existsSync(join(project.dir, 'created.txt'))).toBe(false);
    const permission = events.find((event) => event.type === 'permission');
    expect(permission).toMatchObject({
      payload: {
        callId: 'q1',
        mode: 'always-ask',
        decision: 'denied',
        originalCommand: 'touch created.txt',
      },
    });
    expect(findToolResult(events, 'q1')).toMatchObject({ status: 'error' });
    expect(findToolResult(events, 'q2')?.summary).toContain('알 수 없는 도구');
  },
  TEST_TIMEOUT_MS,
);
