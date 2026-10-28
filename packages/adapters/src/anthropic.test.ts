import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ModelRequest, ModelStreamEvent } from '@ora/core';
import { afterEach, expect, test } from 'vitest';
import { createAnthropicModel } from './anthropic.ts';

const TOKEN = `sk-ant-api03-${'a'.repeat(32)}`;

interface Seen {
  readonly headers: IncomingHttpHeaders;
  readonly body: Record<string, unknown>;
}

type Reply = { status: number; headers?: Record<string, string>; body: string } | 'hang';

const servers: { close: () => void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** 요청마다 `replies`를 차례로 돌려주고, 마지막 응답을 반복한다. */
async function startFakeApi(replies: Reply[]) {
  const seen: Seen[] = [];
  const sockets = new Set<{ destroy: () => void }>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      });
      const reply = replies[Math.min(seen.length - 1, replies.length - 1)];
      if (reply === undefined || reply === 'hang') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(sse([['message_start', { type: 'message_start', message: { usage: {} } }]]));
        return;
      }
      res.writeHead(reply.status, {
        'content-type': reply.status === 200 ? 'text/event-stream' : 'application/json',
        ...reply.headers,
      });
      res.end(reply.body);
    });
  });
  server.on('connection', (socket) => sockets.add(socket));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  servers.push({
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  });
  return { seen, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function sse(events: [string, Record<string, unknown>][]): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

const start = (
  index: number,
  block: Record<string, unknown>,
): [string, Record<string, unknown>] => [
  'content_block_start',
  { type: 'content_block_start', index, content_block: block },
];
const delta = (index: number, body: Record<string, unknown>): [string, Record<string, unknown>] => [
  'content_block_delta',
  { type: 'content_block_delta', index, delta: body },
];
const stop = (index: number): [string, Record<string, unknown>] => [
  'content_block_stop',
  { type: 'content_block_stop', index },
];
const messageStart = (usage: Record<string, number>): [string, Record<string, unknown>] => [
  'message_start',
  { type: 'message_start', message: { usage } },
];
const ending = (reason: string, outputTokens: number): [string, Record<string, unknown>][] => [
  [
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: reason },
      usage: { output_tokens: outputTokens },
    },
  ],
  ['message_stop', { type: 'message_stop' }],
];

const ok = (events: [string, Record<string, unknown>][]): Reply => ({
  status: 200,
  body: sse(events),
});

const request: ModelRequest = {
  system: 'Ora 시스템 프롬프트',
  messages: [{ role: 'user', content: [{ type: 'text', text: '시작' }] }],
  tools: [{ name: 'todo.update', description: 'todo', inputSchema: { type: 'object' } }],
};

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function modelFor(baseUrl: string, delays: number[] = []) {
  return createAnthropicModel({
    model: 'test-model',
    maxTokens: 100,
    baseUrl,
    effort: 'low',
    getApiKey: () => TOKEN,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  });
}

// 실제 API를 부르지 않고 로컬 서버로 응답을 흉내 낸다. 외부 입출력 경계라 e2e로 만들 수 없는 분기를 확인한다.
test('도구 호출 왕복: 요청 헤더·시스템 첫 블록·도구 이름 변환을 지키고 응답을 블록과 사용량으로 모은다', async () => {
  const api = await startFakeApi([
    ok([
      messageStart({
        input_tokens: 10,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 2,
      }),
      start(0, { type: 'text' }),
      delta(0, { type: 'text_delta', text: '안녕' }),
      stop(0),
      start(1, { type: 'tool_use', id: 'toolu_1', name: 'todo__update' }),
      delta(1, { type: 'input_json_delta', partial_json: '{"a":' }),
      delta(1, { type: 'input_json_delta', partial_json: '1}' }),
      stop(1),
      ...ending('tool_use', 7),
    ]),
  ]);
  const model = modelFor(api.baseUrl);
  const events = await collect(
    model.stream(
      {
        ...request,
        messages: [
          ...request.messages,
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', callId: 'toolu_0', tool: 'todo.update', input: { b: 2 } },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', callId: 'toolu_0', text: '결과', isError: false }],
          },
        ],
      },
      new AbortController().signal,
    ),
  );

  expect(events.map((event) => event.type)).toEqual(['text_delta', 'completed']);
  expect(events[1]).toEqual({
    type: 'completed',
    content: [
      { type: 'text', text: '안녕' },
      { type: 'tool_use', callId: 'toolu_1', tool: 'todo.update', input: { a: 1 } },
    ],
    stopReason: 'tool_use',
    usage: {
      uncachedInputTokens: 10,
      cacheReadInputTokens: 4,
      cacheCreationInputTokens: 2,
      outputTokens: 7,
    },
    nativeToolCalls: true,
  });

  const [seen] = api.seen;
  expect(seen?.headers['x-api-key']).toBe(TOKEN);
  expect(seen?.headers.authorization).toBeUndefined();
  expect(seen?.headers['anthropic-beta']).toBeUndefined();
  expect(seen?.body).toMatchObject({
    model: 'test-model',
    stream: true,
    max_tokens: 100,
    system: [
      {
        type: 'text',
        text: 'Ora 시스템 프롬프트',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ],
    tools: [
      {
        name: 'todo__update',
        input_schema: { type: 'object' },
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ],
    output_config: { effort: 'low' },
  });
  const messages = seen?.body.messages as { content: Record<string, unknown>[] }[];
  expect(messages[1]?.content[0]).toMatchObject({
    type: 'tool_use',
    id: 'toolu_0',
    name: 'todo__update',
  });
  expect(messages[2]?.content[0]).toMatchObject({
    type: 'tool_result',
    tool_use_id: 'toolu_0',
    content: '결과',
    is_error: false,
  });
});

test('서명된 thinking 블록은 서명과 함께 모으고 다음 요청에 그대로 돌려주며, 서명 없는 블록은 보내지 않는다', async () => {
  const api = await startFakeApi([
    ok([
      messageStart({ input_tokens: 1 }),
      start(0, { type: 'thinking' }),
      delta(0, { type: 'thinking_delta', thinking: '생각' }),
      delta(0, { type: 'signature_delta', signature: 'SIG-' }),
      delta(0, { type: 'signature_delta', signature: 'NATURE' }),
      stop(0),
      ...ending('end_turn', 1),
    ]),
  ]);
  const model = modelFor(api.baseUrl);
  const [thinking, completed] = await collect(model.stream(request, new AbortController().signal));
  expect(thinking).toEqual({ type: 'thinking_delta', text: '생각' });
  expect(completed).toMatchObject({
    content: [{ type: 'thinking', text: '생각', signature: 'SIG-NATURE' }],
  });

  await collect(
    model.stream(
      {
        ...request,
        messages: [
          ...request.messages,
          {
            role: 'assistant',
            content: [
              { type: 'thinking', text: '서명 있음', signature: 'SIG-NATURE' },
              { type: 'thinking', text: '서명 없음' },
              { type: 'text', text: '답' },
            ],
          },
        ],
      },
      new AbortController().signal,
    ),
  );
  const sent = (api.seen[1]?.body.messages as { content: Record<string, unknown>[] }[])[1];
  expect(sent?.content).toEqual([
    { type: 'thinking', thinking: '서명 있음', signature: 'SIG-NATURE' },
    { type: 'text', text: '답', cache_control: { type: 'ephemeral', ttl: '1h' } },
  ]);
});

test('429·5xx는 Retry-After를 우선해서 재시도하고, 힌트가 없으면 500ms부터 두 배로 늘리며, 상한을 넘는 힌트는 바로 실패한다', async () => {
  const success = ok([messageStart({}), ...ending('end_turn', 0)]);
  const hinted = await startFakeApi([
    { status: 429, headers: { 'retry-after': '2' }, body: '{}' },
    success,
  ]);
  const hintedDelays: number[] = [];
  await collect(
    modelFor(hinted.baseUrl, hintedDelays).stream(request, new AbortController().signal),
  );
  expect(hintedDelays).toEqual([2000]);
  expect(hinted.seen).toHaveLength(2);

  const unhinted = await startFakeApi([
    { status: 503, body: '{}' },
    { status: 503, body: '{}' },
    success,
  ]);
  const unhintedDelays: number[] = [];
  await collect(
    modelFor(unhinted.baseUrl, unhintedDelays).stream(request, new AbortController().signal),
  );
  expect(unhintedDelays).toEqual([500, 1000]);

  const tooLong = await startFakeApi([
    { status: 429, headers: { 'retry-after': '120' }, body: '{}' },
    success,
  ]);
  const tooLongDelays: number[] = [];
  await expect(
    collect(modelFor(tooLong.baseUrl, tooLongDelays).stream(request, new AbortController().signal)),
  ).rejects.toThrow(/429/);
  expect(tooLong.seen).toHaveLength(1);
  expect(tooLongDelays).toEqual([]);
});

test('재시도하지 않는 오류는 한 번에 실패하고, 오류 메시지에는 응답이 되돌려 준 토큰이 남지 않는다', async () => {
  const api = await startFakeApi([
    { status: 400, body: JSON.stringify({ error: { message: `invalid token ${TOKEN}` } }) },
  ]);
  const delays: number[] = [];
  const failure = await collect(
    modelFor(api.baseUrl, delays).stream(request, new AbortController().signal),
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('400');
  expect((failure as Error).message).not.toContain(TOKEN);
  expect(api.seen).toHaveLength(1);
  expect(delays).toEqual([]);
});

test('신호를 취소하면 스트림을 읽던 중에도 바로 끝난다', async () => {
  const api = await startFakeApi(['hang']);
  const controller = new AbortController();
  const pending = collect(modelFor(api.baseUrl).stream(request, controller.signal));
  await expect.poll(() => api.seen.length).toBe(1);
  controller.abort();
  await expect(pending).rejects.toThrow();
});
