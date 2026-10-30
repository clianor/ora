import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
import type { OraEvent } from '@ora/protocol';
import { expect, test } from 'vitest';

const CLI_PATH = fileURLToPath(new URL('./main.ts', import.meta.url));
const TIMEOUT_MS = 90_000;

type Block = Record<string, unknown>;
const use = (callId: string, tool: string, input: Record<string, unknown>): Block => ({
  type: 'tool_use',
  callId,
  tool,
  input: { intent: `${tool} 호출`, ...input },
});
const respond = (...blocks: Block[]) => ({ content: blocks });
const finalText = respond({ type: 'text', text: '마쳤습니다.' });

interface Running {
  child: ChildProcess;
  port: number;
  home: string;
  dir: string;
  script: string;
  cookie: string;
}

function send(running: Running, path: string, method = 'GET', body?: unknown, cookie = true) {
  const { promise, resolve, reject } = Promise.withResolvers<{
    status: number;
    text: string;
    headers: Record<string, string | string[] | undefined>;
  }>();
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const req = httpRequest(
    {
      host: '127.0.0.1',
      port: running.port,
      path,
      method,
      headers: {
        ...(cookie ? { cookie: running.cookie } : {}),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
    },
    (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, text, headers: res.headers });
      });
    },
  );
  req.on('error', reject);
  req.end(payload);
  return promise;
}

async function waitFor(condition: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    if (await condition()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('조건을 기다리다 시간이 지났습니다.');
}

async function startServer(responses: { content: Block[] }[], isGit: boolean): Promise<Running> {
  const root = mkdtempSync(join(tmpdir(), 'ora-rewind-'));
  const dir = join(root, 'project');
  const home = join(root, 'home');
  const web = join(root, 'web');
  for (const path of [dir, home, web]) mkdirSync(path);
  const realDir = realpathSync(dir);
  writeFileSync(join(web, 'index.html'), '<title>ORA</title>');
  writeFileSync(join(realDir, 'a.txt'), 'A0');
  writeFileSync(join(realDir, 'b.txt'), 'B0');
  writeFileSync(join(realDir, 'keep.txt'), 'K0');
  if (isGit) {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: realDir, stdio: 'ignore' });
    git('init', '--quiet', '-b', 'main');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    git('add', '-A');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'init');
  }
  const script = join(home, 'script.json');
  writeFileSync(script, JSON.stringify({ responses }));
  const child = spawn(
    process.execPath,
    [CLI_PATH, 'serve', '--model-script', script, '--web-dir', web],
    {
      cwd: realDir,
      env: { ...process.env, ORA_HOME: home },
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
    home,
    dir: realDir,
    script,
    cookie: '',
  };
  const entry = await send(running, `/${new URL(startUrl).search}`, 'GET', undefined, false);
  running.cookie = String(entry.headers['set-cookie']).split(';')[0] ?? '';
  return running;
}

async function stopServer(running: Running) {
  const closed = Promise.withResolvers<undefined>();
  running.child.once('close', () => {
    closed.resolve(undefined);
  });
  running.child.kill('SIGINT');
  await closed.promise;
}

function readEvents(running: Running, sessionId: string): OraEvent[] {
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

async function createSession(running: Running, task: string, cwd = running.dir) {
  const reply = await send(running, '/api/sessions', 'POST', {
    task,
    cwd,
    permissionMode: 'bypass-permissions',
  });
  expect(reply.status).toBe(201);
  return (JSON.parse(reply.text) as { sessionId: string }).sessionId;
}

async function detail(running: Running, sessionId: string) {
  return JSON.parse((await send(running, `/api/sessions/${sessionId}`)).text) as {
    session: { status: string };
    live: boolean;
  };
}

async function waitDone(running: Running, sessionId: string) {
  await waitFor(async () => {
    const found = await detail(running, sessionId);
    return (
      !found.live && readEvents(running, sessionId).some((event) => event.type === 'session_end')
    );
  });
}

const firstUserSeq = (events: OraEvent[]) =>
  events.find((event) => event.type === 'message' && event.actor === 'user')?.seq ?? 0;

test(
  '되돌리기는 세션이 바꾼 파일을 복원하고 새 파일을 지우며, 사용자가 고친 파일은 경고하고 건드리지 않은 파일은 두고, 취소하면 되돌리기 직전으로 돌아간다',
  async () => {
    const running = await startServer(
      [
        respond(use('w1', 'file_write', { path: 'a.txt', content: 'A1' })),
        respond(use('s1', 'shell', { command: 'echo B1 > b.txt' })),
        respond(use('w2', 'file_write', { path: 'c.txt', content: 'C1' })),
        finalText,
      ],
      true,
    );
    const read = (name: string) => readFileSync(join(running.dir, name), 'utf8');
    try {
      const id = await createSession(running, '파일을 바꾼다');
      await waitDone(running, id);
      const seq = firstUserSeq(readEvents(running, id));
      const statusBefore = (await detail(running, id)).session.status;
      writeFileSync(join(running.dir, 'keep.txt'), 'mine');
      writeFileSync(join(running.dir, 'a.txt'), 'A-user');

      const preview = JSON.parse(
        (await send(running, `/api/sessions/${id}/rewind-preview?seq=${seq}`)).text,
      ) as {
        restoreFiles: string[];
        deleteFiles: string[];
        overwrittenFiles: { path: string }[];
        isGitRepo: boolean;
      };
      expect(preview.isGitRepo).toBe(true);
      expect([...preview.restoreFiles].sort()).toEqual(['a.txt', 'b.txt']);
      expect(preview.deleteFiles).toEqual(['c.txt']);
      expect(preview.overwrittenFiles.map((file) => file.path)).toEqual(['a.txt']);

      const rewound = await send(running, `/api/sessions/${id}/rewind`, 'POST', { seq });
      expect(rewound.text).toContain('eventSeq');
      expect(read('a.txt')).toBe('A0');
      expect(read('b.txt')).toBe('B0');
      expect(existsSync(join(running.dir, 'c.txt'))).toBe(false);
      expect(read('keep.txt')).toBe('mine');
      const statusAfter = (await detail(running, id)).session.status;
      expect(statusAfter).toBe(statusBefore === 'completed' ? 'interrupted' : statusBefore);
      expect(readEvents(running, id).some((event) => event.type === 'rewind')).toBe(true);

      const undone = await send(running, `/api/sessions/${id}/rewind-undo`, 'POST');
      expect(undone.status).toBe(200);
      expect(read('a.txt')).toBe('A-user');
      expect(read('b.txt')).toBe('B1\n');
      expect(read('c.txt')).toBe('C1');
      expect((await detail(running, id)).session.status).toBe(statusBefore);
    } finally {
      await stopServer(running);
    }
  },
  TIMEOUT_MS,
);

test(
  '세션이 실행 중이거나 같은 워크트리의 다른 세션이 실행 중이면 되돌리기를 거부한다',
  async () => {
    const running = await startServer(
      [respond(use('s1', 'shell', { command: 'sleep 2' })), finalText],
      true,
    );
    try {
      const first = await createSession(running, '첫 세션');
      await waitDone(running, first);
      const seq = firstUserSeq(readEvents(running, first));
      const second = await createSession(running, '둘째 세션');
      await waitFor(() => readEvents(running, second).some((event) => event.type === 'tool_call'));
      const other = await send(running, `/api/sessions/${first}/rewind`, 'POST', { seq });
      expect(other.status).toBe(409);
      expect(other.text).toContain('다른 세션이 실행 중');
      const own = await send(running, `/api/sessions/${second}/rewind`, 'POST', {
        seq: firstUserSeq(readEvents(running, second)),
      });
      expect(own.status).toBe(409);
      expect(own.text).toContain('세션을 멈춘 뒤 쓸 수 있습니다');
      await waitDone(running, second);
    } finally {
      await stopServer(running);
    }
  },
  TIMEOUT_MS,
);

test(
  'git 저장소가 아닌 폴더에서는 대화만 되돌리고 파일은 그대로 둔다',
  async () => {
    const running = await startServer(
      [respond(use('w1', 'file_write', { path: 'a.txt', content: 'A1' })), finalText],
      false,
    );
    try {
      const id = await createSession(running, '파일을 바꾼다');
      await waitDone(running, id);
      const seq = firstUserSeq(readEvents(running, id));
      const preview = JSON.parse(
        (await send(running, `/api/sessions/${id}/rewind-preview?seq=${seq}`)).text,
      ) as { isGitRepo: boolean; restoreFiles: string[]; deleteFiles: string[] };
      expect(preview).toMatchObject({ isGitRepo: false, restoreFiles: [], deleteFiles: [] });
      const rewound = await send(running, `/api/sessions/${id}/rewind`, 'POST', { seq });
      expect(rewound.text).toContain('eventSeq');
      expect(readFileSync(join(running.dir, 'a.txt'), 'utf8')).toBe('A1');
      expect(readEvents(running, id).some((event) => event.type === 'rewind')).toBe(true);
    } finally {
      await stopServer(running);
    }
  },
  TIMEOUT_MS,
);

test(
  '수정하기는 되돌린 뒤 수정한 메시지로 세션을 이어 가고, 되돌린 메시지는 이후 모델 입력에 다시 들어가지 않는다',
  async () => {
    const running = await startServer(
      [respond(use('w1', 'file_write', { path: 'n.txt', content: 'N1' })), finalText],
      true,
    );
    let sessionId = '';
    try {
      sessionId = await createSession(running, 'ORIGINAL-TASK-TEXT');
      await waitDone(running, sessionId);
      const seq = firstUserSeq(readEvents(running, sessionId));
      const edited = await send(running, `/api/sessions/${sessionId}/edit`, 'POST', {
        seq,
        text: 'EDITED-TASK-TEXT',
      });
      expect(edited.status).toBe(200);
      await waitFor(async () => {
        const found = await detail(running, sessionId);
        return (
          !found.live &&
          readEvents(running, sessionId).filter((event) => event.type === 'session_end').length ===
            2
        );
      });
      const texts = readEvents(running, sessionId).flatMap((event) =>
        event.type === 'message' && event.actor === 'user' ? [JSON.stringify(event.payload)] : [],
      );
      expect(texts.some((text) => text.includes('EDITED-TASK-TEXT'))).toBe(true);
    } finally {
      await stopServer(running);
    }
    const log = join(running.home, 'model-input.jsonl');
    writeFileSync(running.script, JSON.stringify({ responses: [finalText] }));
    const resumed = spawnSync(
      process.execPath,
      [
        CLI_PATH,
        'resume',
        sessionId,
        '--model-script',
        running.script,
        '--record-model-input',
        log,
        '--steer',
        'NEXT-TEXT',
      ],
      { cwd: running.dir, env: { ...process.env, ORA_HOME: running.home }, encoding: 'utf8' },
    );
    expect(resumed.stderr + resumed.stdout).toContain('세션:');
    const input = readFileSync(log, 'utf8');
    expect(input).toContain('EDITED-TASK-TEXT');
    expect(input).not.toContain('ORIGINAL-TASK-TEXT');
  },
  TIMEOUT_MS,
);
