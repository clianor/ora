import { execFile, execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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
  readonly stderr: string;
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
    (error, stdout, stderr) => {
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
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
    .filter((line) => !line.startsWith('{"seq":999,'))
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

interface RunningCli {
  readonly child: ChildProcess;
  readonly output: () => CliResult;
  readonly done: Promise<CliResult>;
}

function startCli(project: Project, args: string[]): RunningCli {
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    cwd: project.dir,
    env: { ...process.env, ORA_HOME: project.home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const { promise, resolve } = Promise.withResolvers<CliResult>();
  child.on('close', (code) => {
    resolve({ code: code ?? -1, stdout, stderr });
  });
  return { child, output: () => ({ code: -1, stdout, stderr }), done: promise };
}

function writeScript(project: Project, name: string, responses: { content: Block[] }[]): string[] {
  const scriptPath = join(project.home, `${name}.json`);
  writeFileSync(scriptPath, JSON.stringify({ responses }));
  return [
    '--model-script',
    scriptPath,
    '--record-model-input',
    join(project.home, `${name}-input.jsonl`),
  ];
}

function startRun(
  project: Project,
  name: string,
  responses: { content: Block[] }[],
  config?: object,
): RunningCli {
  const configArgs: string[] = [];
  if (config !== undefined) {
    const configPath = join(project.home, 'engine.config.json');
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, ...config }));
    configArgs.push('--config', configPath);
  }
  return startCli(project, [
    'run',
    '파일을 고친다',
    ...writeScript(project, name, responses),
    '--permission',
    'yolo',
    ...configArgs,
  ]);
}

function startResume(
  project: Project,
  sessionId: string,
  name: string,
  responses: { content: Block[] }[],
  extraArgs: string[] = [],
): RunningCli {
  return startCli(project, [
    'resume',
    sessionId,
    ...writeScript(project, name, responses),
    ...extraArgs,
  ]);
}

async function waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('조건을 기다리다 시간이 지났습니다.');
    await new Promise((done) => setTimeout(done, 50));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sessionIdOf(project: Project): string {
  const [id] = readdirSync(join(project.home, 'sessions'));
  return id ?? '';
}

const attemptedResponse = respond(
  use('a1', 'todo.update', { todos: [{ id: 't1', status: 'attempted' }] }),
);

/** 빠르게 끝나는 호출 b1과 오래 도는 호출 b2를 한 배치로 낸다. 중간에 끊으면 부분 성공 배치가 된다. */
const partialBatch = respond(
  use('b1', 'shell', { command: 'echo once >> side.txt' }),
  use('b2', 'shell', {
    command: 'echo $$ > pid.txt; echo started > started.txt; sleep 60',
  }),
);

function startedFile(project: Project): string {
  return join(project.dir, 'started.txt');
}

async function interruptTwice(running: RunningCli): Promise<CliResult> {
  running.child.kill('SIGINT');
  await waitFor(() => running.output().stderr.includes('소프트 스톱'));
  running.child.kill('SIGINT');
  return running.done;
}

/** 오래 도는 호출 중에 하드 킬로 끝낸 세션을 만든다. */
async function createHardKilledSession(
  project: Project,
  batch: { content: Block[] },
): Promise<void> {
  const running = startRun(project, 'first', [...setupResponses, attemptedResponse, batch]);
  await waitFor(() => existsSync(startedFile(project)));
  expect((await interruptTwice(running)).code).toBe(130);
}

const resumeToVerified = [...repairResponses('f', 'a - b', 'a + b', true), ...closingResponses];

/** 소프트 스톱으로 끝낸 세션을 만든다. */
async function createSoftStoppedSession(project: Project): Promise<void> {
  const running = startRun(project, 'first', [
    ...setupResponses,
    attemptedResponse,
    respond(use('s1', 'shell', { command: 'echo started > started.txt; sleep 2' })),
  ]);
  await waitFor(() => existsSync(startedFile(project)));
  running.child.kill('SIGINT');
  expect((await running.done).code).toBe(130);
}

test(
  '소프트 스톱은 진행 중인 도구 호출을 끝까지 기다린 뒤 세션과 todo를 interrupted로 남기고 종료 코드 130이다',
  async () => {
    const project = createProject();
    const running = startRun(project, 'first', [
      ...setupResponses,
      attemptedResponse,
      respond(
        use('s1', 'shell', {
          command: 'echo started > started.txt; sleep 2; echo finished > finished.txt',
        }),
      ),
    ]);
    await waitFor(() => existsSync(startedFile(project)));
    running.child.kill('SIGINT');
    const result = await running.done;
    expect(result.code).toBe(130);

    const { events, session, todos } = readSession(project);
    expect(existsSync(join(project.dir, 'finished.txt'))).toBe(true);
    expect(findToolResult(events, 's1')).toMatchObject({ status: 'ok' });
    expect(session).toMatchObject({ status: 'interrupted', endReason: 'user_cancel' });
    expect(todos[0]).toMatchObject({ id: 't1', status: 'interrupted' });
    expect(events.find((event) => event.type === 'cancel')).toMatchObject({
      payload: { mode: 'soft' },
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  '하드 킬은 셸 프로세스 그룹을 종료하고 세션을 crashed로, 진행 중이던 호출을 aborted로 남긴다',
  async () => {
    const project = createProject();
    await createHardKilledSession(project, partialBatch);

    const { dir, events, session } = readSession(project);
    const shellPid = Number(readFileSync(join(project.dir, 'pid.txt'), 'utf8'));
    await waitFor(() => !isAlive(shellPid));
    expect(session).toMatchObject({ status: 'crashed', endReason: 'user_cancel' });
    expect(findToolResult(events, 'b1')).toMatchObject({ status: 'ok' });
    expect(findToolResult(events, 'b2')).toMatchObject({ status: 'aborted' });
    expect(events.find((event) => event.type === 'cancel')).toMatchObject({
      payload: { mode: 'hard' },
    });
    expect(existsSync(join(dir, 'worker.pid'))).toBe(false);
  },
  TEST_TIMEOUT_MS,
);

test(
  '하드 킬로 끝난 세션을 재개하면 부분 성공 배치를 다시 실행하지 않고 끝까지 돌아 verified가 된다',
  async () => {
    const project = createProject();
    await createHardKilledSession(project, partialBatch);
    const sessionId = sessionIdOf(project);

    const resuming = startResume(project, sessionId, 'second', [
      respond(use('r1', 'shell', { command: 'echo 1 > started2.txt; sleep 2' })),
      ...resumeToVerified,
    ]);
    await waitFor(() => existsSync(join(project.dir, 'started2.txt')));
    // 같은 세션을 동시에 재개하면 transcript에 같은 seq가 두 번 쓰이므로 둘째 재개는 거부한다.
    const concurrent = await startResume(project, sessionId, 'third', resumeToVerified).done;
    expect(concurrent.code).toBe(2);
    expect(concurrent.stderr).toContain('이미 실행 중');
    const resumed = await resuming.done;
    expect(resumed.code).toBe(0);

    const { dir, events, session, todos } = readSession(project);
    expect(new Set(events.map((event) => event.seq)).size).toBe(events.length);
    expect(existsSync(join(dir, 'session.lock'))).toBe(false);
    expect(readFileSync(join(project.dir, 'side.txt'), 'utf8')).toBe('once\n');
    expect(
      events.filter((event) => event.type === 'tool_call' && event.payload.callId === 'b1'),
    ).toHaveLength(1);
    expect(events.some((event) => event.type === 'context_trim')).toBe(false);
    expect(events.find((event) => event.type === 'resume')).toMatchObject({
      payload: { fromStatus: 'crashed', hardKilled: true, steered: false },
    });
    expect(session).toMatchObject({ status: 'completed', endReason: 'passed' });
    expect(todos[0]).toMatchObject({ status: 'verified' });

    const firstRequest = readFileSync(join(project.home, 'second-input.jsonl'), 'utf8')
      .trim()
      .split('\n')[0];
    const context = JSON.stringify(JSON.parse(firstRequest ?? '{}'));
    expect(context).toContain('exit code: 0');
    expect(context).toContain('워커가 종료되어 호출이 중단됐습니다.');

    // session_end 직후 죽어 session.json이 running으로 남았다면, transcript의 completed가 이긴다.
    const sessionPath = join(dir, 'session.json');
    const record = JSON.parse(readFileSync(sessionPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(sessionPath, JSON.stringify({ ...record, status: 'running' }));
    const again = await startResume(project, sessionId, 'fourth', resumeToVerified).done;
    expect(again.code).toBe(2);
    expect(again.stderr).toContain('completed');
    expect(JSON.parse(readFileSync(sessionPath, 'utf8'))).toMatchObject({ status: 'completed' });
  },
  TEST_TIMEOUT_MS,
);

test(
  '전체가 중단된 마지막 배치는 재개할 때 모델 컨텍스트에서 빼고 context_trim으로 남긴다',
  async () => {
    const project = createProject();
    await createHardKilledSession(
      project,
      respond(
        use('b2', 'shell', { command: 'echo $$ > pid.txt; echo started > started.txt; sleep 60' }),
      ),
    );
    const before = readFileSync(join(readSession(project).dir, 'transcript.jsonl'), 'utf8');

    const resumed = await startResume(project, sessionIdOf(project), 'second', resumeToVerified, [
      '--steer',
      '파일만 고친다',
    ]).done;
    expect(resumed.code).toBe(0);

    const { dir, events } = readSession(project);
    expect(readFileSync(join(dir, 'transcript.jsonl'), 'utf8').startsWith(before)).toBe(true);
    const trim = events.find((event) => event.type === 'context_trim');
    expect(trim).toMatchObject({ payload: { reason: 'aborted_batch' } });
    expect(events.find((event) => event.type === 'resume')).toMatchObject({
      payload: { steered: true },
    });
    const firstRequest = readFileSync(join(project.home, 'second-input.jsonl'), 'utf8')
      .trim()
      .split('\n')[0];
    expect(firstRequest).not.toContain('"callId":"b2"');
    expect(firstRequest).toContain('사용자 지시: 파일만 고친다');
  },
  TEST_TIMEOUT_MS,
);

test(
  '마지막 줄이 깨진 세션을 재개하면 recovered 이벤트를 남기고 끝까지 돈다',
  async () => {
    const project = createProject();
    await createSoftStoppedSession(project);
    const transcriptPath = join(readSession(project).dir, 'transcript.jsonl');
    appendFileSync(transcriptPath, '{"seq":999,"ts":"2026-10-28T10:00');

    const resumed = await startResume(project, sessionIdOf(project), 'second', resumeToVerified)
      .done;
    expect(resumed.code).toBe(0);

    const { events, session } = readSession(project);
    expect(events.find((event) => event.type === 'recovered')).toMatchObject({
      payload: { droppedLines: 1 },
    });
    expect(readFileSync(transcriptPath, 'utf8')).toContain('{"seq":999,"ts":"2026-10-28T10:00\n');
    expect(session).toMatchObject({ status: 'completed' });
  },
  TEST_TIMEOUT_MS,
);

test(
  '워커 프로세스가 SIGKILL로 죽으면 호스트가 세션을 crashed로 기록하고 ora sessions가 보여 준다',
  async () => {
    const project = createProject();
    const running = startRun(project, 'first', [
      ...setupResponses,
      attemptedResponse,
      respond(
        use('s1', 'shell', { command: 'echo $$ > pid.txt; echo started > started.txt; sleep 20' }),
      ),
    ]);
    await waitFor(() => existsSync(startedFile(project)));
    const workerPidPath = join(project.home, 'sessions', sessionIdOf(project), 'worker.pid');
    process.kill(Number(readFileSync(workerPidPath, 'utf8')), 'SIGKILL');
    const result = await running.done;
    // 셸은 워커와 다른 프로세스 그룹이므로, 호스트가 워커 사망 뒤에 직접 종료해야 한다.
    const shellPid = Number(readFileSync(join(project.dir, 'pid.txt'), 'utf8'));
    await waitFor(() => !isAlive(shellPid));
    expect(result.code).toBe(1);

    const { events, session } = readSession(project);
    expect(session).toMatchObject({ status: 'crashed', endReason: 'error' });
    expect(findToolResult(events, 's1')).toMatchObject({ status: 'aborted' });
    expect(events.some((event) => event.type === 'cancel')).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: 'session_end',
      payload: { status: 'crashed', summary: expect.stringContaining('SIGKILL') as string },
    });

    const listed = await startCli(project, ['sessions', '--json']).done;
    expect(JSON.parse(listed.stdout.trim())).toMatchObject({
      id: sessionIdOf(project),
      status: 'crashed',
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  '동시 세션 상한에 닿으면 새 세션은 앞선 세션이 끝날 때까지 시작하지 않고 기다린다',
  async () => {
    const project = createProject();
    const config = { limits: { maxConcurrentSessions: 1 } };
    const first = startRun(
      project,
      'first',
      [
        respond(use('s1', 'shell', { command: 'echo started > started.txt; sleep 2' })),
        finalReport,
      ],
      config,
    );
    await waitFor(() => existsSync(startedFile(project)));
    const second = startRun(project, 'second', [finalReport], config);
    await waitFor(() => second.output().stderr.includes('대기합니다'));
    expect(readdirSync(join(project.home, 'sessions'))).toHaveLength(1);

    await Promise.all([first.done, second.done]);
    expect(readdirSync(join(project.home, 'sessions'))).toHaveLength(2);
  },
  TEST_TIMEOUT_MS,
);

test(
  'archived 세션은 재개를 거부하고 종료 코드 2다',
  async () => {
    const project = createProject();
    await createSoftStoppedSession(project);
    const sessionPath = join(readSession(project).dir, 'session.json');
    const record = JSON.parse(readFileSync(sessionPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(sessionPath, JSON.stringify({ ...record, status: 'archived' }));

    const resumed = await startResume(project, sessionIdOf(project), 'second', resumeToVerified)
      .done;
    expect(resumed.code).toBe(2);
    expect(resumed.stderr).toContain('archived');
  },
  TEST_TIMEOUT_MS,
);

test(
  '시작 기록을 남기기 전에 죽은 세션도 crashed로 기록해 ora sessions에 보이고 재개는 사유를 알려 준다',
  async () => {
    const project = createProject();
    await createSoftStoppedSession(project);
    const { dir } = readSession(project);
    const sessionId = sessionIdOf(project);
    const transcriptPath = join(dir, 'transcript.jsonl');
    const firstLine = readFileSync(transcriptPath, 'utf8').split('\n')[0] ?? '';

    for (const content of [`${firstLine}\n`, '']) {
      writeFileSync(transcriptPath, content);
      rmSync(join(dir, 'session.json'), { force: true });
      const resumed = await startResume(project, sessionId, 'second', resumeToVerified).done;
      expect(resumed.code).toBe(2);
      expect(resumed.stderr).toContain('시작 기록이 없어 재개할 수 없습니다');
      const listed = await startCli(project, ['sessions', '--json']).done;
      expect(JSON.parse(listed.stdout.trim())).toMatchObject({
        id: sessionId,
        status: 'crashed',
        endReason: 'error',
      });
    }
  },
  TEST_TIMEOUT_MS,
);
