import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import {
  cpSync,
  existsSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
const POLL_MS = 50;
const POLL_LIMIT = 800;

type Block = Record<string, unknown>;

function use(callId: string, tool: string, input: Record<string, unknown>): Block {
  return { type: 'tool_use', callId, tool, input: { intent: `${tool} 호출`, ...input } };
}

function respond(...blocks: Block[]): { content: Block[] } {
  return { content: blocks };
}

const finalText = respond({ type: 'text', text: '마쳤습니다.' });

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly text: string;
}

interface Running {
  readonly child: ChildProcess;
  readonly startUrl: string;
  readonly port: number;
  readonly home: string;
  readonly dir: string;
  cookie: string;
}

function send(
  running: Running,
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    cookie?: boolean;
  } = {},
): Promise<Reply> {
  const { promise, resolve, reject } = Promise.withResolvers<Reply>();
  const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
  const req = httpRequest(
    {
      host: '127.0.0.1',
      port: running.port,
      path,
      method: init.method ?? 'GET',
      headers: {
        ...(init.cookie === false ? {} : { cookie: running.cookie }),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
    },
    (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
      });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text });
      });
    },
  );
  req.on('error', reject);
  req.end(payload);
  return promise;
}

/** 본문을 보내지 않고 Content-Length만 큰 값으로 선언해, 서버가 본문을 읽기 전에 거부하는지 본다. */
function sendRaw(running: Running, requestLine: string, contentLength: number): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  const socket = connect(running.port, '127.0.0.1');
  let received = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    received += chunk;
  });
  socket.on('close', () => {
    resolve(received);
  });
  socket.on('error', () => undefined);
  socket.write(
    `${requestLine}\r\nHost: 127.0.0.1:${running.port}\r\nCookie: ${running.cookie}\r\nContent-Type: application/json\r\nContent-Length: ${contentLength}\r\n\r\n`,
  );
  return promise;
}

async function post(running: Running, path: string, body: unknown): Promise<Reply> {
  return send(running, path, { method: 'POST', body });
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
    if (await condition()) return;
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
  throw new Error('조건을 기다리다 시간이 지났습니다.');
}

const DEMO_DIR = fileURLToPath(new URL('../demo/', import.meta.url));

/** `'demo'`면 `packages/cli/demo`의 시연 스크립트와 설정, 예제 프로젝트를 쓴다. */
async function startServer(
  responses: { content: Block[] }[] | ((home: string) => { content: Block[] }[]) | 'demo',
  gitBranch?: string,
): Promise<Running> {
  const root = mkdtempSync(join(tmpdir(), 'ora-serve-'));
  const dir = join(root, 'project');
  const home = join(root, 'home');
  const web = join(root, 'web');
  for (const path of [dir, home, web]) mkdirSync(path);
  // 서버는 process.cwd()를 기본 cwd로 쓰므로 심볼릭 링크를 푼 경로를 써야 요청한 cwd와 같다.
  const realDir = realpathSync(dir);
  writeFileSync(join(web, 'index.html'), '<title>ORA-INDEX</title>');
  let script = join(DEMO_DIR, 'model-script.json');
  if (responses === 'demo') {
    cpSync(join(DEMO_DIR, 'project'), realDir, { recursive: true });
  } else {
    script = join(home, 'script.json');
    writeFileSync(
      script,
      JSON.stringify({ responses: typeof responses === 'function' ? responses(home) : responses }),
    );
  }
  if (gitBranch !== undefined)
    execFileSync('git', ['init', '--quiet', '-b', gitBranch], { cwd: dir });
  const child = spawn(
    process.execPath,
    [
      CLI_PATH,
      'serve',
      '--model-script',
      script,
      '--web-dir',
      web,
      ...(responses === 'demo' ? ['--config', join(DEMO_DIR, 'engine.config.json')] : []),
    ],
    { cwd: dir, env: { ...process.env, ORA_HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] },
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
  const port = Number(new URL(startUrl).port);
  const running: Running = { child, startUrl, port, home, dir: realDir, cookie: '' };
  const entry = await send(running, `/${new URL(startUrl).search}`, { cookie: false });
  running.cookie = String(entry.headers['set-cookie']).split(';')[0] ?? '';
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

function sessionDirOf(running: Running, sessionId: string): string {
  return join(running.home, 'sessions', sessionId);
}

function readEvents(running: Running, sessionId: string): OraEvent[] {
  const path = join(sessionDirOf(running, sessionId), 'transcript.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line) => {
      const parsed = oraEventSchema.safeParse(safeJson(line));
      return parsed.success ? [parsed.data] : [];
    });
}

function findResult(running: Running, sessionId: string, callId: string) {
  for (const event of readEvents(running, sessionId)) {
    if (event.type === 'tool_result' && event.payload.callId === callId) return event.payload;
  }
  return undefined;
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

async function createSession(running: Running): Promise<string> {
  const reply = await post(running, '/api/sessions', {
    task: '일을 한다',
    cwd: running.dir,
    permissionMode: 'always-ask',
  });
  expect(reply.status).toBe(201);
  return (JSON.parse(reply.text) as { sessionId: string }).sessionId;
}

interface Detail {
  session: { status: string };
  live: boolean;
  maxSteps: number;
  pendingApprovals: { requestId: string; request: Record<string, unknown> }[];
  pendingQuestions: { requestId: string }[];
}

async function detail(running: Running, sessionId: string): Promise<Detail> {
  const body = JSON.parse(
    (await send(running, `/api/sessions/${sessionId}`)).text,
  ) as Partial<Detail>;
  return {
    session: { status: 'created' },
    live: false,
    maxSteps: 0,
    pendingApprovals: [],
    pendingQuestions: [],
    ...body,
  };
}

async function nextApproval(running: Running, sessionId: string) {
  await waitFor(async () => (await detail(running, sessionId)).pendingApprovals.length > 0);
  const [found] = (await detail(running, sessionId)).pendingApprovals;
  if (found === undefined) throw new Error('승인 요청이 사라졌습니다.');
  return found;
}

interface OpenStream {
  readonly seqs: number[];
  readonly types: string[];
  readonly named: string[];
  readonly namedData: { name: string; data: unknown }[];
  close(): void;
}

function openStream(
  running: Running,
  sessionId: string,
  headers: Record<string, string> = {},
): OpenStream {
  const seqs: number[] = [];
  const types: string[] = [];
  const named: string[] = [];
  const namedData: { name: string; data: unknown }[] = [];
  const req = httpRequest(
    {
      host: '127.0.0.1',
      port: running.port,
      path: `/api/sessions/${sessionId}/events`,
      headers: { cookie: running.cookie, ...headers },
    },
    (res) => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const lines = frame.split('\n');
          const data = lines.find((line) => line.startsWith('data: '));
          if (data === undefined) continue;
          const name = lines.find((line) => line.startsWith('event: '));
          if (name !== undefined) {
            named.push(name.slice(7));
            namedData.push({ name: name.slice(7), data: JSON.parse(data.slice(6)) });
            continue;
          }
          const event = oraEventSchema.parse(JSON.parse(data.slice(6)));
          seqs.push(event.seq);
          types.push(event.type);
        }
      });
    },
  );
  req.on('error', () => undefined);
  req.end();
  return { seqs, types, named, namedData, close: () => req.destroy() };
}

// SPEC 9.1절 M1 인수 기준(로컬 서버 보안, 승인, ask_user, 조향, 이벤트 스트림)을 가장 바깥에서 하나씩 확인한다.
test(
  '토큰 없는 요청은 401, 잘못된 Origin과 위조한 Host는 403이며 쿠키는 HttpOnly·SameSite=Strict이고 127.0.0.1에만 바인딩한다',
  async () => {
    const running = await startServer([finalText]);
    try {
      expect(new URL(running.startUrl).hostname).toBe('127.0.0.1');
      const entry = await send(running, `/${new URL(running.startUrl).search}`, { cookie: false });
      expect(entry.status).toBe(302);
      expect(entry.headers.location).toBe('/');
      expect(String(entry.headers['set-cookie'])).toMatch(/HttpOnly/);
      expect(String(entry.headers['set-cookie'])).toMatch(/SameSite=Strict/);

      expect((await send(running, '/api/sessions', { cookie: false })).status).toBe(401);
      expect((await send(running, '/?token=wrong', { cookie: false })).status).toBe(401);
      expect(
        (await send(running, '/api/sessions', { headers: { origin: 'http://evil.example' } }))
          .status,
      ).toBe(403);
      expect(
        (await send(running, '/api/sessions', { headers: { host: 'evil.example' } })).status,
      ).toBe(403);
      const wrongType = await send(running, '/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'x',
      });
      expect(wrongType.status).toBe(415);
      expect(await sendRaw(running, 'POST /api/sessions HTTP/1.1', 5_000_000)).toContain(' 413 ');
      const page = await send(running, '/');
      expect(page.status).toBe(200);
      expect(page.text).toContain('ORA-INDEX');
      expect((await send(running, '/api/sessions')).status).toBe(200);
    } finally {
      await stopServer(running);
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  'always-ask에서 write 호출은 승인 요청을 띄우고, 거부하면 실행하지 않고, 승인하면 실행하며, 고친 명령이 실행되고 원본과 함께 남는다',
  async () => {
    const running = await startServer([
      respond(use('q1', 'shell', { command: 'touch a.txt' })),
      respond(use('q2', 'shell', { command: 'touch b.txt' })),
      respond(use('q3', 'shell', { command: 'echo original > e.txt' })),
      finalText,
    ]);
    try {
      const sessionId = await createSession(running);

      const first = await nextApproval(running, sessionId);
      expect(first.request).toMatchObject({
        callId: 'q1',
        tool: 'shell',
        detail: { kind: 'shell', command: 'touch a.txt', cwd: running.dir, risk: 'low' },
      });
      expect((await detail(running, sessionId)).session.status).toBe('awaiting_approval');
      expect((await detail(running, sessionId)).maxSteps).toBe(50);
      await post(running, `/api/sessions/${sessionId}/approval`, {
        requestId: first.requestId,
        decision: { outcome: 'denied' },
      });

      const second = await nextApproval(running, sessionId);
      expect(second.request).toMatchObject({ callId: 'q2' });
      await post(running, `/api/sessions/${sessionId}/approval`, {
        requestId: second.requestId,
        decision: { outcome: 'approved', scope: 'once' },
      });

      const third = await nextApproval(running, sessionId);
      expect(third.request).toMatchObject({ callId: 'q3' });
      await post(running, `/api/sessions/${sessionId}/approval`, {
        requestId: third.requestId,
        decision: { outcome: 'approved', scope: 'once', editedCommand: 'echo edited > e.txt' },
      });

      await waitFor(
        () =>
          existsSync(join(running.dir, 'e.txt')) &&
          readFileSync(join(running.dir, 'e.txt'), 'utf8').trim() === 'edited',
      );
      expect(existsSync(join(running.dir, 'a.txt'))).toBe(false);
      expect(existsSync(join(running.dir, 'b.txt'))).toBe(true);
      expect(readFileSync(join(running.dir, 'e.txt'), 'utf8').trim()).toBe('edited');

      const order = readEvents(running, sessionId).flatMap((event) =>
        event.type === 'approval_request' || event.type === 'permission'
          ? [`${event.type}:${event.payload.callId}`]
          : [],
      );
      expect(order.slice(0, 4)).toEqual([
        'approval_request:q1',
        'permission:q1',
        'approval_request:q2',
        'permission:q2',
      ]);
      const permissions = readEvents(running, sessionId).flatMap((event) =>
        event.type === 'permission' ? [event.payload] : [],
      );
      expect(permissions).toMatchObject([
        { callId: 'q1', decision: 'denied', originalCommand: 'touch a.txt' },
        { callId: 'q2', decision: 'approved', scope: 'once', originalCommand: 'touch b.txt' },
        {
          callId: 'q3',
          decision: 'approved',
          originalCommand: 'echo original > e.txt',
          editedCommand: 'echo edited > e.txt',
        },
      ]);
    } finally {
      await stopServer(running);
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  'ask_user에 HTTP로 답하면 awaiting_user가 풀리고 답이 tool result가 되어 세션이 이어진다',
  async () => {
    const running = await startServer([
      respond(
        use('u1', 'ask_user', {
          questions: [{ header: '방식', question: '어느 방식으로 하나요?', options: ['가', '나'] }],
        }),
      ),
      finalText,
    ]);
    try {
      const sessionId = await createSession(running);
      let pending: Detail['pendingQuestions'][number] | undefined;
      await waitFor(async () => {
        pending = (await detail(running, sessionId)).pendingQuestions[0];
        return pending !== undefined;
      });
      expect((await detail(running, sessionId)).session.status).toBe('awaiting_user');

      const invalid = await post(running, `/api/sessions/${sessionId}/answer`, {
        requestId: pending?.requestId,
        answers: [{ choices: ['없는 선택지'] }],
      });
      expect(invalid.status).toBe(400);
      const tooMany = await post(running, `/api/sessions/${sessionId}/answer`, {
        requestId: pending?.requestId,
        answers: [{ choices: ['가', '나'] }],
      });
      expect(tooMany.status).toBe(400);

      const answered = await post(running, `/api/sessions/${sessionId}/answer`, {
        requestId: pending?.requestId,
        answers: [{ choices: ['나'] }],
      });
      expect(answered.status).toBe(200);

      await waitFor(() =>
        readEvents(running, sessionId).some(
          (event) => event.type === 'tool_result' && event.payload.callId === 'u1',
        ),
      );
      const result = readEvents(running, sessionId).find(
        (event) => event.type === 'tool_result' && event.payload.callId === 'u1',
      );
      expect(result).toMatchObject({
        payload: {
          status: 'ok',
          summary: expect.stringContaining('Q1. [방식] 어느 방식으로 하나요?') as string,
        },
      });
      expect(
        readEvents(running, sessionId).find((event) => event.type === 'question'),
      ).toMatchObject({ payload: { questions: [{ header: '방식' }] } });
      expect(result).toMatchObject({
        payload: { summary: expect.stringContaining('답: 나') as string },
      });
      expect((await detail(running, sessionId)).session.status).not.toBe('awaiting_user');
      const kinds = readEvents(running, sessionId).flatMap((event) =>
        ['question', 'answer'].includes(event.type) ||
        (event.type === 'tool_result' && event.payload.callId === 'u1')
          ? [event.type]
          : [],
      );
      expect(kinds).toEqual(['question', 'answer', 'tool_result']);
      const repeated = await post(running, `/api/sessions/${sessionId}/answer`, {
        requestId: pending?.requestId,
        answers: [{ choices: ['나'] }],
      });
      expect(repeated.status).toBe(409);
    } finally {
      await stopServer(running);
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  '소프트 스톱으로 interrupted가 된 세션은 조향 메시지로 같은 세션이 이어진다',
  async () => {
    const running = await startServer([
      respond(use('s1', 'shell', { command: 'echo started >> started.txt; sleep 2' })),
      finalText,
    ]);
    try {
      const reply = await post(running, '/api/sessions', {
        task: '일을 한다',
        cwd: running.dir,
        permissionMode: 'bypass-permissions',
      });
      const sessionId = (JSON.parse(reply.text) as { sessionId: string }).sessionId;
      await waitFor(() => existsSync(join(running.dir, 'started.txt')));
      expect(
        (await post(running, `/api/sessions/${sessionId}/cancel`, { mode: 'soft' })).status,
      ).toBe(200);
      await waitFor(async () => {
        const current = await detail(running, sessionId);
        return !current.live && current.session.status === 'interrupted';
      });

      // 연달아 보낸 두 메시지는 하나도 잃지 않는다. 둘째는 재개 중이거나 실행 중이라 쌓였다가 다음 재개에 실린다.
      for (const text of ['첫째 지시', '둘째 지시']) {
        const steer = await post(running, `/api/sessions/${sessionId}/message`, { text });
        expect([200, 202]).toContain(steer.status);
        expect(JSON.parse(steer.text)).toEqual({ sessionId });
      }
      const hasUserText = (text: string) =>
        readEvents(running, sessionId).some(
          (event) =>
            event.type === 'message' &&
            event.actor === 'user' &&
            JSON.stringify(event.payload.content).includes(text),
        );
      await waitFor(
        () =>
          readEvents(running, sessionId).some(
            (event) => event.type === 'resume' && event.payload.steered,
          ) &&
          hasUserText('첫째 지시') &&
          hasUserText('둘째 지시'),
      );
      expect(readdirSync(join(running.home, 'sessions'))).toEqual([sessionId]);
    } finally {
      await stopServer(running);
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  '다른 호스트가 세션 락을 쥐고 있어 조향 재개가 실패하면 steer_failed로 오류와 메시지를 돌려주고 세션은 interrupted로 남는다',
  async () => {
    const running = await startServer([
      respond(use('f1', 'shell', { command: 'echo started >> started.txt; sleep 2' })),
      finalText,
    ]);
    try {
      const reply = await post(running, '/api/sessions', {
        task: '일을 한다',
        cwd: running.dir,
        permissionMode: 'bypass-permissions',
      });
      const sessionId = (JSON.parse(reply.text) as { sessionId: string }).sessionId;
      await waitFor(() => existsSync(join(running.dir, 'started.txt')));
      const stream = openStream(running, sessionId);

      // 살아 있는 다른 프로세스가 같은 세션을 재개하는 중인 상황이다. 이 서버는 락을 잡지 못해 재개를 거부한다.
      writeFileSync(join(sessionDirOf(running, sessionId), 'session.lock'), String(process.pid));
      const steer = await post(running, `/api/sessions/${sessionId}/message`, {
        text: '실패할 지시',
      });
      expect(steer.status).toBe(202);

      await waitFor(() => stream.named.includes('steer_failed'));
      stream.close();
      const failed = stream.namedData.find((entry) => entry.name === 'steer_failed');
      expect(failed?.data).toEqual({
        error: expect.stringMatching(/\S/) as string,
        texts: ['실패할 지시'],
      });

      const current = await detail(running, sessionId);
      expect(current.live).toBe(false);
      expect(current.session.status).toBe('interrupted');
      const events = readEvents(running, sessionId);
      expect(events.some((event) => event.type === 'resume')).toBe(false);
      expect(
        events.some(
          (event) =>
            event.type === 'message' &&
            event.actor === 'user' &&
            JSON.stringify(event.payload.content).includes('실패할 지시'),
        ),
      ).toBe(false);
    } finally {
      await stopServer(running);
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  '승인을 기다리다 소프트 스톱하면 interrupted가 되고, 직전 상태가 cancel 이벤트에 남고, 늦은 응답은 409다',
  async () => {
    const running = await startServer([respond(use('w1', 'shell', { command: 'touch w.txt' }))]);
    try {
      const sessionId = await createSession(running);
      const waiting = await nextApproval(running, sessionId);
      await post(running, `/api/sessions/${sessionId}/cancel`, { mode: 'soft' });
      await waitFor(async () => {
        const current = await detail(running, sessionId);
        return !current.live && current.session.status === 'interrupted';
      });

      const cancel = readEvents(running, sessionId).find((event) => event.type === 'cancel');
      expect(cancel).toMatchObject({
        payload: { mode: 'soft', previousStatus: 'awaiting_approval' },
      });
      expect(existsSync(join(running.dir, 'w.txt'))).toBe(false);
      const late = await post(running, `/api/sessions/${sessionId}/approval`, {
        requestId: waiting.requestId,
        decision: { outcome: 'approved', scope: 'once' },
      });
      expect(late.status).toBe(409);
    } finally {
      await stopServer(running);
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  '이벤트 스트림은 기록된 이벤트를 먼저 보내고 이어서 실시간 이벤트를 seq 순서대로 중복 없이 보내며 Last-Event-ID 다음부터 재생한다',
  async () => {
    const running = await startServer([
      respond(use('e1', 'shell', { command: 'echo hi; sleep 1' })),
      finalText,
    ]);
    try {
      const reply = await post(running, '/api/sessions', {
        task: '일을 한다',
        cwd: running.dir,
        permissionMode: 'bypass-permissions',
      });
      const sessionId = (JSON.parse(reply.text) as { sessionId: string }).sessionId;
      await waitFor(() =>
        readEvents(running, sessionId).some((event) => event.type === 'tool_call'),
      );
      const recorded = readEvents(running, sessionId).length;

      const stream = openStream(running, sessionId);
      await waitFor(() => stream.types.includes('tool_result'));
      const resumed = openStream(running, sessionId, { 'last-event-id': '3' });
      await waitFor(() => resumed.seqs.length > 2);
      stream.close();
      resumed.close();

      expect(stream.types[0]).toBe('session_start');
      expect(stream.seqs).toEqual(stream.seqs.map((_, index) => index + 1));
      expect(Math.max(...stream.seqs)).toBeGreaterThan(recorded);
      expect(resumed.seqs[0]).toBe(4);
    } finally {
      await stopServer(running);
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  '실행 중인 세션에 여러 연결이 엇갈려 붙어도 모든 연결이 seq 1부터 빈틈없이 받는다',
  async () => {
    const running = await startServer([
      // 기록이 커야 transcript를 읽는 동안 실시간 이벤트가 끼어들 틈이 생긴다.
      ...Array.from({ length: 60 }, (_, index) =>
        respond(use(`b${index}`, 'shell', { command: `true # ${'x'.repeat(150_000)}` })),
      ),
      finalText,
    ]);
    try {
      const reply = await post(running, '/api/sessions', {
        task: '일을 한다',
        cwd: running.dir,
        permissionMode: 'bypass-permissions',
      });
      const sessionId = (JSON.parse(reply.text) as { sessionId: string }).sessionId;
      const streams: OpenStream[] = [];
      for (let index = 0; index < 60; index += 1) {
        streams.push(openStream(running, sessionId));
        await new Promise((done) => setTimeout(done, 8));
      }
      await waitFor(() => streams.every((stream) => stream.types.includes('session_end')));
      for (const stream of streams) {
        stream.close();
        expect(stream.seqs).toEqual(stream.seqs.map((_, index) => index + 1));
      }
    } finally {
      await stopServer(running);
    }
  },
  TEST_TIMEOUT_MS,
);

async function approveNext(
  running: Running,
  sessionId: string,
  scope: 'once' | 'session' | 'always',
): Promise<string> {
  const next = await nextApproval(running, sessionId);
  await post(running, `/api/sessions/${sessionId}/approval`, {
    requestId: next.requestId,
    decision: { outcome: 'approved', scope },
  });
  return (next.request as { callId: string }).callId;
}

async function createIn(running: Running, cwd: string): Promise<string> {
  const reply = await post(running, '/api/sessions', {
    task: '일을 한다',
    cwd,
    permissionMode: 'always-ask',
  });
  return (JSON.parse(reply.text) as { sessionId: string }).sessionId;
}

test(
  '항상 승인은 새 세션에서 묻지 않고, 다른 명령과 다른 cwd는 다시 묻고, 깨진 permissions.json은 쓰지 않는다',
  async () => {
    const running = await startServer([
      respond(use('a1', 'shell', { command: 'echo one > one.txt' })),
      respond(use('a2', 'shell', { command: 'echo two > two.txt' })),
      finalText,
    ]);
    try {
      const first = await createSession(running);
      expect(await approveNext(running, first, 'always')).toBe('a1');
      expect(await approveNext(running, first, 'once')).toBe('a2');
      await waitFor(() => existsSync(join(running.dir, 'two.txt')));
      const stored = JSON.parse(readFileSync(join(running.home, 'permissions.json'), 'utf8')) as {
        rules: unknown[];
      };
      expect(stored.rules).toEqual([
        { tool: 'shell', command: 'echo one > one.txt', cwd: running.dir },
      ]);

      // 같은 명령은 묻지 않고 실행하며, 다른 명령(a2)은 다시 묻는다.
      const second = await createSession(running);
      expect(await approveNext(running, second, 'once')).toBe('a2');
      const secondEvents = readEvents(running, second);
      const remembered = secondEvents.find(
        (event) => event.type === 'permission' && event.payload.callId === 'a1',
      );
      expect(remembered).toMatchObject({ payload: { decision: 'approved', scope: 'always' } });
      expect(
        secondEvents.some(
          (event) => event.type === 'approval_request' && event.payload.callId === 'a1',
        ),
      ).toBe(false);

      // 다른 cwd에서는 같은 명령도 다시 묻는다.
      const elsewhere = join(running.dir, 'sub');
      mkdirSync(elsewhere);
      const third = await createIn(running, elsewhere);
      expect(await approveNext(running, third, 'once')).toBe('a1');

      // 파일이 깨졌으면 기억을 쓰지 않아 다시 묻고, 파일은 덮어쓰지 않는다.
      writeFileSync(join(running.home, 'permissions.json'), '{ 깨진 파일');
      const fourth = await createSession(running);
      expect(await approveNext(running, fourth, 'always')).toBe('a1');
      expect(readFileSync(join(running.home, 'permissions.json'), 'utf8')).toBe('{ 깨진 파일');
      // 저장하지 못한 사실은 permission 이벤트의 warning으로 사용자에게 보인다.
      await waitFor(() =>
        readEvents(running, fourth).some(
          (event) => event.type === 'permission' && event.payload.warning !== undefined,
        ),
      );
    } finally {
      await stopServer(running);
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  '이 세션 동안 승인은 하드 킬과 재개 뒤에도 유지된다',
  async () => {
    const running = await startServer([
      respond(use('s1', 'shell', { command: 'echo one >> one.txt' })),
      respond(use('s2', 'shell', { command: 'sleep 30' })),
    ]);
    try {
      const sessionId = await createSession(running);
      expect(await approveNext(running, sessionId, 'session')).toBe('s1');
      expect((await nextApproval(running, sessionId)).request).toMatchObject({ callId: 's2' });
      await post(running, `/api/sessions/${sessionId}/cancel`, { mode: 'hard' });
      await waitFor(async () => {
        const current = await detail(running, sessionId);
        return !current.live && current.session.status === 'crashed';
      });

      await post(running, `/api/sessions/${sessionId}/resume`, {});
      // 재개하면 같은 호출(s1)이 다시 오지만 묻지 않고, 아직 승인하지 않은 s2만 묻는다.
      expect((await nextApproval(running, sessionId)).request).toMatchObject({ callId: 's2' });
      const permissions = readEvents(running, sessionId).flatMap((event) =>
        event.type === 'permission' && event.payload.callId === 's1' ? [event.payload] : [],
      );
      expect(permissions).toMatchObject([
        { decision: 'approved', scope: 'session' },
        { decision: 'approved', scope: 'session' },
      ]);
      const asked = readEvents(running, sessionId).filter(
        (event) => event.type === 'approval_request' && event.payload.callId === 's1',
      );
      expect(asked).toHaveLength(1);
    } finally {
      await stopServer(running);
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  'file_write는 permissions.json과 세션 기록을 쓰지 못하고, auth.json은 읽지도 쓰지도 못한다(링크 폴더 안의 새 파일과 대소문자만 다른 이름 포함)',
  async () => {
    const running = await startServer((home) => [
      respond(
        use('p1', 'file_write', { path: join(home, 'permissions.json'), content: '{}' }),
        use('p2', 'file_write', { path: 'link/permissions.json', content: '{}' }),
        use('p3', 'file_write', {
          path: join(home, 'sessions', 's-20260101-aaaaaa', 'session.json'),
          content: '{}',
        }),
        ...(process.platform === 'darwin'
          ? [use('p4', 'file_write', { path: join(home, 'Permissions.json'), content: '{}' })]
          : []),
      ),
      respond(use('p5', 'file_read', { path: join(home, 'auth.json') })),
      respond(use('p6', 'file_write', { path: join(home, 'auth.json'), content: '{}' })),
      finalText,
    ]);
    try {
      symlinkSync(running.home, join(running.dir, 'link'));
      const reply = await post(running, '/api/sessions', {
        task: '일을 한다',
        cwd: running.dir,
        permissionMode: 'bypass-permissions',
      });
      const sessionId = (JSON.parse(reply.text) as { sessionId: string }).sessionId;
      const calls = [
        ...(process.platform === 'darwin' ? ['p1', 'p2', 'p3', 'p4'] : ['p1', 'p2', 'p3']),
        'p5',
        'p6',
      ];
      await waitFor(() => calls.every((callId) => findResult(running, sessionId, callId)));
      for (const callId of calls) {
        expect(findResult(running, sessionId, callId)).toMatchObject({ status: 'error' });
      }
      expect(existsSync(join(running.home, 'permissions.json'))).toBe(false);
      expect(existsSync(join(running.home, 'sessions', 's-20260101-aaaaaa'))).toBe(false);
      expect(existsSync(join(running.home, 'auth.json'))).toBe(false);
    } finally {
      await stopServer(running);
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  '두 세션이 동시에 항상 승인해도 permissions.json의 규칙이 하나도 사라지지 않는다',
  async () => {
    const running = await startServer([
      respond(use('c1', 'shell', { command: 'true' })),
      finalText,
    ]);
    try {
      const other = join(running.dir, 'sub');
      mkdirSync(other);
      const sessions = await Promise.all([createSession(running), createIn(running, other)]);
      const pending = await Promise.all(sessions.map((id) => nextApproval(running, id)));
      await Promise.all(
        sessions.map((id, index) =>
          post(running, `/api/sessions/${id}/approval`, {
            requestId: pending[index]?.requestId,
            decision: { outcome: 'approved', scope: 'always' },
          }),
        ),
      );
      await waitFor(() => {
        const path = join(running.home, 'permissions.json');
        if (!existsSync(path)) return false;
        return (JSON.parse(readFileSync(path, 'utf8')) as { rules: unknown[] }).rules.length === 2;
      });
      expect(existsSync(join(running.home, 'permissions.json.lock'))).toBe(false);
    } finally {
      await stopServer(running);
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  'GET /api/info는 기본 cwd를 알려 주고 git 저장소이면 브랜치도 알려 준다',
  async () => {
    const plain = await startServer([]);
    const repo = await startServer([], 'trunk');
    try {
      expect(JSON.parse((await send(plain, '/api/info')).text)).toEqual({
        cwd: plain.dir,
        permissionMode: 'always-ask',
        isolation: 'harness',
        maxSteps: 50,
      });
      expect(JSON.parse((await send(repo, '/api/info')).text)).toEqual({
        cwd: repo.dir,
        branch: 'trunk',
        permissionMode: 'always-ask',
        isolation: 'harness',
        maxSteps: 50,
      });
    } finally {
      await stopServer(plain);
      await stopServer(repo);
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  '시연 스크립트는 질문 2개, 승인 3번, 검증을 거쳐 completed로 끝난다',
  async () => {
    const running = await startServer('demo');
    try {
      const sessionId = await createSession(running);
      let question: Detail['pendingQuestions'][number] | undefined;
      await waitFor(async () => {
        question = (await detail(running, sessionId)).pendingQuestions[0];
        return question !== undefined;
      });
      await post(running, `/api/sessions/${sessionId}/answer`, {
        requestId: question?.requestId,
        answers: [{ choices: ['한국어'] }, { choices: ['덧셈', '곱셈'] }],
      });
      for (const callId of ['d6', 'd8', 'd10']) {
        expect(await approveNext(running, sessionId, 'once')).toBe(callId);
      }
      await waitFor(async () => (await detail(running, sessionId)).session.status === 'completed');

      expect(readFileSync(join(running.dir, 'calc.mjs'), 'utf8')).toContain('a + b');
      const todos = JSON.parse(
        readFileSync(join(sessionDirOf(running, sessionId), 'todos.json'), 'utf8'),
      ) as { status: string }[];
      expect(todos.map((todo) => todo.status)).toEqual(['verified']);
    } finally {
      await stopServer(running);
    }
  },
  TEST_TIMEOUT_MS,
);

async function createBypassSession(running: Running): Promise<string> {
  const reply = await post(running, '/api/sessions', {
    task: '일을 한다',
    cwd: running.dir,
    permissionMode: 'bypass-permissions',
  });
  expect(reply.status).toBe(201);
  return (JSON.parse(reply.text) as { sessionId: string }).sessionId;
}

function readTodoStatuses(running: Running, sessionId: string): Record<string, string> {
  const todos = JSON.parse(
    readFileSync(join(sessionDirOf(running, sessionId), 'todos.json'), 'utf8'),
  ) as { id: string; status: string }[];
  return Object.fromEntries(todos.map((todo) => [todo.id, todo.status]));
}

async function waitStopped(running: Running, sessionId: string, status: string): Promise<void> {
  await waitFor(async () => {
    const current = await detail(running, sessionId);
    return !current.live && current.session.status === status;
  });
}

test(
  '실행 중에 포기하면 스텝이 끝난 뒤 반영하고, 멈춘 세션에서는 포기와 포기 취소를 바로 반영한다',
  async () => {
    const running = await startServer([
      respond(
        use('s1', 'todo.update', {
          todos: [{ id: 't1', content: '작업', verify: { command: 'node -e 0' } }],
        }),
      ),
      respond(use('s2', 'shell', { command: 'echo started >> started.txt; sleep 2' })),
      finalText,
    ]);
    try {
      const sessionId = await createBypassSession(running);
      await waitFor(() => existsSync(join(running.dir, 'started.txt')));
      const abandon = await post(running, `/api/sessions/${sessionId}/todo-abandon`, {
        todoId: 't1',
      });
      expect(abandon.status).toBe(202);
      expect(readTodoStatuses(running, sessionId)).toEqual({ t1: 'pending' });

      // 모든 todo를 포기했으므로 세션은 그 스텝이 끝날 때 stopped(abandoned)로 끝난다.
      await waitStopped(running, sessionId, 'stopped');
      const events = readEvents(running, sessionId);
      const end = events.findLast((event) => event.type === 'session_end');
      expect(end).toMatchObject({ payload: { status: 'stopped', endReason: 'abandoned' } });
      const shellDone = events.find(
        (event) => event.type === 'tool_result' && event.payload.callId === 's2',
      );
      const abandoned = events.find(
        (event) =>
          event.type === 'todo_update' &&
          event.actor === 'user' &&
          event.payload.to === 'abandoned',
      );
      expect(abandoned?.seq).toBeGreaterThan(shellDone?.seq ?? Infinity);

      const restore = await post(running, `/api/sessions/${sessionId}/todo-restore`, {
        todoId: 't1',
      });
      expect(restore.status).toBe(200);
      expect(readTodoStatuses(running, sessionId)).toEqual({ t1: 'pending' });
      const lastUpdate = readEvents(running, sessionId).findLast(
        (event) => event.type === 'todo_update',
      );
      expect(lastUpdate).toMatchObject({
        actor: 'user',
        payload: { to: 'pending', current: 't1' },
      });

      expect(
        (await post(running, `/api/sessions/${sessionId}/todo-abandon`, { todoId: 't1' })).status,
      ).toBe(200);
      expect(readTodoStatuses(running, sessionId)).toEqual({ t1: 'abandoned' });
      expect(
        (await post(running, `/api/sessions/${sessionId}/todo-abandon`, { todoId: 't1' })).status,
      ).toBe(409);
      expect(
        (await post(running, `/api/sessions/${sessionId}/todo-abandon`, { todoId: 'nope' })).status,
      ).toBe(404);
    } finally {
      await stopServer(running);
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  '막혀서 멈춘 세션의 막힌 todo를 포기하고 재개하면 Learn 단계부터 이어 가 포기 개수와 함께 완료한다',
  async () => {
    const spec = (id: string) => ({ id, content: `${id} 작업`, verify: { command: 'node -e 0' } });
    const running = await startServer([
      respond(use('s1', 'todo.update', { todos: [spec('t1'), spec('t2')] })),
      respond(
        use('s2', 'todo.update', { todos: [{ id: 't1', status: 'attempted' }] }),
        use('s3', 'verify.run', { todoId: 't1' }),
      ),
      respond(
        use('s4', 'todo.update', {
          todos: [{ id: 't2', status: 'blocked', reason: '환경이 없음' }],
        }),
      ),
      finalText,
    ]);
    try {
      const sessionId = await createBypassSession(running);
      await waitStopped(running, sessionId, 'stopped');
      expect(readTodoStatuses(running, sessionId)).toEqual({ t1: 'verified', t2: 'blocked' });
      expect(
        readEvents(running, sessionId).findLast((event) => event.type === 'session_end'),
      ).toMatchObject({ payload: { endReason: 'blocked' } });

      expect(
        (await post(running, `/api/sessions/${sessionId}/todo-abandon`, { todoId: 't2' })).status,
      ).toBe(200);
      expect((await post(running, `/api/sessions/${sessionId}/resume`, {})).status).toBe(200);
      await waitStopped(running, sessionId, 'completed');

      const events = readEvents(running, sessionId);
      const resumeAt = events.findLastIndex((event) => event.type === 'resume');
      expect(
        events
          .slice(resumeAt)
          .some(
            (event) =>
              event.type === 'stage' &&
              event.payload.outcome === 'entered' &&
              event.payload.stage === 'learn',
          ),
      ).toBe(true);
      const end = events.findLast((event) => event.type === 'session_end');
      expect(end).toMatchObject({ payload: { endReason: 'passed' } });
      expect(end?.type === 'session_end' ? end.payload.summary : '').toContain('포기 1개');
    } finally {
      await stopServer(running);
    }
  },
  TEST_TIMEOUT_MS,
);

const waiveResponses = [
  respond(
    use('w1', 'todo.update', {
      todos: [{ id: 't1', content: '검증 없는 작업', verify: { command: 'true' } }],
    }),
  ),
  respond(
    use('w2', 'todo.update', { todos: [{ id: 't1', status: 'attempted' }] }),
    use('w3', 'verify.run', { todoId: 't1' }),
  ),
  respond(
    use('w4', 'verify.waive', { todoId: 't1', reason: '사용자가 검증 없는 작업을 요청했다' }),
  ),
  finalText,
];

test(
  'bypass-permissions에서도 verify.waive는 승인 카드를 띄우고, 승인하면 verified와 예외 증거가 남는다',
  async () => {
    const running = await startServer(waiveResponses);
    try {
      const sessionId = await createBypassSession(running);
      const asked = await nextApproval(running, sessionId);
      expect(asked.request).toMatchObject({
        tool: 'verify.waive',
        todo: { id: 't1' },
        detail: {
          kind: 'verify_waiver',
          reason: '사용자가 검증 없는 작업을 요청했다',
          command: 'true',
          exitCode: 0,
          findings: [expect.stringContaining('단언 없는 검사')],
        },
      });
      expect(readTodoStatuses(running, sessionId)).toEqual({ t1: 'failed' });
      await post(running, `/api/sessions/${sessionId}/approval`, {
        requestId: asked.requestId,
        decision: { outcome: 'approved', scope: 'once' },
      });
      await waitFor(() => readTodoStatuses(running, sessionId).t1 === 'verified');
      const todos = JSON.parse(
        readFileSync(join(sessionDirOf(running, sessionId), 'todos.json'), 'utf8'),
      ) as { evidence: { waiver: unknown } }[];
      expect(todos[0]?.evidence.waiver).toMatchObject({
        reason: '사용자가 검증 없는 작업을 요청했다',
        approvedBy: 'user',
      });
    } finally {
      await stopServer(running);
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  'verify.waive를 거부하면 todo는 failed 그대로이고 모델이 거부 사실을 받는다',
  async () => {
    const running = await startServer(waiveResponses);
    try {
      const sessionId = await createBypassSession(running);
      const asked = await nextApproval(running, sessionId);
      await post(running, `/api/sessions/${sessionId}/approval`, {
        requestId: asked.requestId,
        decision: { outcome: 'denied' },
      });
      await waitFor(() => findResult(running, sessionId, 'w4') !== undefined);
      expect(findResult(running, sessionId, 'w4')?.summary).toContain('거부');
      expect(readTodoStatuses(running, sessionId)).toEqual({ t1: 'failed' });
    } finally {
      await stopServer(running);
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  'POST /api/sessions의 model은 default 체인 맨 앞에 들어가 source user로 남고, GET /api/routing은 역할별 체인을 돌려준다',
  async () => {
    const running = await startServer((home) => {
      writeFileSync(
        join(home, 'engine.config.json'),
        JSON.stringify({
          schemaVersion: 1,
          roles: { default: { chain: ['claude/config-m', 'codex/user-m:high'] } },
        }),
      );
      return [finalText];
    });
    try {
      const routing = JSON.parse((await send(running, '/api/routing')).text) as {
        roles: Record<string, unknown[]>;
      };
      expect(routing.roles.default).toEqual([
        { provider: 'claude', model: 'config-m', hasAccount: false },
        { provider: 'codex', model: 'user-m', effort: 'high', hasAccount: false },
      ]);
      expect(routing.roles.compaction).toEqual(routing.roles.default);

      const bad = await post(running, '/api/sessions', { task: '일', model: 'nope' });
      expect(bad.status).toBe(400);

      const reply = await post(running, '/api/sessions', {
        task: '일을 한다',
        cwd: running.dir,
        model: 'codex/user-m:high',
      });
      expect(reply.status).toBe(201);
      const { sessionId } = JSON.parse(reply.text) as { sessionId: string };
      await waitFor(() =>
        readEvents(running, sessionId).some((event) => event.type === 'model_request'),
      );
      const session = JSON.parse(
        readFileSync(join(sessionDirOf(running, sessionId), 'session.json'), 'utf8'),
      ) as { models: unknown[] };
      expect(session.models[0]).toEqual({
        model: 'user-m',
        provider: 'codex',
        role: 'default',
        chainPosition: 0,
        effort: 'high',
        source: 'user',
      });
    } finally {
      await stopServer(running);
    }
  },
  TEST_TIMEOUT_MS,
);
