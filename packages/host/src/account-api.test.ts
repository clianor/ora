import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountListResponseSchema, loginStateSchema } from '@ora/protocol';
import { afterEach, expect, test } from 'vitest';
import { startLocalServer } from './server.ts';
import type { LocalServer } from './server.ts';

const ACCESS = `sk-ant-oat01-${'a'.repeat(40)}`;
const REFRESH = `sk-ant-ort01-${'c'.repeat(40)}`;
const NEW_ACCESS = `sk-ant-oat01-${'n'.repeat(40)}`;
const NEW_REFRESH = `sk-ant-ort01-${'m'.repeat(40)}`;
const FAR_FUTURE_MS = Date.parse('2999-01-01T00:00:00Z');

const servers: LocalServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

const fakeFetch: typeof fetch = (input) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.includes('/api/oauth/usage')) {
    return Promise.resolve(
      Response.json({
        five_hour: { utilization: 20, resets_at: '2999-01-01T05:00:00Z' },
        seven_day: { utilization: 40, resets_at: '2999-01-07T00:00:00Z' },
      }),
    );
  }
  if (url.includes('auth.openai.com/oauth/token')) {
    return Promise.resolve(
      Response.json({
        access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } }),
        refresh_token: NEW_REFRESH,
        expires_in: 3600,
        id_token: jwt({ 'https://api.openai.com/profile': { email: 'codex@example.com' } }),
      }),
    );
  }
  if (url.includes('/oauth/token')) {
    return Promise.resolve(
      Response.json({
        access_token: NEW_ACCESS,
        refresh_token: NEW_REFRESH,
        expires_in: 3600,
        account: { uuid: 'new-uuid', email_address: 'new@example.com' },
      }),
    );
  }
  return Promise.resolve(new Response('not found', { status: 404 }));
};

async function boot(authFile?: object, config?: object) {
  const home = mkdtempSync(join(tmpdir(), 'ora-accounts-'));
  if (authFile !== undefined) writeFileSync(join(home, 'auth.json'), JSON.stringify(authFile));
  const configPath = join(home, 'engine.config.json');
  if (config !== undefined) writeFileSync(configPath, JSON.stringify(config));
  const server = await startLocalServer({
    env: { ORA_HOME: home, PRESENT_KEY: 'value' },
    cwd: home,
    modelScriptPath: join(home, 'unused.json'),
    ...(config === undefined ? {} : { configPath }),
    fetch: fakeFetch,
    loginPort: 0,
    port: 0,
  });
  servers.push(server);
  const start = await fetch(server.startUrl, { redirect: 'manual' });
  const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(`${server.origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, text: await response.text() };
  };
  return { call, configPath };
}

const isPortOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });

test('계정 목록은 토큰을 담지 않고, API 키 이름을 검사하며, 우선순위 변경은 설정의 다른 키를 지킨다', async () => {
  const { call, configPath } = await boot(
    {
      schemaVersion: 1,
      providers: {
        claude: {
          accounts: [
            {
              kind: 'oauth',
              name: 'main',
              accessToken: ACCESS,
              refreshToken: REFRESH,
              expiresAt: FAR_FUTURE_MS,
              email: 'me@example.com',
            },
          ],
        },
      },
    },
    {
      permissions: { mode: 'bypass-permissions', tools: {} },
      limits: { maxSteps: 7 },
      accountPolicies: [{ provider: 'claude', account: 'main', priority: 1, reservePct: 25 }],
    },
  );

  const listed = await call('/api/accounts');
  expect(listed.status).toBe(200);
  expect(listed.text).not.toContain(ACCESS);
  expect(listed.text).not.toContain(REFRESH);
  const claude = accountListResponseSchema
    .parse(JSON.parse(listed.text))
    .providers.find((entry) => entry.provider === 'claude');
  expect(claude?.accounts[0]).toMatchObject({
    name: 'main',
    detail: 'me@example.com',
    priority: 1,
    status: 'idle',
    fiveHour: { remainingPct: 80 },
    sevenDay: { remainingPct: 60 },
  });

  expect(
    (await call('/api/accounts/claude/api-key', { envName: 'sk-ant-secret-value' })).status,
  ).toBe(400);
  expect((await call('/api/accounts/claude/api-key', { envName: 'missing_lower' })).status).toBe(
    400,
  );
  const added = await call('/api/accounts/claude/api-key', { envName: 'PRESENT_KEY' });
  expect(added.status).toBe(201);
  expect(JSON.parse(added.text)).toMatchObject({
    name: 'PRESENT_KEY',
    kind: 'apiKey',
    envPresent: true,
  });
  expect(added.text).not.toContain('value"');

  expect((await call('/api/accounts/claude/main/priority', { priority: 5 })).status).toBe(200);
  expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
    permissions: { mode: 'bypass-permissions', tools: {} },
    limits: { maxSteps: 7 },
    accountPolicies: [{ provider: 'claude', account: 'main', priority: 5, reservePct: 25 }],
  });
});

test('로그인을 시작하고 콜백을 받으면 계정이 생기고, 취소하면 콜백 포트가 닫힌다', async () => {
  const { call } = await boot();

  const finishLogin = async (provider: string) => {
    const started = await call(`/api/accounts/${provider}/login`, {});
    expect(started.status).toBe(201);
    const pending = loginStateSchema.parse(JSON.parse(started.text));
    if (pending.prompt?.kind !== 'url') throw new Error('로그인 주소가 없습니다.');
    const authorize = new URL(pending.prompt.url);
    const redirect = new URL(authorize.searchParams.get('redirect_uri') ?? '');
    redirect.searchParams.set('code', 'fake-code');
    redirect.searchParams.set('state', authorize.searchParams.get('state') ?? '');
    expect((await fetch(redirect)).status).toBe(200);
    let login = pending;
    for (let attempt = 0; attempt < 100 && login.status === 'pending'; attempt += 1) {
      await new Promise((done) => setTimeout(done, 20));
      login = loginStateSchema.parse(
        JSON.parse((await call(`/api/accounts/${provider}/login`)).text),
      );
    }
    return login;
  };
  const names = async (provider: string) => {
    const list = accountListResponseSchema.parse(JSON.parse((await call('/api/accounts')).text));
    return list.providers.find((entry) => entry.provider === provider)?.accounts.map((a) => a.name);
  };

  const started = await call('/api/accounts/claude/login', {});
  expect(started.status).toBe(201);
  const state = loginStateSchema.parse(JSON.parse(started.text));
  expect(state.status).toBe('pending');
  expect((await call('/api/accounts/claude/login', {})).status).toBe(409);
  expect((await call('/api/accounts/claude/login/cancel', {})).status).toBe(200);

  expect(await finishLogin('claude')).toMatchObject({
    status: 'succeeded',
    accountName: 'new@example.com',
  });
  const listed = await call('/api/accounts');
  expect(listed.text).toContain('new@example.com');
  expect(listed.text).not.toContain(NEW_ACCESS);
  expect(listed.text).not.toContain(NEW_REFRESH);

  expect(await finishLogin('codex')).toMatchObject({
    status: 'succeeded',
    accountName: 'codex@example.com',
  });
  expect(await finishLogin('codex')).toMatchObject({ status: 'succeeded' });
  expect(await names('codex')).toEqual(['codex@example.com']);

  const second = loginStateSchema.parse(
    JSON.parse((await call('/api/accounts/claude/login', {})).text),
  );
  if (second.prompt?.kind !== 'url') throw new Error('로그인 주소가 없습니다.');
  const port = Number(
    new URL(new URL(second.prompt.url).searchParams.get('redirect_uri') ?? '').port,
  );
  expect(await isPortOpen(port)).toBe(true);
  const cancelled = await call('/api/accounts/claude/login/cancel', {});
  expect(JSON.parse(cancelled.text)).toMatchObject({ status: 'cancelled' });
  expect(await isPortOpen(port)).toBe(false);
});
