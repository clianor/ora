import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tabsResponseSchema } from '@ora/protocol';
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
  return async (path: string, body?: unknown) => {
    const response = await fetch(`${server.origin}${path}`, {
      method: body === undefined ? 'GET' : 'PUT',
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: await response.json() };
  };
}

const cwd = '/work/ora';
const tabs = {
  tabs: [
    { id: 'a1', kind: 'session', sessionId: 's-20261029-abcdef' },
    { id: 'b2', kind: 'terminal', terminalId: 't-abcd1234' },
    { id: 'c3', kind: 'new' },
  ],
  activeTabId: 'b2',
};

test('저장한 탭과 순서는 서버를 다시 띄워도 같은 워크트리에서 그대로 읽힌다', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ora-tabs-'));
  const first = await boot(home);
  expect((await first('/api/tabs?cwd=/work/ora')).json).toEqual({ tabs: { tabs: [] } });
  expect((await first('/api/tabs', { cwd, tabs })).status).toBe(200);
  await servers.pop()?.close();

  const second = await boot(home);
  const reread = await second(`/api/tabs?cwd=${encodeURIComponent(cwd)}`);
  expect(tabsResponseSchema.parse(reread.json).tabs).toEqual(tabs);
  expect((await second('/api/tabs?cwd=/work/other')).json).toEqual({ tabs: { tabs: [] } });
});

test('활성 탭이 열린 탭에 없는 본문은 400으로 거부하고 저장된 값을 바꾸지 않는다', async () => {
  const call = await boot(mkdtempSync(join(tmpdir(), 'ora-tabs-')));
  await call('/api/tabs', { cwd, tabs });
  const bad = await call('/api/tabs', { cwd, tabs: { ...tabs, activeTabId: 'zz' } });
  expect(bad.status).toBe(400);
  expect(
    tabsResponseSchema.parse((await call(`/api/tabs?cwd=${encodeURIComponent(cwd)}`)).json).tabs,
  ).toEqual(tabs);
});

test('서버 시작 폴더의 브랜치 이름을 돌려주고 git 저장소가 아니면 비워 둔다', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ora-branch-'));
  const call = await boot(home);
  expect((await call(`/api/branch?cwd=${encodeURIComponent(home)}`)).json).toEqual({});
  execFileSync('git', ['init', '-q', '-b', 'trunk', home]);
  expect((await call(`/api/branch?cwd=${encodeURIComponent(home)}`)).json).toEqual({
    branch: 'trunk',
  });
});

test('심볼릭 링크로 가리킨 폴더의 탭은 실제 경로와 같은 워크트리에 저장된다', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ora-link-'));
  mkdirSync(join(home, 'real'));
  symlinkSync(join(home, 'real'), join(home, 'link'));
  const call = await boot(home);
  await call('/api/tabs', { cwd: join(home, 'link'), tabs });
  const reread = await call(
    `/api/tabs?cwd=${encodeURIComponent(realpathSync(join(home, 'real')))}`,
  );
  expect(tabsResponseSchema.parse(reread.json).tabs).toEqual(tabs);
});

test('세션 목록과 상세는 별칭 경로의 repo를 같은 실제 경로로 돌려준다', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ora-repo-alias-')));
  mkdirSync(join(home, 'real'));
  symlinkSync(join(home, 'real'), join(home, 'link'));
  const id = 's-20261030-aliasA';
  mkdirSync(join(home, 'sessions', id), { recursive: true });
  writeFileSync(
    join(home, 'sessions', id, 'session.json'),
    JSON.stringify({
      schemaVersion: 1,
      id,
      createdAt: '2026-10-30T14:31:06.711+09:00',
      updatedAt: '2026-10-30T14:31:06.806+09:00',
      title: 't',
      actor: 'user',
      status: 'stopped',
      endReason: 'max_steps',
      repo: join(home, 'link'),
      models: [],
      permissionMode: 'bypass-permissions',
      isolation: 'harness',
      promptHash: 'h',
      engineVersion: '0.0.0',
    }),
  );
  const call = await boot(home);
  const list = (await call('/api/sessions')).json as { sessions: { repo: string }[] };
  const detail = (await call(`/api/sessions/${id}`)).json as { session: { repo: string } };
  expect(list.sessions.map((session) => session.repo)).toEqual([join(home, 'real')]);
  expect(detail.session.repo).toBe(join(home, 'real'));
});

test('변경 목록은 HEAD 기준 증감과 추적하지 않는 파일을 돌려주고 git 저장소가 아니면 isRepo를 끈다', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ora-changes-')));
  const call = await boot(home);
  const url = `/api/changes?cwd=${encodeURIComponent(home)}`;
  expect((await call(url)).json).toEqual({ isRepo: false, files: [] });
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', home, '-c', 'user.email=a@b.c', '-c', 'user.name=t', ...args]);
  git('init', '-q', '-b', 'main');
  writeFileSync(join(home, 'a.txt'), 'one\ntwo\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  writeFileSync(join(home, 'a.txt'), 'one\nTWO\nthree\n');
  writeFileSync(join(home, 'b b.txt'), 'x\ny\n');
  expect((await call(url)).json).toEqual({
    isRepo: true,
    files: [
      { path: 'a.txt', add: 2, del: 1 },
      { path: 'b b.txt', add: 2, del: 0 },
    ],
  });
  expect((await call(`/api/branch?cwd=${encodeURIComponent(home)}`)).json).toEqual({
    branch: 'main',
    defaultBranch: 'main',
  });
});
