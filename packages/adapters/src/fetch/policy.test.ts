import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelStreamEvent } from '@ora/core';
import { afterEach, expect, test } from 'vitest';
import { createAccountStore } from './accounts.ts';
import type { CatalogModel } from './catalog.ts';
import { createFetchModel } from './model.ts';
import type { FetchModelOptions } from './model.ts';
import type { AccountPolicy } from './select.ts';

const START = Date.parse('2026-10-29T03:00:00Z');
const TTL_PASSED_MS = 61_000;
const token = (name: string) => `sk-ant-oat01-${name.repeat(40)}`;

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

/** 남은 사용량을 `remaining`에서 읽는 가짜 사용량 서버(fetch)와, 받은 토큰을 기록하는 가짜 `/v1/messages` 서버다. */
async function setup(names: readonly string[]) {
  const remaining: Record<string, number | 'fail'> = {};
  const limited = new Set<string>();
  const used: string[] = [];
  const usageReads: string[] = [];
  const server = createServer((req, res) => {
    req.resume();
    const bearer = String(req.headers.authorization).replace('Bearer ', '');
    const name = names.find((candidate) => token(candidate) === bearer) ?? '?';
    req.on('end', () => {
      used.push(name);
      if (limited.has(name)) {
        res.writeHead(429, {
          'content-type': 'application/json',
          'anthropic-ratelimit-unified-status': 'rejected',
        });
        res.end(JSON.stringify({ error: { message: 'You have reached your usage limit.' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const frames = [
        { type: 'message_start', message: { usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ];
      res.end(
        frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''),
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const catalog: CatalogModel = {
    id: 'claude-haiku-5-5',
    provider: 'claude',
    wire: 'anthropic-messages',
    baseUrl: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    contextWindow: 200_000,
    maxOutputTokens: 1000,
    cacheTtl: '1h',
  };
  let clock = START;
  const store = createAccountStore({
    path: join(mkdtempSync(join(tmpdir(), 'ora-policy-')), 'auth.json'),
    env: {},
    now: () => clock,
  });
  for (const name of names) {
    await store.save('claude', {
      kind: 'oauth',
      name,
      accessToken: token(name),
      refreshToken: token(name.toUpperCase()),
      expiresAt: START + 24 * 3_600_000,
    });
  }
  const usageFetch: typeof fetch = (input, init) => {
    expect(input).toBe('https://api.anthropic.com/api/oauth/usage');
    const bearer = String((init?.headers as Record<string, string>).authorization).replace(
      'Bearer ',
      '',
    );
    const name = names.find((candidate) => token(candidate) === bearer) ?? '?';
    usageReads.push(name);
    const value = remaining[name];
    if (value === undefined || value === 'fail')
      return Promise.resolve(new Response('nope', { status: 500 }));
    return Promise.resolve(
      Response.json({ five_hour: { utilization: 100 - value }, seven_day: { utilization: 0 } }),
    );
  };
  const create = (options: Partial<FetchModelOptions> & { policies?: AccountPolicy[] } = {}) =>
    createFetchModel({ catalog, store, now: () => clock, fetch: usageFetch, ...options });
  const send = async (model: ReturnType<typeof create>) => {
    used.length = 0;
    const events: ModelStreamEvent[] = [];
    for await (const event of model.stream(
      {
        system: 's',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [],
      },
      new AbortController().signal,
    ))
      events.push(event);
    expect(events.at(-1)?.type).toBe('completed');
    return [...used];
  };
  return {
    remaining,
    limited,
    usageReads,
    create,
    send,
    /** 시계를 앞으로 보낸다. 기본값은 사용량 캐시(60초)가 지나는 시간이다. */
    advance: (ms = TTL_PASSED_MS) => {
      clock += ms;
    },
  };
}

const policy = (account: string, rest: Partial<AccountPolicy> = {}): AccountPolicy => ({
  provider: 'claude',
  account,
  priority: 0,
  ...rest,
});

// 가짜 서버로만 만들 수 있는 입력(남은 사용량 값, 한도 응답)이라 단위로 둔다.
test('새 세션은 우선순위가 높아도 예비 한도 안에 든 계정은 건너뛰고, 정책이 없는 계정은 로그인 차례를 따른다', async () => {
  const env = await setup(['a', 'b', 'c']);
  env.remaining.a = 5;
  env.remaining.b = 80;
  env.remaining.c = 80;
  const model = env.create({ policies: [policy('a', { priority: 9 })], reservePct: 10 });

  expect(await env.send(model)).toEqual(['b']);
});

test('고정한 세션은 높은 우선순위 계정이 회복해도 옮기지 않고, 고정 계정이 예비 한도에 들고 다른 계정이 예비 밖일 때만 옮긴다', async () => {
  const env = await setup(['a', 'b']);
  env.remaining.a = 5;
  env.remaining.b = 80;
  const model = env.create({ policies: [policy('a', { priority: 9 })] });
  expect(await env.send(model)).toEqual(['b']);

  env.remaining.a = 90;
  env.advance();
  expect(await env.send(model)).toEqual(['b']);

  env.remaining.b = 5;
  env.advance();
  expect(await env.send(model)).toEqual(['a']);
});

test('reclaimAbovePct를 넘게 회복하면 낮은 우선순위 계정에 고정한 세션이 다음 요청에서 돌아온다', async () => {
  const env = await setup(['a', 'b']);
  env.remaining.a = 5;
  env.remaining.b = 80;
  const model = env.create({ policies: [policy('a', { priority: 9, reclaimAbovePct: 50 })] });
  expect(await env.send(model)).toEqual(['b']);

  env.remaining.a = 40;
  env.advance();
  expect(await env.send(model)).toEqual(['b']);

  env.remaining.a = 60;
  env.advance();
  expect(await env.send(model)).toEqual(['a']);
});

test('지정한 계정은 순위로 옮기지 않고, 막혔을 때만 다른 계정으로 넘어갔다가 풀리면 돌아온다', async () => {
  const env = await setup(['a', 'b']);
  env.remaining.a = 90;
  env.remaining.b = 80;
  const model = env.create({ account: 'b', policies: [policy('a', { priority: 9 })] });
  expect(await env.send(model)).toEqual(['b']);
  expect(await env.send(model)).toEqual(['b']);

  env.limited.add('b');
  expect(await env.send(model)).toEqual(['b', 'a']);
  expect(await env.send(model)).toEqual(['a']);

  env.limited.delete('b');
  env.advance(6 * 60_000);
  expect(await env.send(model)).toEqual(['b']);
});

test('재개한 세션은 저장한 고정 정보로 같은 계정을 이어 쓴다', async () => {
  const env = await setup(['a', 'b']);
  env.remaining.a = 90;
  env.remaining.b = 80;
  const first = env.create({ policies: [policy('a', { priority: 1 })] });
  expect(await env.send(first)).toEqual(['a']);
  expect(first.accountPin?.()).toMatchObject({ provider: 'claude', account: 'a' });

  const pin = { provider: 'claude', account: 'b', lastUsedAt: new Date(START).toISOString() };
  const resumed = env.create({ policies: [policy('a', { priority: 1 })], pin });
  expect(await env.send(resumed)).toEqual(['b']);
  expect(resumed.accountPin?.()?.account).toBe('b');
});

test('사용량을 읽지 못한 계정은 읽은 계정보다 뒤에 두고, 읽지 못해도 요청은 막히지 않는다', async () => {
  const env = await setup(['a', 'b']);
  env.remaining.a = 'fail';
  env.remaining.b = 50;
  const model = env.create({ policies: [policy('a', { priority: 9 })] });
  expect(await env.send(model)).toEqual(['b']);

  const allFail = await setup(['a', 'b']);
  allFail.remaining.a = 'fail';
  allFail.remaining.b = 'fail';
  const unmeasured = allFail.create({ policies: [policy('b', { priority: 9 })] });
  expect(await allFail.send(unmeasured)).toEqual(['b']);
  // 실패한 조회도 60초 동안은 다시 부르지 않는다.
  const reads = allFail.usageReads.length;
  await allFail.send(unmeasured);
  expect(allFail.usageReads.length).toBe(reads);
});
