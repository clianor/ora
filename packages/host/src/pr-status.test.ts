import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupListResponseSchema,
  cleanupResultSchema,
  portsResponseSchema,
  prStatusResponseSchema,
  terminalListResponseSchema,
  terminalResponseSchema,
} from '@ora/protocol';
import { afterEach, expect, test, vi } from 'vitest';
import { startLocalServer } from './server.ts';
import type { LocalServer } from './server.ts';

const servers: LocalServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();

interface FakePr {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  branch: string;
  oid: string;
  createdAt: string;
  isDraft?: boolean;
  isFork?: boolean;
  checks?: 'SUCCESS' | 'FAILURE' | 'PENDING';
}

async function boot(options: { hasGh: boolean; env?: Record<string, string> }) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ora-pr-')));
  const repo = join(home, 'repo');
  const bin = join(home, 'bin');
  mkdirSync(bin);
  git(home, 'init', repo);
  writeFileSync(join(repo, 'a.txt'), 'a');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  writeFileSync(join(home, 'engine.config.json'), JSON.stringify({ repos: [{ path: repo }] }));
  writeFileSync(join(bin, 'prs.json'), '[]');
  if (options.hasGh) {
    writeFileSync(join(bin, 'calls.log'), '');
    writeFileSync(
      join(bin, 'gh'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.log'), args[0] + '\\n');
const fields = {};
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '-f') {
    const text = args[i + 1];
    const at = text.indexOf('=');
    fields[text.slice(0, at)] = text.slice(at + 1);
  }
}
fs.writeFileSync(path.join(dir, 'last-query.json'), JSON.stringify(fields));
const prs = JSON.parse(fs.readFileSync(path.join(dir, 'prs.json'), 'utf8'));
const repository = {};
for (let i = 0; fields['b' + i] !== undefined; i += 1) {
  const nodes = prs
    .filter((pr) => pr.headRefName === fields['b' + i])
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5);
  repository['a' + i] = { nodes };
}
process.stdout.write(JSON.stringify({ data: { repository } }));
`,
    );
    chmodSync(join(bin, 'gh'), 0o755);
  }
  const server = await startLocalServer({
    env: {
      ORA_HOME: home,
      SHELL: '/bin/sh',
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      ...options.env,
    },
    cwd: repo,
    modelScriptPath: join(home, 'unused.json'),
    port: 0,
  });
  servers.push(server);
  const start = await fetch(server.startUrl, { redirect: 'manual' });
  const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${server.origin}${path}`, {
      method: init.method ?? 'GET',
      headers: { cookie, 'content-type': 'application/json' },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const create = async (name: string) => {
    const response = await call('/api/worktrees', {
      method: 'POST',
      body: { repo, name, parent: 'main' },
    });
    expect(response.status).toBe(201);
    const { worktree } = (await response.json()) as { worktree: { path: string } };
    return worktree.path;
  };
  const writePrs = (prs: FakePr[]) => {
    writeFileSync(
      join(bin, 'prs.json'),
      JSON.stringify(
        prs.map((pr) => ({
          number: pr.number,
          url: `https://github.com/o/r/pull/${String(pr.number)}`,
          state: pr.state,
          isDraft: pr.isDraft ?? false,
          headRefName: `ora/${pr.branch}`,
          headRefOid: pr.oid,
          mergedAt: pr.state === 'MERGED' ? '2026-10-30T00:00:00Z' : null,
          closedAt: pr.state === 'CLOSED' ? '2026-10-30T00:00:00Z' : null,
          createdAt: pr.createdAt,
          isCrossRepository: pr.isFork ?? false,
          commits: {
            nodes: [{ commit: { statusCheckRollup: { state: pr.checks ?? 'SUCCESS' } } }],
          },
        })),
      ),
    );
  };
  return { repo, bin, call, create, writePrs };
}

const commit = (path: string, file: string) => {
  writeFileSync(join(path, file), file);
  git(path, 'add', '.');
  git(path, 'commit', '-m', file);
  return git(path, 'rev-parse', 'HEAD');
};

test('삭제 창은 마지막 PR 상태로 묶음을 나누고 막는 조건과 이유를 알려 주며, 서버도 막힌 항목의 삭제를 거부한다', async () => {
  const { repo, bin, call, create, writePrs } = await boot({ hasGh: true });
  const names = ['clean', 'dirty', 'after', 'lost', 'kept', 'reopened', 'open'];
  const paths = Object.fromEntries(
    await Promise.all(names.map(async (name) => [name, await create(name)] as const)),
  );
  const tip = (name: string) => git(paths[name] ?? '', 'rev-parse', 'HEAD');
  const cleanOid = commit(paths.clean ?? '', 'c.txt');
  git(paths.clean ?? '', 'update-ref', 'refs/remotes/origin/ora/clean', 'HEAD');
  writeFileSync(join(paths.dirty ?? '', 'x.txt'), 'x');
  const afterOid = tip('after');
  commit(paths.after ?? '', 'late.txt');
  commit(paths.lost ?? '', 'lost.txt');
  const keptOid = commit(paths.kept ?? '', 'kept.txt');
  git(paths.kept ?? '', 'update-ref', 'refs/remotes/origin/ora/kept', 'HEAD');
  const old = '2026-10-01T00:00:00Z';
  const recent = '2026-10-20T00:00:00Z';
  writePrs([
    { number: 1, state: 'MERGED', branch: 'clean', oid: cleanOid, createdAt: recent },
    { number: 2, state: 'MERGED', branch: 'dirty', oid: tip('dirty'), createdAt: recent },
    { number: 3, state: 'MERGED', branch: 'after', oid: afterOid, createdAt: recent },
    { number: 4, state: 'CLOSED', branch: 'lost', oid: tip('lost'), createdAt: recent },
    { number: 5, state: 'CLOSED', branch: 'kept', oid: keptOid, createdAt: recent },
    { number: 6, state: 'MERGED', branch: 'reopened', oid: tip('reopened'), createdAt: old },
    { number: 7, state: 'OPEN', branch: 'reopened', oid: tip('reopened'), createdAt: recent },
    { number: 8, state: 'OPEN', branch: 'open', oid: tip('open'), createdAt: recent },
  ]);

  const listed = cleanupListResponseSchema.parse(
    await (await call(`/api/worktrees/cleanup?repo=${encodeURIComponent(repo)}`)).json(),
  );
  const byName = new Map(listed.candidates.map((item) => [item.branch.replace('ora/', ''), item]));
  expect([...byName.keys()].toSorted()).toEqual(['after', 'clean', 'dirty', 'kept', 'lost']);
  expect(byName.get('clean')).toMatchObject({ group: 'merged', number: 1 });
  expect(byName.get('clean')?.blocked).toBeUndefined();
  expect(byName.get('dirty')?.blocked).toBe('커밋하지 않은 변경 1개');
  expect(byName.get('after')?.blocked).toBe('머지 뒤 새 커밋 1개');
  expect(byName.get('lost')).toMatchObject({
    group: 'closed',
    blocked: '원격에 없는 커밋 1개 · 지우면 사라집니다',
  });
  expect(byName.get('kept')).toMatchObject({ group: 'closed', isOnRemote: true });
  expect(byName.get('kept')?.blocked).toBeUndefined();

  const status = prStatusResponseSchema.parse(
    await (await call(`/api/pr-status?repo=${encodeURIComponent(repo)}&refresh=read`)).json(),
  );
  expect(status.worktrees.find((item) => item.path === paths.reopened)?.pr).toMatchObject({
    number: 7,
    state: 'OPEN',
    checks: 'pass',
  });
  expect(status.worktrees.find((item) => item.isMain)?.sync).toEqual({ behind: 0, ahead: 0 });
  expect(
    execFileSync('grep', ['-c', '^api$', join(bin, 'calls.log')], { encoding: 'utf8' }).trim(),
  ).toBe('1');

  const remove = async (...targets: string[]) =>
    cleanupResultSchema.parse(
      await (
        await call('/api/worktrees/cleanup', {
          method: 'POST',
          body: { repo, paths: targets },
        })
      ).json(),
    );
  const refused = await remove(paths.dirty ?? '', paths.lost ?? '', paths.open ?? '', repo);
  expect(refused.removed).toEqual([]);
  expect(refused.failed.map((item) => item.reason)).toEqual([
    '커밋하지 않은 변경 1개',
    '원격에 없는 커밋 1개 · 지우면 사라집니다',
    '삭제 대상이 아닙니다.',
    '삭제 대상이 아닙니다.',
  ]);
  expect(existsSync(paths.dirty ?? '')).toBe(true);

  const done = await remove(paths.clean ?? '', paths.kept ?? '');
  expect(done.removed).toHaveLength(2);
  expect(existsSync(paths.clean ?? '')).toBe(false);
  expect(git(repo, 'branch', '--list', 'ora/clean')).toBe('');
  expect(git(repo, 'branch', '--list', 'ora/lost')).toContain('ora/lost');
  const rest = (await (await call('/api/worktrees')).json()) as { worktrees: { name: string }[] };
  expect(rest.worktrees.map((item) => item.name)).not.toContain('clean');
}, 30_000);

test('gh가 없으면 PR 상태 없이 이유 한 줄을 알리고 삭제 창은 열리지 않는다', async () => {
  const { repo, call, create } = await boot({ hasGh: false });
  await create('needs-pr');
  const status = prStatusResponseSchema.parse(
    await (await call(`/api/pr-status?repo=${encodeURIComponent(repo)}`)).json(),
  );
  expect(status.unavailable).toContain('PR 상태');
  expect(status.worktrees.every((item) => item.pr === undefined)).toBe(true);
  const cleanup = await call(`/api/worktrees/cleanup?repo=${encodeURIComponent(repo)}`);
  expect(cleanup.status).toBeGreaterThanOrEqual(400);
});

test('목록 크기와 상관없이 오래된 PR을 찾고, 포크 PR은 제외하며, 검사 결과만 바뀌어도 다음 60초 조회에 반영한다', async () => {
  const { repo, bin, call, create, writePrs } = await boot({ hasGh: true });
  const path = await create('stale');
  const oid = git(path, 'rev-parse', 'HEAD');
  const filler: FakePr[] = Array.from({ length: 600 }, (_, index) => ({
    number: 1000 + index,
    state: 'MERGED',
    branch: `other-${String(index)}`,
    oid,
    createdAt: '2026-10-25T00:00:00Z',
  }));
  const mine = (checks: FakePr['checks']): FakePr[] => [
    { number: 3, state: 'OPEN', branch: 'stale', oid, createdAt: '2024-01-01T00:00:00Z', checks },
    {
      number: 4,
      state: 'OPEN',
      branch: 'stale',
      oid,
      createdAt: '2026-10-29T00:00:00Z',
      isFork: true,
    },
    ...filler,
  ];
  const read = async (refresh: string) =>
    prStatusResponseSchema
      .parse(
        await (
          await call(`/api/pr-status?repo=${encodeURIComponent(repo)}&refresh=${refresh}`)
        ).json(),
      )
      .worktrees.find((item) => item.path === path)?.pr;

  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-31T00:00:00Z') });
  try {
    writePrs(mine('PENDING'));
    expect(await read('force')).toMatchObject({ number: 3, checks: 'running' });
    expect(JSON.parse(readFileSync(join(bin, 'last-query.json'), 'utf8'))).toMatchObject({
      owner: 'o',
      name: 'r',
      b0: expect.any(String) as string,
    });
    writePrs(mine('FAILURE'));
    expect(await read('read')).toMatchObject({ number: 3, checks: 'running' });
    vi.setSystemTime(new Date('2026-10-31T00:01:00Z'));
    expect(await read('read')).toMatchObject({ number: 3, checks: 'fail' });
  } finally {
    vi.useRealTimers();
  }
});

const merged = (number: number, branch: string, path: string): FakePr => ({
  number,
  state: 'MERGED',
  branch,
  oid: git(path, 'rev-parse', 'HEAD'),
  createdAt: '2026-10-20T00:00:00Z',
});

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('삭제는 Ora 터미널의 포그라운드·백그라운드·셸을 떠난 프로세스를 모두 종료한 뒤 워크트리를 지우고 남은 터미널과 탭 기록을 닫는다', async () => {
  const { repo, call, create, writePrs } = await boot({ hasGh: true });
  const path = await create('busy');
  writePrs([merged(9, 'busy', path)]);
  const open = async () =>
    terminalResponseSchema.parse(
      await (
        await call('/api/terminals', { method: 'POST', body: { cwd: path, cols: 80, rows: 24 } })
      ).json(),
    ).terminal.id;
  const first = await open();
  const second = await open();
  await call('/api/tabs', {
    method: 'PUT',
    body: { cwd: path, tabs: { tabs: [{ id: 'tab1', kind: 'terminal', terminalId: first }] } },
  });
  const input = (id: string, data: string) =>
    call(`/api/terminals/${id}/input`, { method: 'POST', body: { data } });
  const candidate = async () =>
    cleanupListResponseSchema
      .parse(await (await call(`/api/worktrees/cleanup?repo=${encodeURIComponent(repo)}`)).json())
      .candidates.find((item) => item.path === path);

  expect(await candidate()).toMatchObject({ processes: [] });
  expect((await candidate())?.blocked).toBeUndefined();

  await input(second, 'nohup sleep 5302 >/dev/null 2>&1 &\n');
  await expect.poll(async () => (await candidate())?.processes.length, { timeout: 10_000 }).toBe(1);
  // 셸이 끝나면 sleep의 부모가 launchd(1)로 바뀐다.
  await input(second, 'exit\n');
  await input(first, 'sleep 5303 &\n');
  await input(first, 'sleep 5301\n');
  await expect.poll(async () => (await candidate())?.processes.length, { timeout: 10_000 }).toBe(3);

  const found = (await candidate())?.processes ?? [];
  expect(found.map((item) => item.name)).toEqual(['sleep', 'sleep', 'sleep']);
  expect((await candidate())?.blocked).toBeUndefined();

  const removed = cleanupResultSchema.parse(
    await (
      await call('/api/worktrees/cleanup', { method: 'POST', body: { repo, paths: [path] } })
    ).json(),
  );
  expect(removed.removed).toEqual([path]);
  await expect.poll(() => found.some((item) => isAlive(item.pid)), { timeout: 10_000 }).toBe(false);
  expect(existsSync(path)).toBe(false);
  const terminals = terminalListResponseSchema.parse(
    await (await call('/api/terminals')).json(),
  ).terminals;
  expect(terminals.find((item) => item.id === first)?.status).toBe('exited');
  const tabs = (await (await call(`/api/tabs?cwd=${encodeURIComponent(path)}`)).json()) as {
    tabs: { tabs: unknown[] };
  };
  expect(tabs.tabs.tabs).toEqual([]);
}, 30_000);

const groups: number[] = [];
afterEach(() => {
  for (const group of groups.splice(0)) {
    try {
      process.kill(-group, 'SIGKILL');
    } catch {
      // 이미 끝난 프로세스 그룹이다.
    }
  }
});

/** Ora 밖에서 시작한 것처럼, 작업 폴더만 `cwd`인 node 서버를 띄우고 연 포트를 돌려준다. */
async function startOutsideServer(cwd: string): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'ora-srv-'));
  const script = join(dir, 'srv.js');
  writeFileSync(
    script,
    "const s = require('net').createServer().listen(0, '127.0.0.1', () => { console.log('PORT ' + s.address().port); });",
  );
  const child = spawn('sh', ['-c', `"${process.execPath}" "${script}"; true`], {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (child.pid !== undefined) groups.push(child.pid);
  const { promise, resolve } = Promise.withResolvers<number>();
  child.stdout.on('data', (chunk: Buffer) => {
    const port = /PORT (\d+)/.exec(chunk.toString())?.[1];
    if (port !== undefined) resolve(Number(port));
  });
  return promise;
}

test('Ora 밖에서 시작했고 작업 폴더가 워크트리 안인 프로세스는 삭제를 막고 이름과 포트를 알린다', async () => {
  const { repo, call, create, writePrs } = await boot({ hasGh: true });
  const path = await create('outside');
  writePrs([merged(10, 'outside', path)]);
  const port = await startOutsideServer(path);
  const blocked = async () =>
    cleanupListResponseSchema
      .parse(await (await call(`/api/worktrees/cleanup?repo=${encodeURIComponent(repo)}`)).json())
      .candidates.find((item) => item.path === path)?.blocked;

  expect(await blocked()).toBe(`Ora 밖에서 시작한 프로세스 1개 · srv (포트 ${String(port)})`);
  const refused = cleanupResultSchema.parse(
    await (
      await call('/api/worktrees/cleanup', { method: 'POST', body: { repo, paths: [path] } })
    ).json(),
  );
  expect(refused.removed).toEqual([]);
  expect(existsSync(path)).toBe(true);

  for (const group of groups.splice(0)) process.kill(-group, 'SIGKILL');
  await expect.poll(blocked, { timeout: 10_000 }).toBeUndefined();
}, 30_000);

test('라이브 포트는 워크트리별로 Ora 터미널과 Ora 밖 프로세스를 나누어 보이고, 종료는 그 프로세스 하나만 끈다', async () => {
  const { repo, call, create } = await boot({ hasGh: true });
  const one = await create('one');
  const two = await create('two');
  const outsidePort = await startOutsideServer(one);
  await startOutsideServer(two);
  const terminalId = terminalResponseSchema.parse(
    await (
      await call('/api/terminals', { method: 'POST', body: { cwd: one, cols: 80, rows: 24 } })
    ).json(),
  ).terminal.id;
  const script = join(mkdtempSync(join(tmpdir(), 'ora-term-')), 'inner.js');
  writeFileSync(script, "require('net').createServer().listen(0, '127.0.0.1');");
  await call(`/api/terminals/${terminalId}/input`, {
    method: 'POST',
    body: { data: `"${process.execPath}" "${script}"\n` },
  });
  const read = async () => {
    const response = portsResponseSchema.parse(
      await (await call(`/api/ports?repo=${encodeURIComponent(repo)}`)).json(),
    );
    return new Map(response.worktrees.map((item) => [item.path, item.ports]));
  };
  await expect.poll(async () => (await read()).get(one)?.length, { timeout: 10_000 }).toBe(2);
  const before = await read();
  const outside = before.get(one)?.find((item) => item.port === outsidePort);
  const inner = before.get(one)?.find((item) => item.port !== outsidePort);
  const other = before.get(two)?.[0];
  expect(outside).toMatchObject({ isExternal: true, name: 'srv', address: '127.0.0.1' });
  expect(inner).toMatchObject({ isExternal: false, name: 'inner' });
  expect(before.get(two)).toHaveLength(1);
  if (outside === undefined || inner === undefined || other === undefined) throw new Error('포트');

  const kill = (path: string, item: { pid: number; port: number }) =>
    call('/api/ports/kill', {
      method: 'POST',
      body: { repo, path, pid: item.pid, port: item.port },
    });
  expect((await kill(two, inner)).status).toBe(409);
  expect(isAlive(inner.pid)).toBe(true);

  expect((await kill(one, outside)).status).toBe(200);
  await expect.poll(async () => (await read()).get(one)?.length, { timeout: 10_000 }).toBe(1);
  expect((await read()).get(one)?.[0]?.pid).toBe(inner.pid);
  expect((await read()).get(two)?.[0]?.pid).toBe(other.pid);
  expect(isAlive(other.pid)).toBe(true);
}, 30_000);

test('셸 시작 파일이 셸과 같은 프로세스 그룹으로 띄운 프로세스는 종료 목록에 없고 삭제 때 함께 종료된다', async () => {
  const zdotdir = mkdtempSync(join(tmpdir(), 'ora-zdot-'));
  writeFileSync(
    join(zdotdir, '.zshrc'),
    "setopt no_monitor\n(trap '' HUP; exec sleep 5306) &\nsetopt monitor\n",
  );
  const { repo, call, create, writePrs } = await boot({
    hasGh: true,
    env: { SHELL: '/bin/zsh', ZDOTDIR: zdotdir },
  });
  const path = await create('inner');
  writePrs([merged(11, 'inner', path)]);
  const id = terminalResponseSchema.parse(
    await (
      await call('/api/terminals', { method: 'POST', body: { cwd: path, cols: 80, rows: 24 } })
    ).json(),
  ).terminal.id;
  const helper = () => {
    try {
      return Number(
        execFileSync('pgrep', ['-f', 'sleep 5306'], { encoding: 'utf8' }).split('\n')[0] ?? 0,
      );
    } catch {
      return 0;
    }
  };
  await expect.poll(helper, { timeout: 10_000 }).toBeGreaterThan(0);
  const helperPid = helper();
  await call(`/api/terminals/${id}/input`, { method: 'POST', body: { data: 'sleep 5307 &\n' } });
  const processes = async () =>
    cleanupListResponseSchema
      .parse(await (await call(`/api/worktrees/cleanup?repo=${encodeURIComponent(repo)}`)).json())
      .candidates.find((item) => item.path === path)?.processes ?? [];
  await expect.poll(async () => (await processes()).length, { timeout: 10_000 }).toBe(1);
  expect((await processes()).map((item) => item.pid)).not.toContain(helperPid);

  const removed = cleanupResultSchema.parse(
    await (
      await call('/api/worktrees/cleanup', { method: 'POST', body: { repo, paths: [path] } })
    ).json(),
  );
  expect(removed.removed).toEqual([path]);
  await expect.poll(() => isAlive(helperPid), { timeout: 10_000 }).toBe(false);
}, 30_000);
