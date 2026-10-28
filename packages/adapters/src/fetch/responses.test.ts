import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelRequest, ModelStreamEvent } from '@ora/core';
import { afterEach, expect, test, vi } from 'vitest';
import { createAccountStore } from './accounts.ts';
import type { CatalogModel } from './catalog.ts';
import { GROK_PROVIDER, loginGrok } from './grok.ts';
import { createFetchModel } from './model.ts';
import { streamAnthropicMessages } from '../anthropic.ts';
import { streamOpenAICodexResponses, streamOpenAIResponses } from './openai-responses.ts';

const NOW = Date.parse('2026-10-29T03:00:00Z');

const closers: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const close of closers.splice(0)) close();
});

interface Seen {
  readonly headers: IncomingHttpHeaders;
  readonly body: Record<string, unknown>;
}

const sse = (events: Record<string, unknown>[]) =>
  events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');

async function startServer(
  respond: (seen: Seen[]) => { status: number; body: string },
): Promise<{ baseUrl: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      });
      const reply = respond(seen);
      res.writeHead(reply.status, {
        'content-type': reply.status === 200 ? 'text/event-stream' : 'application/json',
      });
      res.end(reply.body);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { baseUrl: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, seen };
}

const codexModel = (baseUrl: string): CatalogModel => ({
  id: 'gpt-5.5',
  provider: 'codex',
  wire: 'openai-codex-responses',
  baseUrl,
  contextWindow: 200_000,
  maxOutputTokens: 1000,
  cacheTtl: '1h',
});

const drain = async (stream: AsyncIterable<ModelStreamEvent>) => {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
};

// (나) 병렬 도구 호출, 암호화 reasoning 왕복, usage 정규화는 실제 서버 응답으로 만들 수 없다.
test('Codex 요청은 계정 헤더와 store:false를 보내고, 병렬 도구 호출과 reasoning을 되돌려 보내며 usage를 정규화한다', async () => {
  const { baseUrl, seen } = await startServer(() => ({
    status: 200,
    body: sse([
      { type: 'response.reasoning_summary_text.delta', delta: '생각' },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: '생각' }],
          encrypted_content: 'enc-1',
        },
      },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: { type: 'function_call', call_id: 'c1', name: 'todo__update', arguments: '{"a":1}' },
      },
      {
        type: 'response.output_item.done',
        output_index: 2,
        item: { type: 'function_call', call_id: 'c2', name: 'fs__read', arguments: '{"p":"x"}' },
      },
      {
        type: 'response.completed',
        response: {
          output: [],
          usage: {
            input_tokens: 100,
            output_tokens: 7,
            input_tokens_details: { cached_tokens: 40 },
          },
        },
      },
    ]),
  }));
  const tools = [
    { name: 'todo.update', description: 'todo', inputSchema: { type: 'object' } },
    { name: 'fs.read', description: 'read', inputSchema: { type: 'object' } },
  ];
  const credential = { kind: 'oauth', token: 'tok-1', accountId: 'acct-1' } as const;
  const run = (request: ModelRequest) =>
    drain(
      streamOpenAICodexResponses({
        model: codexModel(baseUrl),
        credential,
        request,
        signal: new AbortController().signal,
        options: { sessionId: 'sess-1', effort: 'low' },
      }),
    );

  const first = await run({
    system: 'Ora 시스템',
    messages: [{ role: 'user', content: [{ type: 'text', text: '시작' }] }],
    tools,
  });

  const completed = first.at(-1);
  expect(first[0]).toEqual({ type: 'thinking_delta', text: '생각' });
  expect(completed).toMatchObject({
    type: 'completed',
    stopReason: 'tool_use',
    usage: {
      uncachedInputTokens: 60,
      cacheReadInputTokens: 40,
      cacheCreationInputTokens: 0,
      outputTokens: 7,
    },
  });
  const content = completed?.type === 'completed' ? completed.content : [];
  expect(content.filter((block) => block.type === 'tool_use')).toEqual([
    { type: 'tool_use', callId: 'c1', tool: 'todo.update', input: { a: 1 } },
    { type: 'tool_use', callId: 'c2', tool: 'fs.read', input: { p: 'x' } },
  ]);

  const [request] = seen;
  expect(request?.headers).toMatchObject({
    authorization: 'Bearer tok-1',
    'chatgpt-account-id': 'acct-1',
    'openai-beta': 'responses=experimental',
    originator: 'ora',
    'session-id': 'sess-1',
  });
  expect(request?.body).toMatchObject({
    model: 'gpt-5.5',
    store: false,
    stream: true,
    instructions: 'Ora 시스템',
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: 'sess-1',
  });
  expect(request?.body).not.toHaveProperty('temperature');
  expect(request?.body).not.toHaveProperty('max_output_tokens');

  await run({
    system: 'Ora 시스템',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '시작' }] },
      { role: 'assistant', content },
      {
        role: 'user',
        content: [
          { type: 'tool_result', callId: 'c1', text: 'ok', isError: false },
          { type: 'tool_result', callId: 'c2', text: 'ok', isError: false },
        ],
      },
    ],
    tools,
  });
  const input = seen[1]?.body.input as Record<string, unknown>[];
  expect(input).toContainEqual(
    expect.objectContaining({ type: 'reasoning', encrypted_content: 'enc-1' }),
  );
  expect(input).toContainEqual({ type: 'function_call_output', call_id: 'c2', output: 'ok' });
});

// (나) slow_down과 refresh token 미회전 응답은 실제 xAI 서버로 만들 수 없다.
test('xAI 디바이스 로그인은 slow_down이면 간격을 늘리고, 갱신 응답에 refresh token이 없으면 기존 값을 유지한다', async () => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  const polls: string[] = [];
  const answers = [
    { status: 400, body: { error: 'authorization_pending' } },
    { status: 400, body: { error: 'slow_down' } },
    {
      status: 200,
      body: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 100 },
    },
  ];
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = request.url;
    if (url.endsWith('/device/code')) {
      return Promise.resolve(
        Response.json({
          device_code: 'dev-1',
          user_code: 'ABCD',
          verification_uri: 'https://auth.x.ai/device',
          interval: 5,
          expires_in: 900,
        }),
      );
    }
    polls.push(await request.text());
    const answer = answers[polls.length - 1];
    return Response.json(answer?.body, { status: answer?.status ?? 500 });
  };
  const sleeps: number[] = [];
  const tokens = await loginGrok({
    print: () => undefined,
    fetch: fakeFetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });

  expect(sleeps).toEqual([5000, 5000, 10_000]);
  expect(polls[0]).toContain('device_code=dev-1');
  expect(tokens).toEqual({
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: NOW + 100_000,
  });

  const refreshed = await GROK_PROVIDER.refresh('refresh-1', () =>
    Promise.resolve(Response.json({ access_token: 'access-2' })),
  );
  expect(refreshed).toEqual({
    accessToken: 'access-2',
    refreshToken: 'refresh-1',
    expiresAt: NOW + 3_600_000,
  });
});

// (나) 사용량 한도 429 응답과 계정 전환은 실제 서버로 만들 수 없다.
test('usage_limit_reached 429를 받은 계정은 리셋 시각까지 건너뛰고 다음 계정으로 요청한다', async () => {
  const { baseUrl, seen } = await startServer((all) => {
    if (all.at(-1)?.headers.authorization === 'Bearer tok-a') {
      return {
        status: 429,
        body: JSON.stringify({
          error: { code: 'usage_limit_reached', message: 'limit', resets_in_seconds: 3600 },
        }),
      };
    }
    return {
      status: 200,
      body: sse([
        {
          type: 'response.completed',
          response: {
            output: [{ type: 'message', content: [{ type: 'output_text', text: '안녕' }] }],
            usage: { input_tokens: 3, output_tokens: 1 },
          },
        },
      ]),
    };
  });
  const store = createAccountStore({
    path: join(mkdtempSync(join(tmpdir(), 'ora-codex-')), 'auth.json'),
    env: {},
    now: () => NOW,
  });
  for (const [name, access] of [
    ['a', 'tok-a'],
    ['b', 'tok-b'],
  ] as const) {
    await store.save('codex', {
      kind: 'oauth',
      name,
      accessToken: access,
      refreshToken: 'refresh',
      expiresAt: NOW + 3_600_000,
      accountUuid: `acct-${name}`,
    });
  }
  const model = createFetchModel({
    catalog: codexModel(baseUrl),
    store,
    now: () => NOW,
    wireOptions: { now: () => NOW },
  });
  const request: ModelRequest = {
    system: 's',
    messages: [{ role: 'user', content: [{ type: 'text', text: '안녕' }] }],
    tools: [],
  };
  const signal = new AbortController().signal;

  const events = await drain(model.stream(request, signal));
  await drain(model.stream(request, signal));

  expect(events.at(-1)).toMatchObject({
    type: 'completed',
    content: [{ type: 'text', text: '안녕' }],
  });
  expect(seen.map((entry) => entry.headers['chatgpt-account-id'])).toEqual([
    'acct-a',
    'acct-b',
    'acct-b',
  ]);
});

const completedFrame = (text: string) => ({
  type: 'response.completed',
  response: {
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 3, output_tokens: 1 },
  },
});

// (나) 일시적 속도 제한 429는 실제 서버로 만들 수 없다.
test('rate_limit_exceeded 429는 계정을 막지 않고 retry-after만큼 기다린 뒤 같은 계정으로 다시 보낸다', async () => {
  let calls = 0;
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls += 1;
      seen.push({ headers: req.headers, body: {} });
      if (calls === 1) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' });
        res.end(
          JSON.stringify({
            error: {
              code: 'rate_limit_exceeded',
              message: 'Rate limit reached for gpt-5.5. Please try again in 2s.',
            },
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse([completedFrame('다시')]));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const store = createAccountStore({
    path: join(mkdtempSync(join(tmpdir(), 'ora-codex-')), 'auth.json'),
    env: {},
    now: () => NOW,
  });
  await store.save('codex', {
    kind: 'oauth',
    name: 'only',
    accessToken: 'tok-only',
    refreshToken: 'refresh',
    expiresAt: NOW + 3_600_000,
    accountUuid: 'acct-only',
  });
  const sleeps: number[] = [];
  const model = createFetchModel({
    catalog: codexModel(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`),
    store,
    now: () => NOW,
    wireOptions: {
      now: () => NOW,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    },
  });

  const events = await drain(
    model.stream(
      {
        system: 's',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
        tools: [],
      },
      new AbortController().signal,
    ),
  );

  expect(sleeps).toEqual([2000]);
  expect(seen.map((entry) => entry.headers['chatgpt-account-id'])).toEqual([
    'acct-only',
    'acct-only',
  ]);
  expect(events.at(-1)).toMatchObject({ type: 'completed' });
});

// (나) 스트림 안의 실패·중단 이벤트는 실제 서버로 만들 수 없다.
test('response.failed와 error 이벤트는 오류로 드러나고, incomplete는 길이 제한이면 max_tokens로 끝나며 콘텐츠 필터면 오류다', async () => {
  const frames = [
    [{ type: 'response.failed', response: { error: { code: 'server_error', message: '망가짐' } } }],
    [{ type: 'error', code: 'boom', message: '스트림 오류' }],
    [
      {
        type: 'response.incomplete',
        response: { incomplete_details: { reason: 'content_filter' } },
      },
    ],
    [
      {
        type: 'response.incomplete',
        response: {
          output: [{ type: 'message', content: [{ type: 'output_text', text: '잘림' }] }],
          incomplete_details: { reason: 'max_output_tokens' },
        },
      },
    ],
  ];
  const { baseUrl } = await startServer((seen) => ({
    status: 200,
    body: sse(frames[seen.length - 1] ?? []),
  }));
  const run = () =>
    drain(
      streamOpenAICodexResponses({
        model: codexModel(baseUrl),
        credential: { kind: 'oauth', token: 'tok', accountId: 'acct' },
        request: { system: 's', messages: [{ role: 'user', content: [] }], tools: [] },
        signal: new AbortController().signal,
        options: {},
      }),
    );

  await expect(run()).rejects.toThrow(/server_error.*망가짐/);
  await expect(run()).rejects.toThrow(/boom.*스트림 오류/);
  await expect(run()).rejects.toThrow(/콘텐츠 필터/);
  expect((await run()).at(-1)).toMatchObject({ type: 'completed', stopReason: 'max_tokens' });
});

// (나) 프로바이더가 바뀐 세션 이어받기는 실제 서버 조합으로 만들 수 없다.
test('다른 서버가 남긴 reasoning 서명은 Claude와 다른 Responses 서버에 다시 보내지 않는다', async () => {
  const codex = await startServer(() => ({
    status: 200,
    body: sse([
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'reasoning', summary: [], encrypted_content: 'enc-codex' },
      },
      completedFrame('끝'),
    ]),
  }));
  const first = await drain(
    streamOpenAICodexResponses({
      model: codexModel(codex.baseUrl),
      credential: { kind: 'oauth', token: 'tok', accountId: 'acct' },
      request: { system: 's', messages: [{ role: 'user', content: [] }], tools: [] },
      signal: new AbortController().signal,
      options: {},
    }),
  );
  const done = first.at(-1);
  const content = done?.type === 'completed' ? done.content : [];
  expect(content[0]).toMatchObject({ type: 'thinking' });
  const history: ModelRequest = {
    system: 's',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '시작' }] },
      { role: 'assistant', content },
      { role: 'user', content: [{ type: 'text', text: '계속' }] },
    ],
    tools: [],
  };

  const grok = await startServer(() => ({ status: 200, body: sse([completedFrame('grok')]) }));
  await drain(
    streamOpenAIResponses({
      model: { ...codexModel(grok.baseUrl), provider: 'grok', wire: 'openai-responses' },
      credential: { kind: 'oauth', token: 'tok' },
      request: history,
      signal: new AbortController().signal,
      options: {},
    }),
  );
  expect(JSON.stringify(grok.seen[0]?.body)).not.toContain('enc-codex');

  const claude = await startServer(() => ({
    status: 200,
    body: sse([
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]),
  }));
  await drain(
    streamAnthropicMessages({
      model: {
        ...codexModel(claude.baseUrl),
        id: 'claude-haiku-5-5',
        provider: 'claude',
        wire: 'anthropic-messages',
      },
      credential: { kind: 'apiKey', token: 'key' },
      request: history,
      signal: new AbortController().signal,
      options: {},
    }),
  );
  expect(JSON.stringify(claude.seen[0]?.body)).not.toContain('responsesReasoning');
  expect(JSON.stringify(claude.seen[0]?.body)).not.toContain('"thinking"');
});
