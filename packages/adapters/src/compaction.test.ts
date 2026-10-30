import type { ModelMessage, ModelRequest } from '@ora/core';
import { expect, test } from 'vitest';
import { compactAnthropicMessages, streamAnthropicMessages } from './anthropic.ts';
import type { CatalogModel } from './fetch/catalog.ts';
import { compactOpenAIResponses, streamOpenAICodexResponses } from './fetch/openai-responses.ts';
import type { WireCredential } from './fetch/wire.ts';

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

/** 요청을 기록하고 `replies`를 차례로 돌려주는 fetch다. 마지막 응답을 반복한다. */
function fakeFetch(replies: { status: number; body: string }[]) {
  const calls: Call[] = [];
  const impl = ((url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string) as Record<string, unknown>,
    });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)] ?? {
      status: 500,
      body: '',
    };
    return Promise.resolve(new Response(reply.body, { status: reply.status }));
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const noSleep = () => Promise.resolve();
const signal = new AbortController().signal;
const usage = { input_tokens: 10, output_tokens: 2 };

const claude: CatalogModel = {
  id: 'claude-opus-5-5',
  provider: 'claude',
  wire: 'anthropic-messages',
  baseUrl: 'https://api.anthropic.com',
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  cacheTtl: '1h',
};
const codex: CatalogModel = {
  id: 'gpt-5.5',
  provider: 'codex',
  wire: 'openai-codex-responses',
  baseUrl: 'https://chatgpt.com/backend-api',
  contextWindow: 272_000,
  maxOutputTokens: 128_000,
  cacheTtl: '1h',
};

const text = (value: string): ModelMessage => ({
  role: 'user',
  content: [{ type: 'text', text: value }],
});
const request = (messages: ModelMessage[]): ModelRequest & { instructions: string } => ({
  system: '시스템',
  messages,
  tools: [],
  instructions: '요약한다',
});

const apiKey: WireCredential = { kind: 'apiKey', token: 'sk-ant-api03-test' };
const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const openaiKey: WireCredential = { kind: 'apiKey', token: 'sk-openai-test' };
const codexLogin: WireCredential = {
  kind: 'oauth',
  token: jwt({ chatgpt_data_residency: 'eu' }),
  accountId: 'acct',
};

const compactionStream = (...items: object[]) =>
  [
    ...items.map((item, index) => ({
      type: 'response.output_item.done',
      output_index: index,
      item,
    })),
    { type: 'response.completed', response: { usage } },
  ]
    .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
    .join('');

const summaryDocument = '압축 요약 문서: 사용자 지시를 고친다';

test('Anthropic 압축은 베타 헤더와 compaction 본문을 보내고, 받은 블록을 다음 요청의 첫 블록으로 그대로 보낸다', async () => {
  const block = { type: 'compaction' as const, content: '서버 요약', signature: 'sig-1' };
  const api = fakeFetch([
    { status: 200, body: JSON.stringify({ stop_reason: 'compaction', content: [block] }) },
    { status: 400, body: '{}' },
    { status: 400, body: '{}' },
  ]);
  const result = await compactAnthropicMessages({
    model: claude,
    credential: apiKey,
    request: request([text('원문')]),
    signal,
    options: { fetch: api.impl, sleep: noSleep },
  });
  expect(api.calls[0]?.headers['anthropic-beta']).toContain('compact-2026-09-04');
  expect(api.calls[0]?.body).toMatchObject({
    compaction: { type: 'summarize', instructions: '요약한다' },
  });
  expect(api.calls[0]?.body).not.toHaveProperty('stream');
  expect(result).toMatchObject({ text: '서버 요약', replay: { kind: 'anthropic', block } });

  const replayed: ModelMessage = {
    ...text(summaryDocument),
    replay: { kind: 'anthropic', provider: 'claude', block, supplement: '지시 절' },
  };
  for (const model of [claude, { ...claude, provider: 'other' }]) {
    await drain(
      streamAnthropicMessages({
        model,
        credential: apiKey,
        request: request([replayed, text('이어서')]),
        signal,
        options: { fetch: api.impl, sleep: noSleep },
      }),
    ).catch(() => undefined);
  }
  const [same, foreign] = api.calls.slice(1);
  expect(same?.headers['anthropic-beta']).toContain('compact-2026-09-04');
  expect(same?.body.messages).toMatchObject([
    { role: 'assistant', content: [block] },
    { role: 'user', content: [{ type: 'text', text: '지시 절' }] },
    { role: 'user' },
  ]);
  expect(JSON.stringify(foreign?.body.messages)).toContain(summaryDocument);
  expect(JSON.stringify(foreign?.body.messages)).not.toContain('sig-1');
});

test('Codex V2 압축은 compaction_trigger를 붙여 보내고, 유지할 사용자 메시지와 불투명 항목을 같은 프로바이더에만 되돌려 보낸다', async () => {
  const item = { type: 'compaction', encrypted_content: 'opaque' };
  const api = fakeFetch([
    { status: 200, body: compactionStream(item) },
    { status: 400, body: '{}' },
    { status: 400, body: '{}' },
  ]);
  const result = await compactOpenAIResponses({
    model: codex,
    credential: codexLogin,
    request: request([
      text('첫 지시'),
      { role: 'assistant', content: [{ type: 'text', text: '응답' }] },
    ]),
    signal,
    options: { fetch: api.impl, sleep: noSleep },
  });
  expect(api.calls[0]?.url).toBe('https://chatgpt.com/backend-api/codex/responses');
  expect(api.calls[0]?.headers['x-openai-internal-codex-residency']).toBe('eu');
  expect((api.calls[0]?.body.input as object[]).at(-1)).toEqual({ type: 'compaction_trigger' });
  expect(result?.replay).toMatchObject({
    kind: 'openai',
    variant: 'v2',
    items: [{ role: 'user', content: [{ text: '첫 지시' }] }, item],
  });

  const replayed: ModelMessage = {
    ...text(summaryDocument),
    replay: { ...result?.replay, supplement: '지시 절' } as ModelMessage['replay'],
  };
  for (const model of [codex, { ...codex, provider: 'other' }]) {
    await drain(
      streamOpenAICodexResponses({
        model,
        credential: codexLogin,
        request: request([replayed, text('이어서')]),
        signal,
        options: { fetch: api.impl, sleep: noSleep },
      }),
    ).catch(() => undefined);
  }
  const [same, foreign] = api.calls.slice(1);
  expect(JSON.stringify(same?.body.input)).toContain('opaque');
  expect(JSON.stringify(same?.body.input)).not.toContain(summaryDocument);
  expect(JSON.stringify(foreign?.body.input)).toContain(summaryDocument);
  expect(JSON.stringify(foreign?.body.input)).not.toContain('opaque');
});

test('공개 API는 V2가 실패하면 /responses/compact(V1)를 보내고, 둘 다 실패하면 오류를 던진다', async () => {
  const item = { type: 'compaction', encrypted_content: 'opaque' };
  const replies = [
    { status: 500, body: '{}' },
    { status: 500, body: '{}' },
    { status: 500, body: '{}' },
    {
      status: 200,
      body: JSON.stringify({
        output: [{ role: 'user', content: [{ type: 'input_text', text: '원문' }] }, item],
        usage,
      }),
    },
  ];
  const api = fakeFetch(replies);
  const result = await compactOpenAIResponses({
    model: codex,
    credential: openaiKey,
    request: request([text('원문')]),
    signal,
    options: { fetch: api.impl, sleep: noSleep },
  });
  expect(api.calls.map((call) => call.url.split('/v1')[1])).toEqual([
    '/responses',
    '/responses',
    '/responses',
    '/responses/compact',
  ]);
  expect(result?.replay).toMatchObject({ kind: 'openai', variant: 'v1' });

  const failing = fakeFetch([{ status: 500, body: '{}' }]);
  await expect(
    compactOpenAIResponses({
      model: codex,
      credential: openaiKey,
      request: request([text('원문')]),
      signal,
      options: { fetch: failing.impl, sleep: noSleep },
    }),
  ).rejects.toThrow(/500/);

  // ChatGPT 구독 계정은 V2만 보낸다.
  const subscription = fakeFetch([{ status: 500, body: '{}' }]);
  await compactOpenAIResponses({
    model: codex,
    credential: codexLogin,
    request: request([text('원문')]),
    signal,
    options: { fetch: subscription.impl, sleep: noSleep },
  }).catch(() => undefined);
  expect(subscription.calls.every((call) => !call.url.endsWith('/compact'))).toBe(true);
});

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  const seen: unknown[] = [];
  for await (const event of events) seen.push(event);
}
