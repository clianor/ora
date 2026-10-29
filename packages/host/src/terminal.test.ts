import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { terminalListResponseSchema, terminalResponseSchema } from '@ora/protocol';
import { afterEach, expect, test } from 'vitest';
import { startLocalServer } from './server.ts';
import type { LocalServer } from './server.ts';

const servers: LocalServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function boot() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ora-terminal-')));
  const server = await startLocalServer({
    env: { ORA_HOME: home, SHELL: '/bin/sh', PATH: process.env.PATH ?? '' },
    cwd: home,
    modelScriptPath: join(home, 'unused.json'),
    port: 0,
  });
  servers.push(server);
  const start = await fetch(server.startUrl, { redirect: 'manual' });
  const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${server.origin}${path}`, {
      ...init,
      headers: { cookie, 'content-type': 'application/json' },
    });
  const post = (path: string, body: unknown) =>
    call(path, { method: 'POST', body: JSON.stringify(body) });
  return { home, server, call, post };
}

/** SSE 출력을 base64로 풀어 모으고, 조건이 맞거나 스트림이 끝나면 돌려준다. */
async function readOutput(response: Response, done: (text: string) => boolean) {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (reader === undefined) throw new Error('본문이 없습니다.');
  const decoder = new TextDecoder();
  let raw = '';
  let text = '';
  let exitCode: number | undefined;
  while (!done(text) && exitCode === undefined) {
    const { value, done: ended } = await reader.read();
    if (ended) break;
    raw += decoder.decode(value, { stream: true });
    text = '';
    for (const block of raw.split('\n\n')) {
      const event = /^event: (\w+)\ndata: (.*)$/m.exec(block);
      if (event === null) continue;
      const data = JSON.parse(event[2] ?? '{}') as { data?: string; exitCode?: number };
      if (event[1] === 'output') text += Buffer.from(data.data ?? '', 'base64').toString('utf8');
      else exitCode = data.exitCode;
    }
  }
  await reader.cancel();
  return { text, exitCode };
}

test('터미널에 명령을 입력하면 SSE로 출력이 오고, 다시 연결하면 버퍼가 오며, 종료하면 exited가 된다', async () => {
  const { home, call, post } = await boot();
  const created = terminalResponseSchema.parse(
    await (await post('/api/terminals', { cwd: home, cols: 80, rows: 24 })).json(),
  );
  const base = `/api/terminals/${created.terminal.id}`;

  const first = await call(`${base}/output`);
  expect((await post(`${base}/input`, { data: 'echo ora-$((20+22))\n' })).status).toBe(200);
  expect((await readOutput(first, (text) => text.includes('ora-42'))).text).toContain('ora-42');

  const again = await call(`${base}/output`);
  expect((await readOutput(again, (text) => text.includes('ora-42'))).text).toContain('ora-42');

  expect((await post(`${base}/resize`, { cols: 100, rows: 30 })).status).toBe(200);
  expect((await post(`${base}/kill`, {})).status).toBe(200);
  const ended = await readOutput(await call(`${base}/output`), () => false);
  expect(ended.exitCode).toBeTypeOf('number');
  const list = terminalListResponseSchema.parse(
    await (await call(`/api/terminals?cwd=${encodeURIComponent(home)}`)).json(),
  );
  expect(list.terminals).toMatchObject([{ status: 'exited', cols: 100, rows: 30 }]);
});

test('토큰이 없는 요청과 알려진 worktree 밖의 폴더는 거부한다', async () => {
  const { server, post } = await boot();
  const anonymous = await fetch(`${server.origin}/api/terminals`, {
    method: 'POST',
    body: JSON.stringify({ cwd: '/', cols: 80, rows: 24 }),
  });
  expect(anonymous.status).toBe(401);
  const outside = await post('/api/terminals', { cwd: tmpdir(), cols: 80, rows: 24 });
  expect(outside.status).toBe(403);
});
