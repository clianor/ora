import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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

async function startServer(responses: { content: Block[] }[]): Promise<Running> {
  const root = mkdtempSync(join(tmpdir(), 'ora-serve-'));
  const dir = join(root, 'project');
  const home = join(root, 'home');
  const web = join(root, 'web');
  for (const path of [dir, home, web]) mkdirSync(path);
  writeFileSync(join(web, 'index.html'), '<title>ORA-INDEX</title>');
  const script = join(home, 'script.json');
  writeFileSync(script, JSON.stringify({ responses }));
  const child = spawn(
    process.execPath,
    [CLI_PATH, 'serve', '--model-script', script, '--web-dir', web],
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
  const running: Running = { child, startUrl, port, home, dir, cookie: '' };
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
  return { seqs, types, named, close: () => req.destroy() };
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
          questions: [{ question: '어느 방식으로 하나요?', options: ['가', '나'] }],
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
        payload: { status: 'ok', summary: expect.stringContaining('답: 나') as string },
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
