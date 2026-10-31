import { execFile, execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentsApi } from '@ora/host';
import { oraEventSchema } from '@ora/protocol';
import type { OraEvent } from '@ora/protocol';
import { expect, test } from 'vitest';

const CLI_PATH = fileURLToPath(new URL('./main.ts', import.meta.url));
const TEST_TIMEOUT_MS = 90_000;

type Block = Record<string, unknown>;
interface Response {
  content: Block[];
  usage?: Record<string, number>;
}

function use(callId: string, tool: string, input: Record<string, unknown>): Block {
  return { type: 'tool_use', callId, tool, input: { intent: `${tool} 호출`, ...input } };
}

function respond(...blocks: Block[]): Response {
  return { content: blocks };
}

const finalReport = respond({ type: 'text', text: '작업을 마쳤습니다.' });

function delegate(
  callId: string,
  agent: string,
  goal: string,
  options: { todoId?: string; verifyCommand?: string } = {},
): Block {
  const { todoId, ...brief } = options;
  return use(callId, 'agent.delegate', {
    agent,
    ...(todoId === undefined ? {} : { todoId }),
    brief: { goal, writeScope: ['foo.js'], stopCondition: '막히면 멈추고 보고한다', ...brief },
  });
}

const parentSetup = [
  respond(
    use('s1', 'todo.update', {
      objective: '파일 수정',
      phases: [{ name: '수정', criterion: 'check.js 통과' }],
      todos: [
        {
          id: 't1',
          phase: '수정',
          content: 'foo.js의 add를 고친다',
          writeScope: ['foo.js', 'lib'],
          verify: { command: 'node check.js' },
        },
      ],
    }),
  ),
  respond(use('s2', 'stage.advance', { to: 'plan', skipReason: '작은 작업이다' })),
  respond(use('s3', 'stage.advance', { to: 'execute' })),
];

const closing = [
  respond(use('k1', 'stage.advance', { to: 'operate' })),
  respond(use('k2', 'stage.advance', { to: 'learn' })),
  respond(use('k3', 'memory.propose', { text: 'add는 두 수를 더한다.', source: 'foo.js' })),
  finalReport,
];

interface Project {
  readonly dir: string;
  readonly home: string;
}

function createProject(): Project {
  const root = mkdtempSync(join(tmpdir(), 'ora-delegate-'));
  const dir = join(root, 'project');
  const home = join(root, 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  writeFileSync(join(dir, 'foo.js'), 'exports.add = (a, b) => a - b;\n');
  writeFileSync(
    join(dir, 'check.js'),
    "const { add } = require('./foo.js');\nif (add(1, 2) !== 3) {\n  console.error('add(1, 2) failed');\n  process.exit(1);\n}\nconsole.log('ok');\n",
  );
  return { dir: realpathSync(dir), home };
}

function runCli(
  project: Project,
  responses: Response[],
  options: { config?: object; task?: string } = {},
): Promise<{ code: number; stdout: string }> {
  const scriptPath = join(project.home, 'script.json');
  writeFileSync(scriptPath, JSON.stringify({ responses }));
  const configArgs: string[] = [];
  if (options.config !== undefined) {
    const configPath = join(project.home, 'engine.config.json');
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, ...options.config }));
    configArgs.push('--config', configPath);
  }
  const { promise, resolve } = Promise.withResolvers<{ code: number; stdout: string }>();
  execFile(
    process.execPath,
    [
      CLI_PATH,
      'run',
      options.task ?? '결제 모듈을 손본다',
      '--model-script',
      scriptPath,
      '--record-model-input',
      join(project.home, 'model-input.jsonl'),
      '--permission',
      'bypass-permissions',
      ...configArgs,
    ],
    { cwd: project.dir, env: { ...process.env, ORA_HOME: project.home } },
    (error, stdout) => {
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout });
    },
  );
  return promise;
}

interface SessionFiles {
  readonly id: string;
  readonly events: OraEvent[];
  readonly record: Record<string, unknown> & {
    delegatedBy?: { sessionId: string; callId: string; agent: string };
    status?: string;
    endReason?: string;
  };
}

function readSessions(home: string): SessionFiles[] {
  const sessionsDir = join(home, 'sessions');
  const ids = existsSync(sessionsDir) ? readdirSync(sessionsDir) : [];
  return ids.map((id) => {
    const dir = join(sessionsDir, id);
    const path = join(dir, 'transcript.jsonl');
    const events = existsSync(path)
      ? readFileSync(path, 'utf8')
          .split('\n')
          .flatMap((line) => {
            try {
              const parsed = oraEventSchema.safeParse(JSON.parse(line));
              return parsed.success ? [parsed.data] : [];
            } catch {
              return [];
            }
          })
      : [];
    const recordPath = join(dir, 'session.json');
    const record = (
      existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : {}
    ) as SessionFiles['record'];
    return { id, events, record };
  });
}

function splitSessions(home: string) {
  const all = readSessions(home);
  const parent = all.find((session) => session.record.delegatedBy === undefined);
  if (parent === undefined) throw new Error('부모 세션이 없습니다.');
  return { parent, children: all.filter((session) => session.record.delegatedBy !== undefined) };
}

function toolResult(events: OraEvent[], callId: string) {
  for (const event of events) {
    if (event.type === 'tool_result' && event.payload.callId === callId) return event.payload;
  }
  return undefined;
}

function readModelInputs(
  project: Project,
): { system: string; messages: unknown[]; tools: string[] }[] {
  return readFileSync(join(project.home, 'model-input.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { system: string; messages: unknown[]; tools: string[] });
}

const CHILD_MARK = '## 에이전트 정의';

test(
  '정의는 프로젝트, 전역, 기본 제공 순으로 이기고 잘못된 frontmatter는 이유와 함께 건너뛴다',
  async () => {
    const project = createProject();
    const projectAgents = join(project.dir, '.ora', 'agents');
    const globalAgents = join(project.home, 'agents');
    mkdirSync(projectAgents, { recursive: true });
    mkdirSync(globalAgents, { recursive: true });
    const definition = (role: string, steps: number) =>
      `---\ndescription: 보안을 본다\ntools: [tier:read]\nrole: @${role}\nmaxSteps: ${steps}\n---\n본문\n`;
    writeFileSync(join(projectAgents, 'reviewer.md'), definition('review', 15));
    writeFileSync(join(globalAgents, 'reviewer.md'), definition('fast', 7));
    writeFileSync(join(globalAgents, 'db-migrator.md'), definition('default', 20));
    writeFileSync(join(projectAgents, 'broken.md'), '---\ndescription: 도구가 없다\n---\n본문\n');
    writeFileSync(join(projectAgents, 'steps.md'), definition('default', 0));
    writeFileSync(join(projectAgents, 'plain.md'), '프론트매터가 없다\n');

    const list = await createAgentsApi({ env: { ...process.env, ORA_HOME: project.home } }).list(
      project.dir,
    );

    expect(list.project.map((agent) => agent.name)).toEqual(['reviewer']);
    expect(list.project[0]).toMatchObject({ role: 'review', maxSteps: 15, overridesBuiltin: true });
    expect(list.global.find((agent) => agent.name === 'reviewer')).toMatchObject({
      isShadowed: true,
    });
    expect(list.global.map((agent) => agent.name)).toContain('db-migrator');
    expect(list.builtin.map((agent) => agent.name)).toEqual(['scout', 'task', 'reviewer']);
    expect(list.builtin.find((agent) => agent.name === 'reviewer')).toMatchObject({
      isShadowed: true,
    });
    expect(list.project[0]?.path).toBe(join(realpathSync(projectAgents), 'reviewer.md'));
    expect(list.errors.map((error) => error.file).sort()).toEqual([
      'broken.md',
      'plain.md',
      'steps.md',
    ]);
  },
  TEST_TIMEOUT_MS,
);

test(
  '하위 세션이 verified로 끝나도 부모 todo는 attempted이고 부모가 verify.run을 돌려야 verified가 된다',
  async () => {
    const project = createProject();
    const result = await runCli(project, [
      ...parentSetup,
      respond(
        delegate('d1', 'task', 'foo.js의 add를 고친다', {
          todoId: 't1',
          verifyCommand: 'node check.js',
        }),
      ),
      respond(
        use('c1', 'todo.update', {
          todos: [
            {
              id: 'c1',
              content: 'add를 고친다',
              writeScope: ['foo.js'],
              verify: { command: 'node check.js' },
            },
          ],
        }),
      ),
      respond(use('c2', 'file_read', { path: 'foo.js' })),
      respond(use('c3', 'file_edit', { path: 'foo.js', oldText: 'a - b', newText: 'a + b' })),
      respond(use('c4', 'todo.update', { todos: [{ id: 'c1', status: 'attempted' }] })),
      respond(use('c5', 'verify.run', { todoId: 'c1' })),
      respond({ type: 'text', text: '고쳤고 검증을 통과했습니다.' }),
      respond(use('v1', 'stage.advance', { to: 'verify' })),
      respond(use('v2', 'verify.run', { todoId: 't1' })),
      ...closing,
    ]);
    expect(result.code, result.stdout).toBe(0);

    const { parent, children } = splitSessions(project.home);
    const [child] = children;
    expect(children).toHaveLength(1);
    expect(child?.record.delegatedBy).toMatchObject({
      sessionId: parent.id,
      callId: 'd1',
      agent: 'task',
    });
    expect(child?.record).toMatchObject({ status: 'completed', endReason: 'passed' });

    const types = parent.events.map((event) => event.type);
    const start = parent.events.find((event) => event.type === 'delegate_start');
    const end = parent.events.find((event) => event.type === 'delegate_end');
    expect(start?.payload).toMatchObject({
      agent: 'task',
      childSessionId: child?.id,
      todoId: 't1',
    });
    expect(end?.payload).toMatchObject({ status: 'completed', changedFiles: ['foo.js'] });

    const t1 = parent.events.flatMap((event) =>
      event.type === 'todo_update' && event.payload.todoId === 't1' ? [event] : [],
    );
    expect(t1.map((event) => event.payload.to)).toEqual(['pending', 'attempted', 'verified']);
    expect(t1[1]?.actor).toBe('engine');
    const endIndex = types.indexOf('delegate_end');
    const verifyIndex = types.indexOf('verification');
    expect(parent.events.indexOf(t1[1] as OraEvent)).toBeGreaterThan(endIndex);
    expect(parent.events.indexOf(t1[2] as OraEvent)).toBeGreaterThan(verifyIndex);
    expect(toolResult(parent.events, 'd1')?.summary).toContain('attempted');

    const inputs = readModelInputs(project);
    const first = inputs.find((input) => input.system.includes(CHILD_MARK));
    const text = JSON.stringify(first?.messages);
    expect(text).toContain('## 브리프');
    expect(text).not.toContain('결제 모듈을 손본다');
  },
  TEST_TIMEOUT_MS,
);

test(
  'scout가 file_write를 부르면 거부하고, 하위 세션은 다시 위임하지 못하며 도구 목록에서도 뺀다',
  async () => {
    const project = createProject();
    await runCli(project, [
      respond(delegate('d1', 'scout', 'foo.js를 읽는다')),
      respond(use('w1', 'file_write', { path: 'x.txt', content: 'x' })),
      respond({ type: 'text', text: '읽기만 합니다.' }),
      respond(delegate('d2', 'task', '파일을 고친다')),
      respond(delegate('n1', 'scout', '다시 위임한다')),
      respond({ type: 'text', text: '위임하지 못했습니다.' }),
      finalReport,
    ]);

    const { children } = splitSessions(project.home);
    const scout = children.find((session) => session.record.delegatedBy?.agent === 'scout');
    const task = children.find((session) => session.record.delegatedBy?.agent === 'task');
    expect(existsSync(join(project.dir, 'x.txt'))).toBe(false);
    expect(toolResult(scout?.events ?? [], 'w1')).toMatchObject({ status: 'error' });
    expect(toolResult(scout?.events ?? [], 'w1')?.summary).toContain('권한 거부');
    expect(toolResult(task?.events ?? [], 'n1')).toMatchObject({ status: 'error' });
    expect(toolResult(task?.events ?? [], 'n1')?.summary).toContain('위임 깊이');
    expect(
      children.some(
        (session) => session.record.delegatedBy?.agent === 'scout' && session.id !== scout?.id,
      ),
    ).toBe(false);

    const inputs = readModelInputs(project);
    const parentTools = inputs.find((input) => !input.system.includes(CHILD_MARK))?.tools ?? [];
    const childTools = inputs
      .filter((input) => input.system.includes(CHILD_MARK))
      .map((input) => input.tools);
    expect(parentTools).toContain('agent.delegate');
    expect(parentTools).toContain('file_write');
    for (const tools of childTools) expect(tools).not.toContain('agent.delegate');
    expect(childTools[0]).not.toContain('file_write');
    expect(childTools[0]).not.toContain('shell');
  },
  TEST_TIMEOUT_MS,
);

test(
  '한 턴에 위임을 두 번 부르면 두 하위 세션이 동시에 돈다',
  async () => {
    const project = createProject();
    await runCli(project, [
      respond(delegate('p1', 'scout', '조사 하나'), delegate('p2', 'scout', '조사 둘')),
      respond({ type: 'text', text: '조사를 마쳤습니다.' }),
      respond({ type: 'text', text: '조사를 마쳤습니다.' }),
      finalReport,
    ]);

    const { parent, children } = splitSessions(project.home);
    expect(children).toHaveLength(2);
    const order = parent.events.flatMap((event) =>
      event.type === 'delegate_start' || event.type === 'delegate_end' ? [event.type] : [],
    );
    expect(order).toEqual(['delegate_start', 'delegate_start', 'delegate_end', 'delegate_end']);
  },
  TEST_TIMEOUT_MS,
);

test(
  '동시 세션 상한에 자리가 없으면 위임을 거부하고 하위 세션을 만들지 않는다',
  async () => {
    const project = createProject();
    await runCli(project, [respond(delegate('d1', 'scout', '조사한다')), finalReport], {
      config: { limits: { maxConcurrentSessions: 1 } },
    });

    const { parent, children } = splitSessions(project.home);
    expect(children).toHaveLength(0);
    expect(toolResult(parent.events, 'd1')).toMatchObject({ status: 'error' });
    expect(toolResult(parent.events, 'd1')?.summary).toContain('동시 세션 상한');
  },
  TEST_TIMEOUT_MS,
);

test(
  '하위 세션의 비용을 부모 비용 상한에 더한다',
  async () => {
    const project = createProject();
    const usage = (uncached: number) => ({
      uncachedInputTokens: uncached,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
    });
    await runCli(
      project,
      [
        { ...respond(delegate('d1', 'scout', '조사한다')), usage: usage(10) },
        { ...respond({ type: 'text', text: '조사를 마쳤습니다.' }), usage: usage(100) },
        { ...finalReport, usage: usage(10) },
      ],
      {
        config: {
          pricing: { 'fake/scripted': { inputPerMTok: 1_000_000, outputPerMTok: 0 } },
          session: { maxCost: 1000 },
        },
      },
    );

    const { parent } = splitSessions(project.home);
    const end = parent.events.find((event) => event.type === 'delegate_end');
    expect(end?.payload).toMatchObject({ cost: 100 });
    const requests = parent.events.flatMap((event) =>
      event.type === 'model_request' && event.payload.role === 'default' ? [event.payload] : [],
    );
    expect(requests[1]).toMatchObject({ costRatioPct: 12 });
  },
  TEST_TIMEOUT_MS,
);

test(
  '병렬 하위 세션이 부모와 같은 비용 합계를 더하므로 합계가 상한에 닿으면 하위 세션이 다음 요청을 보내지 않는다',
  async () => {
    const project = createProject();
    const usage = {
      uncachedInputTokens: 600,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
    };
    const loop = { ...respond(use('l', 'file_read', { path: 'foo.js' })), usage };
    await runCli(
      project,
      [
        {
          ...respond(delegate('p1', 'scout', '조사 하나'), delegate('p2', 'scout', '조사 둘')),
          usage: { ...usage, uncachedInputTokens: 10 },
        },
        ...Array.from({ length: 8 }, () => loop),
      ],
      {
        config: {
          pricing: { 'fake/scripted': { inputPerMTok: 1_000_000, outputPerMTok: 0 } },
          session: { maxCost: 1000 },
        },
      },
    );

    const { parent } = splitSessions(project.home);
    const ends = parent.events.flatMap((event) =>
      event.type === 'delegate_end' ? [event.payload] : [],
    );
    expect(ends).toHaveLength(2);
    expect(ends.some((end) => end.endReason === 'cost_limit')).toBe(true);
    // 상한이 하위 세션마다 따로였다면 각자 두 번씩 요청해 합계가 2400이 된다.
    expect(ends.reduce((sum, end) => sum + end.cost, 0)).toBeLessThanOrEqual(1800);
  },
  TEST_TIMEOUT_MS,
);

test(
  '위임 결과의 바꾼 파일은 그 하위 세션이 쓴 파일만 담는다',
  async () => {
    const project = createProject();
    const write = (callId: string, path: string) =>
      respond(use(callId, 'file_write', { path, content: `${path}\n` }));
    await runCli(project, [
      respond(delegate('p1', 'task', '파일 하나'), delegate('p2', 'task', '파일 둘')),
      write('w1', 'a.txt'),
      write('w2', 'b.txt'),
      respond({ type: 'text', text: '썼습니다.' }),
      respond({ type: 'text', text: '썼습니다.' }),
      finalReport,
    ]);

    const { parent } = splitSessions(project.home);
    const lists = parent.events.flatMap((event) =>
      event.type === 'delegate_end' ? [event.payload.changedFiles] : [],
    );
    expect(lists).toHaveLength(2);
    expect([...lists.flat()].sort()).toEqual(['a.txt', 'b.txt']);
    // 합집합을 돌려줬다면 두 목록이 같은 파일을 담는다.
    expect(lists[0]?.some((file) => lists[1]?.includes(file))).toBe(false);
  },
  TEST_TIMEOUT_MS,
);

test(
  '부모를 재개하면 끝난 하위 세션의 비용을 다시 더해, 부모와 하위 세션의 합계가 상한이면 첫 요청을 보내지 않는다',
  async () => {
    const project = createProject();
    const usage = (uncached: number) => ({
      uncachedInputTokens: uncached,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
    });
    const config = {
      pricing: { 'fake/scripted': { inputPerMTok: 1_000_000, outputPerMTok: 0 } },
      session: { maxCost: 1000 },
    };
    await runCli(
      project,
      [
        { ...respond(delegate('d1', 'scout', '조사한다')), usage: usage(10) },
        { ...respond(use('l', 'file_read', { path: 'foo.js' })), usage: usage(600) },
        { ...respond({ type: 'text', text: '조사를 마쳤습니다.' }), usage: usage(600) },
        { ...finalReport, usage: usage(10) },
      ],
      { config },
    );
    const before = splitSessions(project.home).parent;
    expect(before.record).toMatchObject({ status: 'stopped', endReason: 'cost_limit' });
    const requestCount = (events: OraEvent[]) =>
      events.filter((event) => event.type === 'model_request').length;

    const scriptPath = join(project.home, 'resume-script.json');
    writeFileSync(
      scriptPath,
      JSON.stringify({ responses: [{ ...finalReport, usage: usage(10) }] }),
    );
    const { promise, resolve } = Promise.withResolvers<undefined>();
    execFile(
      process.execPath,
      [
        CLI_PATH,
        'resume',
        before.id,
        '--model-script',
        scriptPath,
        '--config',
        join(project.home, 'engine.config.json'),
      ],
      { cwd: project.dir, env: { ...process.env, ORA_HOME: project.home } },
      () => {
        resolve(undefined);
      },
    );
    await promise;

    const after = splitSessions(project.home).parent;
    // 하위 세션 비용을 더하지 않으면 부모 비용은 20뿐이라 재개한 부모가 요청을 보냈을 것이다.
    expect(requestCount(after.events)).toBe(requestCount(before.events));
    expect(after.record).toMatchObject({ status: 'stopped', endReason: 'cost_limit' });
  },
  TEST_TIMEOUT_MS,
);

interface Running {
  readonly child: ChildProcess;
  readonly port: number;
  readonly home: string;
  readonly dir: string;
  cookie: string;
}

function send(running: Running, path: string, method = 'GET', body?: unknown) {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; text: string }>();
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const req = httpRequest(
    {
      host: '127.0.0.1',
      port: running.port,
      path,
      method,
      headers: {
        cookie: running.cookie,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
    },
    (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
      });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, text });
      });
    },
  );
  req.on('error', reject);
  req.end(payload);
  return promise;
}

async function startServer(responses: Response[]): Promise<Running> {
  const project = createProject();
  const web = join(project.home, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<title>ORA</title>');
  const script = join(project.home, 'script.json');
  writeFileSync(script, JSON.stringify({ responses }));
  const child = spawn(
    process.execPath,
    [CLI_PATH, 'serve', '--model-script', script, '--web-dir', web],
    {
      cwd: project.dir,
      env: { ...process.env, ORA_HOME: project.home, ORA_OPEN_COMMAND: 'true' },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
    if (output.includes('\n')) resolve(output.split('\n')[0] ?? '');
  });
  child.on('close', () => {
    reject(new Error('serve가 시작 URL을 출력하기 전에 끝났습니다.'));
  });
  const startUrl = await promise;
  const running: Running = {
    child,
    port: Number(new URL(startUrl).port),
    home: project.home,
    dir: project.dir,
    cookie: '',
  };
  const entry = await new Promise<string>((done, fail) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: running.port, path: `/${new URL(startUrl).search}` },
      (res) => {
        res.resume();
        done(String(res.headers['set-cookie']));
      },
    );
    req.on('error', fail);
    req.end();
  });
  running.cookie = entry.split(';')[0] ?? '';
  return running;
}

async function stopServer(running: Running): Promise<void> {
  const closed = Promise.withResolvers<undefined>();
  running.child.once('close', () => {
    closed.resolve(undefined);
  });
  running.child.kill('SIGINT');
  await closed.promise;
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 800; attempt += 1) {
    if (await condition()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('조건을 기다리다 시간이 지났습니다.');
}

async function createParent(running: Running, permissionMode: string): Promise<string> {
  const reply = await send(running, '/api/sessions', 'POST', {
    task: '결제 모듈을 손본다',
    cwd: running.dir,
    permissionMode,
  });
  expect(reply.status).toBe(201);
  return (JSON.parse(reply.text) as { sessionId: string }).sessionId;
}

interface Pending {
  requestId: string;
  request: {
    callId: string;
    from?: { agent: string; sessionId: string };
    detail: { command?: string };
  };
}

async function nextApproval(running: Running, sessionId: string): Promise<Pending> {
  const read = async () =>
    (
      JSON.parse((await send(running, `/api/sessions/${sessionId}`)).text) as {
        pendingApprovals?: Pending[];
      }
    ).pendingApprovals ?? [];
  await waitFor(async () => (await read()).length > 0);
  const [found] = await read();
  if (found === undefined) throw new Error('승인 요청이 사라졌습니다.');
  return found;
}

function eventsOf(running: Running, sessionId: string): OraEvent[] {
  return readSessions(running.home).find((session) => session.id === sessionId)?.events ?? [];
}

test(
  '하위 세션의 승인 요청은 부모 세션으로 올라가고 "이 하위 세션 동안 허용"은 그 하위 세션에만 적용한다',
  async () => {
    const running = await startServer([
      respond(delegate('d1', 'task', '파일을 만든다')),
      respond(use('c1', 'shell', { command: 'touch a.txt' })),
      respond(use('c2', 'shell', { command: 'touch a.txt' })),
      respond({ type: 'text', text: '만들었습니다.' }),
      respond(use('p1', 'shell', { command: 'touch a.txt' })),
      finalReport,
    ]);
    try {
      const parentId = await createParent(running, 'always-ask');
      const first = await nextApproval(running, parentId);
      expect(first.request).toMatchObject({ callId: 'c1', from: { agent: 'task' } });
      expect(first.request.from?.sessionId).not.toBe(parentId);
      await send(running, `/api/sessions/${parentId}/approval`, 'POST', {
        requestId: first.requestId,
        decision: { outcome: 'approved', scope: 'session' },
      });

      const second = await nextApproval(running, parentId);
      expect(second.request.callId).toBe('p1');
      expect(second.request.from).toBeUndefined();
      await send(running, `/api/sessions/${parentId}/approval`, 'POST', {
        requestId: second.requestId,
        decision: { outcome: 'approved', scope: 'once' },
      });
      await waitFor(() => existsSync(join(running.dir, 'a.txt')));
      const asked = eventsOf(running, parentId).flatMap((event) =>
        event.type === 'approval_request' ? [event.payload.callId] : [],
      );
      expect(asked).toEqual(['p1']);
    } finally {
      await stopServer(running);
    }
  },
  TEST_TIMEOUT_MS,
);

async function startDelegatedSleep(): Promise<{
  running: Running;
  parentId: string;
  childId: string;
}> {
  const running = await startServer([
    respond(delegate('d1', 'task', '오래 걸리는 일을 한다')),
    respond(use('c1', 'shell', { command: 'sleep 2' })),
    respond({ type: 'text', text: '끝났습니다.' }),
    finalReport,
  ]);
  const parentId = await createParent(running, 'bypass-permissions');
  let childId = '';
  try {
    await waitFor(() => {
      const start = eventsOf(running, parentId).find((event) => event.type === 'delegate_start');
      if (start?.type !== 'delegate_start') return false;
      childId = start.payload.childSessionId;
      return true;
    });
  } catch (error) {
    await stopServer(running);
    throw error;
  }
  return { running, parentId, childId };
}

test(
  '위임 카드의 중지는 그 하위 세션만 멈추고 부모는 중지 결과를 tool result로 받는다',
  async () => {
    const { running, parentId, childId } = await startDelegatedSleep();
    try {
      const reply = await send(running, `/api/sessions/${childId}/cancel`, 'POST', {
        mode: 'soft',
      });
      expect(reply.status).toBe(200);
      await waitFor(() => toolResult(eventsOf(running, parentId), 'd1') !== undefined);
      expect(toolResult(eventsOf(running, parentId), 'd1')).toMatchObject({ status: 'aborted' });
      const child = readSessions(running.home).find((session) => session.id === childId);
      expect(child?.record).toMatchObject({ status: 'interrupted', endReason: 'user_cancel' });
      expect(eventsOf(running, parentId).some((event) => event.type === 'cancel')).toBe(false);
    } finally {
      await stopServer(running);
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  '부모를 중지하면 하위 세션도 멈춘다',
  async () => {
    const { running, parentId, childId } = await startDelegatedSleep();
    try {
      await send(running, `/api/sessions/${parentId}/cancel`, 'POST', { mode: 'soft' });
      const statusOf = (id: string) =>
        readSessions(running.home).find((session) => session.id === id)?.record;
      // session.json은 session_end 이벤트 뒤에 쓰므로 기록의 상태가 바뀌길 기다린다.
      await waitFor(
        () =>
          statusOf(childId)?.status === 'interrupted' &&
          statusOf(parentId)?.status === 'interrupted',
      );
      expect(statusOf(childId)).toMatchObject({ status: 'interrupted', endReason: 'user_cancel' });
      expect(statusOf(parentId)).toMatchObject({ status: 'interrupted' });
    } finally {
      await stopServer(running);
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  '정의 폴더 밖의 경로는 열지 않고, 정의 폴더 안의 파일과 폴더는 열며, 폴더 안의 심볼릭 링크가 밖을 가리키면 거부한다',
  async () => {
    const running = await startServer([finalReport]);
    try {
      const agentsDir = join(running.home, 'agents');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, 'a.md'), '---\ndescription: x\ntools: [tier:read]\n---\n');
      symlinkSync('/etc/hosts', join(agentsDir, 'escape.md'));
      const open = (path: string) => send(running, '/api/open-path', 'POST', { path });

      expect((await open('/etc/hosts')).status).toBe(403);
      expect((await open(join(agentsDir, 'escape.md'))).status).toBe(403);
      expect((await open(join(running.dir, 'foo.js'))).status).toBe(403);
      expect((await open(join(agentsDir, 'a.md'))).status).toBe(200);
      expect((await open(agentsDir)).status).toBe(200);
    } finally {
      await stopServer(running);
    }
  },
  TEST_TIMEOUT_MS,
);
