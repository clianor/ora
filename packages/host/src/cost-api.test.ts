import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  return async (method: 'GET' | 'PUT', body?: unknown) => {
    const response = await fetch(`${server.origin}/api/cost-settings`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: await response.json() };
  };
}

test('비용 상한과 단가를 저장하면 설정 파일의 다른 값은 두고, 형식이 틀린 값은 거부해 파일을 바꾸지 않는다', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ora-cost-'));
  const file = join(home, 'engine.config.json');
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, limits: { maxSteps: 7 } }));
  const call = await boot(home);
  expect((await call('GET')).json).toEqual({ maxCost: null, warnCost: null, pricing: {} });

  const settings = {
    maxCost: 5,
    warnCost: 4,
    pricing: { 'claude/claude-sonnet-5-5': { inputPerMTok: 3, outputPerMTok: 15 } },
  };
  expect(await call('PUT', settings)).toEqual({ status: 200, json: settings });
  const saved = readFileSync(file, 'utf8');
  expect(JSON.parse(saved)).toMatchObject({ limits: { maxSteps: 7 }, session: { maxCost: 5 } });

  expect((await call('PUT', { ...settings, warnCost: 6 })).status).toBe(409);
  expect(readFileSync(file, 'utf8')).toBe(saved);
});
