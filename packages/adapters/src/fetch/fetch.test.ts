import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelStreamEvent } from '@ora/core';
import { afterEach, expect, test } from 'vitest';
import { createAccountStore } from './accounts.ts';
import type { CatalogModel } from './catalog.ts';
import { xxHash64 } from './claude-identity.ts';
import { loginClaude } from './claude-oauth.ts';
import { createFetchModel } from './model.ts';

const NOW = Date.parse('2026-10-29T03:00:00Z');
const ACCESS_1 = `sk-ant-oat01-${'a'.repeat(40)}`;
const ACCESS_2 = `sk-ant-oat01-${'b'.repeat(40)}`;
const REFRESH = `sk-ant-ort01-${'c'.repeat(40)}`;
const ROTATED = `sk-ant-ort01-${'d'.repeat(40)}`;

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

const tokenResponse = (access: string, refresh: string) =>
  new Response(
    JSON.stringify({
      access_token: access,
      refresh_token: refresh,
      expires_in: 3600,
      account: { uuid: 'acct-uuid', email_address: 'me@example.com' },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

// 실제 Anthropic 서버로 로그인할 수 없어서 e2e가 만들 수 없는 입력(가짜 OAuth 서버)이다.
test('XXHash64는 공개 시험 값과 같고, PKCE 로그인은 콜백 코드를 verifier와 함께 교환해 토큰을 돌려준다', async () => {
  expect(xxHash64(new Uint8Array()).toString(16)).toBe('ef46db3751d8e999');
  expect(xxHash64(new TextEncoder().encode('abc')).toString(16)).toBe('44bc2cf5ad770999');
  // 32바이트 이상 입력이 지나는 4개 레인 경로의 공개 시험 값이다.
  expect(
    xxHash64(new TextEncoder().encode('Nobody inspects the spammish repetition')).toString(16),
  ).toBe('fbcea83c8a378bf1');

  const lines: string[] = [];
  const exchanged: { url: string; body: Record<string, string> }[] = [];
  const login = loginClaude({
    print: (line) => lines.push(line),
    readManualCode: () => new Promise<string>(() => undefined),
    port: 0,
    now: () => NOW,
    fetch: (url, init) => {
      exchanged.push({
        url: url as string,
        body: JSON.parse(init?.body as string) as Record<string, string>,
      });
      return Promise.resolve(tokenResponse(ACCESS_1, REFRESH));
    },
  });
  await expect.poll(() => lines.length).toBeGreaterThanOrEqual(4);
  const authorize = new URL(lines[1] ?? '');
  const redirect = authorize.searchParams.get('redirect_uri') ?? '';
  const state = authorize.searchParams.get('state') ?? '';
  expect(authorize.origin + authorize.pathname).toBe('https://claude.com/cai/oauth/authorize');
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
  await fetch(`${redirect.replace('localhost', '127.0.0.1')}?code=CODE&state=${state}`);

  const tokens = await login;
  expect(tokens).toEqual({
    accessToken: ACCESS_1,
    refreshToken: REFRESH,
    expiresAt: NOW + 3_600_000,
    accountUuid: 'acct-uuid',
    email: 'me@example.com',
  });
  expect(exchanged).toHaveLength(1);
  expect(exchanged[0]?.url).toBe('https://platform.claude.com/v1/oauth/token');
  expect(exchanged[0]?.body).toMatchObject({
    grant_type: 'authorization_code',
    code: 'CODE',
    redirect_uri: redirect,
    state,
  });
  const verifier = exchanged[0]?.body.code_verifier ?? '';
  expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
    authorize.searchParams.get('code_challenge'),
  );
});

test('만료가 가까운 토큰은 동시 호출에도 한 번만 갱신하고, 회전한 refresh token을 0600 파일에 저장한다', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ora-auth-')), 'auth.json');
  let refreshCalls = 0;
  const store = createAccountStore({
    path,
    env: { MY_KEY: 'secret-value-that-must-not-be-saved' },
    now: () => NOW,
    fetch: (_url, init) => {
      refreshCalls += 1;
      expect(JSON.parse(init?.body as string)).toMatchObject({
        grant_type: 'refresh_token',
        refresh_token: REFRESH,
      });
      return Promise.resolve(tokenResponse(ACCESS_2, ROTATED));
    },
  });
  await store.save('claude', {
    kind: 'oauth',
    name: 'main',
    accessToken: ACCESS_1,
    refreshToken: REFRESH,
    expiresAt: NOW + 60_000,
  });
  await store.save('claude', { kind: 'apiKey', name: 'key', credentialEnv: 'MY_KEY' });

  const [first, second] = await Promise.all([
    store.resolveCredential('claude', 'main'),
    store.resolveCredential('claude', 'main'),
  ]);

  expect(refreshCalls).toBe(1);
  expect(first).toEqual({ kind: 'oauth', token: ACCESS_2, accountId: 'acct-uuid' });
  expect(second).toEqual(first);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const saved = readFileSync(path, 'utf8');
  expect(saved).toContain(ROTATED);
  expect(saved).not.toContain(REFRESH);
  expect(saved).not.toContain('secret-value-that-must-not-be-saved');
  expect((await store.list('claude')).map((account) => account.name)).toEqual(['main', 'key']);
});

interface Seen {
  readonly headers: IncomingHttpHeaders;
  readonly body: {
    system: { text: string }[];
    tools: { name: string }[];
    messages: { content: { name?: string }[] }[];
    metadata: { user_id: string };
    max_tokens: number;
  };
}

const sse = (events: Record<string, unknown>[]) =>
  events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');

// 가짜 `/v1/messages` 서버다. 첫 요청은 사용량 한도로 거절하고 둘째 요청부터 응답한다.
test('OAuth 요청은 Claude Code 식별 정보와 도구 이름 접두사를 붙이고, 사용량 한도 응답이 오면 다음 계정으로 바꾼다', async () => {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Seen['body'],
      });
      if (seen.length === 1) {
        res.writeHead(429, {
          'content-type': 'application/json',
          'anthropic-ratelimit-unified-status': 'rejected',
        });
        res.end(JSON.stringify({ error: { message: 'You have reached your usage limit.' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        sse([
          {
            type: 'message_start',
            message: {
              usage: {
                input_tokens: 10,
                cache_read_input_tokens: 4,
                cache_creation_input_tokens: 2,
              },
            },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_1', name: '_todo__update' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"a":1}' },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 7 },
          },
          { type: 'message_stop' },
        ]),
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
  const store = createAccountStore({
    path: join(mkdtempSync(join(tmpdir(), 'ora-auth-')), 'auth.json'),
    env: {},
    now: () => NOW,
  });
  for (const [name, access] of [
    ['first', ACCESS_1],
    ['second', ACCESS_2],
  ] as const) {
    await store.save('claude', {
      kind: 'oauth',
      name,
      accessToken: access,
      refreshToken: REFRESH,
      expiresAt: NOW + 3_600_000,
      accountUuid: 'acct-uuid',
    });
  }

  const model = createFetchModel({
    catalog,
    store,
    now: () => NOW,
    // 실제 사용량 조회 서버로 나가지 않도록 막는다. 조회 실패는 계정 선택을 막지 않는다.
    fetch: () => Promise.reject(new Error('offline')),
    wireOptions: { effort: 'low' },
  });
  const events: ModelStreamEvent[] = [];
  for await (const event of model.stream(
    {
      system: 'Ora 시스템 프롬프트',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '작업을 시작합니다' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', callId: 'toolu_0', tool: 'todo.update', input: {} }],
        },
      ],
      tools: [{ name: 'todo.update', description: 'todo', inputSchema: { type: 'object' } }],
      maxOutputTokens: 300,
    },
    new AbortController().signal,
  ))
    events.push(event);

  expect(seen).toHaveLength(2);
  expect(seen[0]?.headers.authorization).toBe(`Bearer ${ACCESS_1}`);
  const [, second] = seen;
  expect(second?.headers.authorization).toBe(`Bearer ${ACCESS_2}`);
  expect(second?.headers['x-api-key']).toBeUndefined();
  expect(second?.headers['user-agent']).toMatch(/^claude-cli\/\S+ \(external, cli\)$/);
  expect(second?.headers['x-app']).toBe('cli');
  expect(second?.headers['anthropic-version']).toBe('2023-06-01');
  expect(second?.headers['anthropic-beta']).toContain('oauth-2025-04-20');
  expect(second?.headers['anthropic-beta']).toContain('claude-code-20250219');
  expect(second?.body.system.map((block) => block.text)).toEqual([
    expect.stringMatching(
      /^x-anthropic-billing-header: cc_version=\S+; cc_entrypoint=cli; cch=[0-9a-f]{5};$/,
    ),
    "You are Claude Code, Anthropic's official CLI for Claude.",
    'Ora 시스템 프롬프트',
  ]);
  expect(second?.body.tools.map((tool) => tool.name)).toEqual(['_todo__update']);
  // 요청의 출력 상한 300이 카탈로그 최대 출력 1000보다 작아 그대로 실린다.
  expect(second?.body.max_tokens).toBe(300);
  expect(model).toMatchObject({ maxOutputTokens: 1000, acceptsOutputCap: true });
  expect(second?.body.messages[1]?.content[0]?.name).toBe('_todo__update');
  expect(JSON.parse(second?.body.metadata.user_id ?? '{}')).toMatchObject({
    account_uuid: 'acct-uuid',
  });
  expect(events).toEqual([
    {
      type: 'completed',
      content: [{ type: 'tool_use', callId: 'toolu_1', tool: 'todo.update', input: { a: 1 } }],
      stopReason: 'tool_use',
      usage: {
        uncachedInputTokens: 10,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 2,
        outputTokens: 7,
      },
      nativeToolCalls: true,
    },
  ]);
});
