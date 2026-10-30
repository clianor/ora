import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupListResponseSchema,
  cleanupResultSchema,
  prStatusResponseSchema,
} from '@ora/protocol';
import { afterEach, expect, test } from 'vitest';
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
}

async function boot(options: { hasGh: boolean }) {
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
      `#!/bin/sh
D="$(dirname "$0")"
echo "$1" >> "$D/calls.log"
if [ "$1" = api ]; then
  case "$*" in
    *If-None-Match*) printf 'HTTP/2.0 304 Not Modified\\r\\n\\r\\n'; exit 1;;
    *) printf 'HTTP/2.0 200 OK\\r\\nEtag: "v1"\\r\\n\\r\\n[]';;
  esac
  exit 0
fi
cat "$D/prs.json"
`,
    );
    chmodSync(join(bin, 'gh'), 0o755);
  }
  const server = await startLocalServer({
    env: { ORA_HOME: home, SHELL: '/bin/sh', PATH: `${bin}:${process.env.PATH ?? ''}` },
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
          statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
          mergedAt: pr.state === 'MERGED' ? '2026-10-30T00:00:00Z' : null,
          closedAt: pr.state === 'CLOSED' ? '2026-10-30T00:00:00Z' : null,
          createdAt: pr.createdAt,
          isCrossRepository: false,
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
    execFileSync('grep', ['-c', '^pr$', join(bin, 'calls.log')], { encoding: 'utf8' }).trim(),
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
});

test('gh가 없으면 PR 상태 없이 이유 한 줄을 알리고 삭제 창은 열리지 않는다', async () => {
  const { repo, call } = await boot({ hasGh: false });
  const status = prStatusResponseSchema.parse(
    await (await call(`/api/pr-status?repo=${encodeURIComponent(repo)}`)).json(),
  );
  expect(status.unavailable).toContain('PR 상태');
  expect(status.worktrees.every((item) => item.pr === undefined)).toBe(true);
  const cleanup = await call(`/api/worktrees/cleanup?repo=${encodeURIComponent(repo)}`);
  expect(cleanup.status).toBeGreaterThanOrEqual(400);
});

test('입력을 기다리는 셸은 삭제를 막지 않고, 명령이 도는 터미널은 막으며, 삭제하면 남은 터미널을 닫고 탭 기록을 지운다', async () => {
  const { repo, call, create, writePrs } = await boot({ hasGh: true });
  const path = await create('busy');
  writePrs([
    {
      number: 9,
      state: 'MERGED',
      branch: 'busy',
      oid: git(path, 'rev-parse', 'HEAD'),
      createdAt: '2026-10-20T00:00:00Z',
    },
  ]);
  const created = (await (
    await call('/api/terminals', { method: 'POST', body: { cwd: path, cols: 80, rows: 24 } })
  ).json()) as { terminal: { id: string } };
  const id = created.terminal.id;
  await call('/api/tabs', {
    method: 'PUT',
    body: { cwd: path, tabs: { tabs: [{ id: 'tab1', kind: 'terminal', terminalId: id }] } },
  });
  const blockedNow = async () => {
    const listed = cleanupListResponseSchema.parse(
      await (await call(`/api/worktrees/cleanup?repo=${encodeURIComponent(repo)}`)).json(),
    );
    return listed.candidates.find((item) => item.path === path)?.blocked;
  };

  expect(await blockedNow()).toBeUndefined();

  await call(`/api/terminals/${id}/input`, { method: 'POST', body: { data: 'sleep 30\n' } });
  await expect.poll(blockedNow, { timeout: 10_000 }).toBe('실행 중인 터미널 1개');

  await call(`/api/terminals/${id}/input`, { method: 'POST', body: { data: '\u0003' } });
  await expect.poll(blockedNow, { timeout: 10_000 }).toBeUndefined();

  const removed = cleanupResultSchema.parse(
    await (
      await call('/api/worktrees/cleanup', { method: 'POST', body: { repo, paths: [path] } })
    ).json(),
  );
  expect(removed.removed).toEqual([path]);
  await expect
    .poll(async () => {
      const terminals = (await (await call('/api/terminals')).json()) as {
        terminals: { id: string; status: string }[];
      };
      return terminals.terminals.find((item) => item.id === id)?.status;
    })
    .toBe('exited');
  const tabs = (await (await call(`/api/tabs?cwd=${encodeURIComponent(path)}`)).json()) as {
    tabs: { tabs: unknown[] };
  };
  expect(tabs.tabs.tabs).toEqual([]);
});
