import { fileURLToPath } from 'node:url';
import type { Tool } from '@ora/core';
import { afterEach, expect, test } from 'vitest';
import { createMcpManager } from './mcp.ts';
import type { McpManager, McpServerConfig } from './mcp.ts';

const fixture = fileURLToPath(new URL('./mcp-server.fixture.ts', import.meta.url));
const context = { cwd: process.cwd(), signal: new AbortController().signal };

const server = (name: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name,
  transport: 'stdio',
  command: process.execPath,
  args: [fixture],
  envRefs: [],
  enabled: true,
  ...overrides,
});

const managers: McpManager[] = [];
const open = (env: NodeJS.ProcessEnv = {}): McpManager => {
  const manager = createMcpManager({
    env,
    connectTimeoutMs: 15000,
    callTimeoutMs: 15000,
    maxOutputBytes: 30000,
    now: () => '2026-10-30T10:00:00+09:00',
  });
  managers.push(manager);
  return manager;
};
const find = (manager: McpManager, name: string): Tool => {
  const tool = manager.tools().find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`도구가 없습니다: ${name}`);
  return tool;
};

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
});

test('서버의 도구를 서버명:도구명으로 노출하고 환경변수 값을 서버 프로세스에 넘긴다', async () => {
  const manager = open({ ORA_TEST_VALUE: 'from-env' });
  await manager.configure([server('fix', { envRefs: ['ORA_TEST_VALUE'] })]);

  expect(manager.tools().map((tool) => tool.name)).toEqual([
    'fix:echo',
    'fix:pid',
    'fix:secret',
    'fix:crash',
  ]);
  expect(find(manager, 'fix:echo').tier).toBe('exec');
  expect(await find(manager, 'fix:echo').run({ text: '안녕' }, context)).toEqual({
    status: 'ok',
    text: '안녕',
  });
  expect((await find(manager, 'fix:secret').run({}, context)).text).toBe('from-env');
  expect(manager.status()[0]).toMatchObject({
    state: 'connected',
    toolCount: 4,
    enabledToolCount: 4,
  });
  expect(manager.drain()).toEqual([{ server: 'fix', outcome: 'connected', toolCount: 4 }]);
});

test('서버 프로세스가 죽으면 그 서버의 도구만 꺼지고 장애를 알림으로 남긴다', async () => {
  const manager = open();
  await manager.configure([server('a'), server('b')]);
  manager.drain();
  const echoA = find(manager, 'a:echo');
  const pid = Number((await find(manager, 'a:pid').run({}, context)).text);

  process.kill(pid);
  await expect
    .poll(() => manager.status().find((entry) => entry.name === 'a')?.state, { timeout: 10000 })
    .toBe('unreachable');

  const down = await echoA.run({ text: 'x' }, context);
  expect(down.status).toBe('error');
  expect(down.text).toContain('꺼져 있습니다');
  expect(await find(manager, 'b:echo').run({ text: 'ok' }, context)).toMatchObject({
    status: 'ok',
    text: 'ok',
  });
  expect(manager.status().find((entry) => entry.name === 'a')).toMatchObject({
    enabledToolCount: 0,
    toolCount: 4,
    lastFailure: { at: '2026-10-30T10:00:00+09:00' },
  });
  expect(manager.drain()).toMatchObject([{ server: 'a', outcome: 'failed' }]);
  expect(manager.tools().map((tool) => tool.name)).not.toContain('a:echo');
});

test('환경변수가 없거나 명령이 없으면 그 서버만 연결하지 않고 이름만 원인에 적는다', async () => {
  const manager = open();
  await manager.configure([
    server('noenv', { envRefs: ['ORA_TEST_MISSING'] }),
    server('nocmd', { command: '/nonexistent/ora-mcp' }),
    server('good'),
  ]);

  const byName = Object.fromEntries(manager.status().map((entry) => [entry.name, entry]));
  expect(byName.noenv?.lastFailure?.reason).toContain('ORA_TEST_MISSING');
  expect(byName.nocmd?.state).toBe('unreachable');
  expect(byName.good?.state).toBe('connected');
});

test('꺼 둔 서버는 연결하지 않고, 다시 연결하면 도구가 돌아온다', async () => {
  const manager = open();
  await manager.configure([server('off', { enabled: false })]);
  expect(manager.status()[0]?.state).toBe('disabled');
  expect(manager.tools()).toEqual([]);

  await manager.configure([server('off')]);
  expect(manager.status()[0]?.state).toBe('connected');
  await manager.reconnect('off');
  expect(manager.tools()).toHaveLength(4);
});
