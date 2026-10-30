import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { permissionsFileSchema } from '@ora/protocol';
import { afterEach, expect, test } from 'vitest';
import { startLocalServer } from './server.ts';
import type { LocalServer } from './server.ts';

const servers: LocalServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function boot(home: string) {
  const server = await startLocalServer({
    env: { ORA_HOME: home },
    cwd: home,
    modelScriptPath: join(home, 'unused.json'),
    port: 0,
  });
  servers.push(server);
  const start = await fetch(server.startUrl, { redirect: 'manual' });
  const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  return async (method: 'GET' | 'PUT' | 'DELETE', path: string, body?: unknown) => {
    const response = await fetch(`${server.origin}/api/${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };
}

test('설정 › 일반은 범위 밖 값을 거부해 파일을 바꾸지 않고, 범위 안 값은 다른 키를 두고 저장한다', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ora-settings-'));
  const file = join(home, 'engine.config.json');
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, limits: { toolTimeout: 1 } }));
  const call = await boot(home);
  const general = (await call('GET', 'settings/general')).json;
  const before = readFileSync(file, 'utf8');

  expect((await call('PUT', 'settings/general', { ...general, maxSteps: 0 })).status).toBe(400);
  expect((await call('PUT', 'settings/general', { ...general, compactAtRatio: 0.99 })).status).toBe(
    400,
  );
  expect(readFileSync(file, 'utf8')).toBe(before);

  const saved = await call('PUT', 'settings/general', { ...general, maxSteps: 80 });
  expect(saved.json).toMatchObject({ maxSteps: 80 });
  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
    limits: { toolTimeout: 1, maxSteps: 80 },
  });
});

test('항상 승인한 명령을 지우고, 깨진 permissions.json은 지우지 않고 이유를 돌려준다', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ora-rules-'));
  const file = join(home, 'permissions.json');
  const rules = [
    { tool: 'shell', command: 'pnpm test', cwd: '/work' },
    { tool: 'shell', command: 'pnpm build', cwd: '/work' },
  ];
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, rules }));
  const call = await boot(home);

  const listed = await call('GET', 'permission-rules');
  const [first] = listed.json.rules as { key: string; rule: unknown }[];
  expect(listed.json.rules).toHaveLength(2);

  const removed = await call('DELETE', `permission-rules/${encodeURIComponent(first?.key ?? '')}`);
  expect(removed.status).toBe(200);
  expect(permissionsFileSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).rules).toEqual([
    rules[1],
  ]);

  writeFileSync(file, '{ 깨진 파일');
  const blocked = await call('DELETE', `permission-rules/${encodeURIComponent(first?.key ?? '')}`);
  expect(blocked.status).toBe(409);
  expect(blocked.json.error).toEqual(expect.any(String));
  expect(readFileSync(file, 'utf8')).toBe('{ 깨진 파일');
});
