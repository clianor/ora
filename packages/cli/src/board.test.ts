import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { oraEventSchema } from '@ora/protocol';
import type { BoardCardView, BoardResponse } from '@ora/protocol';
import { expect, test } from 'vitest';

const CLI_PATH = fileURLToPath(new URL('./main.ts', import.meta.url));
const TEST_TIMEOUT_MS = 90_000;
const POLL_MS = 50;
const POLL_LIMIT = 1200;

type Block = Record<string, unknown>;
const use = (callId: string, tool: string, input: Record<string, unknown>): Block => ({
  type: 'tool_use',
  callId,
  tool,
  input: { intent: `${tool} call`, ...input },
});
const advance = (callId: string, to: string, skipReason?: string): Block =>
  use(callId, 'stage.advance', { to, ...(skipReason === undefined ? {} : { skipReason }) });
const declareTodo = (verifyCommand: string): Block =>
  use('t0', 'todo.update', {
    todos: [
      { id: 't1', content: '작업을 한다', writeScope: [], verify: { command: verifyCommand } },
    ],
  });
/** 최상위 세션이 todo 하나를 선언하고 검증을 통과해 `completed`로 끝나는 스크립트다. */
const completeScript = [
  { content: [declareTodo('node check.mjs')] },
  { content: [advance('a1', 'plan', '작은 작업이라 조사가 필요 없다')] },
  { content: [advance('a2', 'execute')] },
  { content: [use('t1', 'todo.update', { todos: [{ id: 't1', status: 'attempted' }] })] },
  { content: [advance('a3', 'verify')] },
  { content: [use('v1', 'verify.run', { todoId: 't1' })] },
  { content: [advance('a4', 'operate')] },
  { content: [advance('a5', 'learn')] },
  { content: [{ type: 'text', text: '끝났습니다.' }] },
];

interface Running {
  readonly child: ChildProcess;
  readonly port: number;
  readonly home: string;
  readonly dir: string;
  readonly cookie: string;
}

function send(
  running: { port: number; cookie: string },
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<{ status: number; text: string; headers: Record<string, unknown> }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    status: number;
    text: string;
    headers: Record<string, unknown>;
  }>();
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
        resolve({ status: res.statusCode ?? 0, text, headers: res.headers });
      });
    },
  );
  req.on('error', reject);
  req.end(payload);
  return promise;
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
    if (await condition()) return;
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
  throw new Error('timed out waiting for condition');
}

async function startServer(responses: object[], isBypass = true): Promise<Running> {
  const root = mkdtempSync(join(tmpdir(), 'ora-board-'));
  const dir = join(root, 'project');
  const home = join(root, 'home');
  const web = join(root, 'web');
  for (const path of [dir, home, web]) mkdirSync(path);
  const realDir = realpathSync(dir);
  writeFileSync(join(web, 'index.html'), '<title>ORA</title>');
  writeFileSync(join(realDir, 'check.mjs'), "console.log('ok');\n");
  mkdirSync(join(realDir, 'docs'));
  writeFileSync(join(realDir, 'fail.mjs'), 'process.exit(1);\n');
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: realDir });
  const script = join(home, 'script.json');
  writeFileSync(script, JSON.stringify({ responses }));
  const configPath = join(home, 'engine.config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      permissions: { mode: isBypass ? 'bypass-permissions' : 'always-ask' },
    }),
  );
  const child = spawn(
    process.execPath,
    [CLI_PATH, 'serve', '--model-script', script, '--web-dir', web, '--config', configPath],
    { cwd: realDir, env: { ...process.env, ORA_HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const { promise, resolve } = Promise.withResolvers<string>();
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
    if (output.includes('\n')) resolve(output.split('\n')[0] ?? '');
  });
  const startUrl = await promise;
  const port = Number(new URL(startUrl).port);
  const entry = await send({ port, cookie: '' }, `/${new URL(startUrl).search}`);
  const cookie = String(entry.headers['set-cookie']).split(';')[0] ?? '';
  return { child, port, home, dir: realDir, cookie };
}

async function stopServer(running: Running): Promise<void> {
  const closed = Promise.withResolvers<undefined>();
  running.child.once('close', () => {
    closed.resolve(undefined);
  });
  running.child.kill('SIGINT');
  await closed.promise;
}

async function cardRequest(
  running: Running,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; card?: BoardCardView; sessionId?: string }> {
  const reply = await send(
    running,
    path,
    method,
    body === undefined ? undefined : { repo: running.dir, ...(body as object) },
  );
  const parsed = reply.text === '' ? {} : (JSON.parse(reply.text) as Record<string, unknown>);
  return { status: reply.status, ...parsed };
}

async function readBoard(running: Running): Promise<BoardResponse> {
  const reply = await send(running, `/api/board?repo=${encodeURIComponent(running.dir)}`);
  return JSON.parse(reply.text) as BoardResponse;
}

async function cardStatus(running: Running, id: string): Promise<string | undefined> {
  return (await readBoard(running)).cards.find((card) => card.id === id)?.status;
}

function readEvents(running: Running, sessionId: string) {
  const path = join(running.home, 'sessions', sessionId, 'transcript.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line) => {
      try {
        const parsed = oraEventSchema.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
}

const createCard = async (running: Running, body: object) =>
  cardRequest(running, 'POST', '/api/board/cards', body);
const startCard = async (running: Running, id: string, worktree = running.dir) =>
  cardRequest(running, 'POST', `/api/board/cards/${id}/start`, { worktree });

async function finishBuilder(running: Running, verifyCommand: string): Promise<string> {
  const built = await createCard(running, {
    title: 'build',
    lane: 'builder',
    verifyCommand,
    writeScope: [],
  });
  const id = built.card?.id ?? '';
  expect((await startCard(running, id)).status).toBe(201);
  await waitFor(async () => (await cardStatus(running, id)) === 'done');
  return id;
}

// (가) 사용자가 보드에서 카드를 만들고 시작하고 고치고 지우는 흐름을 실제 서버로 확인한다.
test(
  '보드 서버가 카드 규칙을 강제하고 시작한 카드에 세션을 붙인다',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const running = await startServer(completeScript);
    try {
      const noParent = await createCard(running, { title: 'v', lane: 'verifier' });
      expect(noParent.status).toBe(400);

      const parent = await createCard(running, { title: 'build', lane: 'builder' });
      const parentId = parent.card?.id ?? '';
      const wrongParent = await createCard(running, { title: 'r', lane: 'reviewer', parentId });
      expect(wrongParent.status).toBe(201);
      const nested = await createCard(running, {
        title: 'v',
        lane: 'verifier',
        parentId: wrongParent.card?.id,
      });
      expect(nested.status).toBe(400);

      const batch = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          createCard(running, { title: `card ${index}`, lane: 'docs' }),
        ),
      );
      expect(batch.every((reply) => reply.status === 201)).toBe(true);
      expect((await readBoard(running)).cards).toHaveLength(10);

      const outside = await startCard(running, parentId, tmpdir());
      expect(outside.status).toBe(403);

      const started = await startCard(running, parentId);
      expect(started.status).toBe(201);
      expect(started.card?.sessionIds).toEqual([started.sessionId]);
      await waitFor(async () => (await cardStatus(running, parentId)) === 'done');

      const relane = await cardRequest(running, 'PATCH', `/api/board/cards/${parentId}`, {
        lane: 'docs',
      });
      expect(relane.status).toBe(409);
      const retitle = await cardRequest(running, 'PATCH', `/api/board/cards/${parentId}`, {
        title: 'renamed',
      });
      expect(retitle.card?.title).toBe('renamed');

      const child = await createCard(running, { title: 'v', lane: 'verifier', parentId });
      const removed = await cardRequest(
        running,
        'DELETE',
        `/api/board/cards/${parentId}?repo=${encodeURIComponent(running.dir)}`,
      );
      expect(removed.status).toBe(200);
      const orphan = (await readBoard(running)).cards.find((card) => card.id === child.card?.id);
      expect(orphan?.parentDeleted).toBe(true);
    } finally {
      await stopServer(running);
    }
  },
);

// (가) 세션이 승인을 기다리는 카드는 지울 수 없고, 그 카드를 부모로 둔 verifier는 시작할 수 없다.
test('실행 중인 카드는 삭제와 verifier 시작을 거부한다', { timeout: TEST_TIMEOUT_MS }, async () => {
  const running = await startServer(
    [{ content: [use('c1', 'shell', { command: 'echo hi' })] }],
    false,
  );
  try {
    const parent = await createCard(running, {
      title: 'build',
      lane: 'builder',
      verifyCommand: 'node check.mjs',
    });
    const parentId = parent.card?.id ?? '';
    await startCard(running, parentId);
    await waitFor(async () => (await cardStatus(running, parentId)) === 'awaiting_approval');

    const removed = await cardRequest(
      running,
      'DELETE',
      `/api/board/cards/${parentId}?repo=${encodeURIComponent(running.dir)}`,
    );
    expect(removed.status).toBe(409);
    const child = await createCard(running, { title: 'v', lane: 'verifier', parentId });
    const refused = await startCard(running, child.card?.id ?? '');
    expect(refused.status).toBe(409);
    expect(refused.card).toBeUndefined();
  } finally {
    await stopServer(running);
  }
});

// (가) verifier 카드는 모델 요청 없이 부모의 검증 명령을 돌리고 그 결과로 끝난다.
test(
  'verifier 카드가 모델 없이 검증 명령을 돌려 결과로 끝난다',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const running = await startServer(completeScript);
    try {
      const parentId = await finishBuilder(running, 'node check.mjs');
      const passing = await createCard(running, { title: 'v', lane: 'verifier', parentId });
      const passed = await startCard(running, passing.card?.id ?? '');
      await waitFor(async () => (await cardStatus(running, passing.card?.id ?? '')) === 'done');
      const events = readEvents(running, passed.sessionId ?? '');
      expect(events.some((event) => event.type === 'model_request')).toBe(false);
      expect(events.some((event) => event.type === 'verification')).toBe(true);

      const failing = await createCard(running, {
        title: 'v2',
        lane: 'verifier',
        parentId,
        verifyCommand: 'node fail.mjs',
      });
      await startCard(running, failing.card?.id ?? '');
      await waitFor(async () => (await cardStatus(running, failing.card?.id ?? '')) === 'failed');
    } finally {
      await stopServer(running);
    }
  },
);

// (가) docs와 qa 카드의 세션은 자기 경로 밖 쓰기를 거부하고 안쪽 쓰기는 허용한다.
test('docs와 qa 정의는 범위 밖 쓰기를 거부한다', { timeout: TEST_TIMEOUT_MS }, async () => {
  const writes = ['src/a.js', 'docs/a.md', 'a.test.js'];
  const running = await startServer([
    { content: [declareTodo('node check.mjs')] },
    { content: [advance('a1', 'plan', '작은 작업이라 조사가 필요 없다')] },
    { content: [advance('a2', 'execute')] },
    {
      content: writes.map((path, index) =>
        use(`w${index}`, 'file_write', { path, content: 'x\n' }),
      ),
    },
    { content: [{ type: 'text', text: '끝났습니다.' }] },
  ]);
  const results = (sessionId: string) => {
    const events = readEvents(running, sessionId);
    return writes.flatMap((_, index) =>
      events.flatMap((event) =>
        event.type === 'tool_result' && event.payload.callId === `w${String(index)}`
          ? [event.payload.status]
          : [],
      ),
    );
  };
  try {
    const expected = { docs: ['error', 'ok', 'error'], qa: ['error', 'error', 'ok'] };
    for (const lane of ['docs', 'qa'] as const) {
      const card = await createCard(running, { title: lane, lane });
      const started = await startCard(running, card.card?.id ?? '');
      const sessionId = started.sessionId ?? '';
      await waitFor(() => results(sessionId).length === 3);
      expect(results(sessionId)).toEqual(expected[lane]);
    }
  } finally {
    await stopServer(running);
  }
});
