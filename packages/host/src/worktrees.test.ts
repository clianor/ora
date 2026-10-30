import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { worktreeResponseSchema, worktreesFileSchema } from '@ora/protocol';
import type { WorktreeRecord } from '@ora/protocol';
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

function createHome(setupCommands: string[]) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ora-wt-')));
  const repo = join(home, 'repo');
  git(home, 'init', repo);
  writeFileSync(join(repo, 'a.txt'), 'a');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');
  writeFileSync(
    join(home, 'engine.config.json'),
    JSON.stringify({ repos: [{ path: repo, setupCommands }] }),
  );
  return { home, repo };
}

async function boot(home: string, cwd: string) {
  const server = await startLocalServer({
    env: { ORA_HOME: home, SHELL: '/bin/sh', PATH: process.env.PATH ?? '' },
    cwd,
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
  const read = async (id: string): Promise<WorktreeRecord | undefined> => {
    const file = (await (await call('/api/worktrees')).json()) as { worktrees: WorktreeRecord[] };
    return file.worktrees.find((item) => item.id === id);
  };
  return { server, call, read };
}

// (가) 사용자가 만들기 창에서 겪는 거부 사유와 성공 결과(브랜치, 폴더, baseRef)를 실제 git 저장소로 확인한다.
test('이름 규칙과 중복을 거부하고, 만든 worktree는 부모 HEAD를 baseRef로 남긴다', async () => {
  const { home, repo } = createHome([]);
  const { call } = await boot(home, repo);
  const create = (name: string) =>
    call('/api/worktrees', { method: 'POST', body: { repo, name, parent: 'main' } });

  expect((await create('Bad Name')).status).toBe(400);
  const created = worktreeResponseSchema.parse(await (await create('fix/negative-add')).json());
  expect(created.worktree).toMatchObject({
    branch: 'ora/fix/negative-add',
    status: 'ready',
    baseRef: git(repo, 'rev-parse', 'main'),
  });
  expect(git(created.worktree.path, 'branch', '--show-current')).toBe('ora/fix/negative-add');

  const duplicate = await create('fix/negative-add');
  expect(duplicate.status).toBe(409);
  expect(((await duplicate.json()) as { error: string }).error).toContain('이미 있습니다');

  const notRepo = await call('/api/worktrees', {
    method: 'POST',
    body: { repo: home, name: 'x' },
  });
  expect(notRepo.status).toBeGreaterThanOrEqual(400);
});

// (가) 초기 명령이 실패하면 남은 명령을 건너뛰고, 서버를 다시 켜도 같은 상태가 보이며, 다시 실행은 실패한 명령부터 돈다.
test('초기 명령 실패는 남은 명령을 건너뛰고 재시작 뒤에도 남으며 실패한 명령부터 다시 돈다', async () => {
  const { home, repo } = createHome(['echo ok', 'false', 'echo never']);
  // 앞서 죽은 서버가 남긴 잠금이다. pid가 죽어 있으면 기다리지 않고 치워야 한다.
  const deadPid = execFileSync('node', ['-p', 'process.pid'], { encoding: 'utf8' }).trim();
  writeFileSync(join(home, 'worktrees.json.lock'), `${deadPid}:stale-owner`);
  const first = await boot(home, repo);
  const created = worktreeResponseSchema.parse(
    await (
      await first.call('/api/worktrees', {
        method: 'POST',
        body: { repo, name: 'setup', parent: 'main' },
      })
    ).json(),
  );
  const id = created.worktree.id;

  await expect
    .poll(async () => (await first.read(id))?.status, { timeout: 15_000 })
    .toBe('setup-failed');
  const failed = await first.read(id);
  expect(failed?.commands.map((command) => command.status)).toEqual(['done', 'failed', 'skipped']);
  expect(failed?.commands[1]?.exitCode).toBe(1);
  await expect.poll(() => existsSync(join(home, 'worktrees.json.lock'))).toBe(false);

  await first.server.close();
  servers.pop();
  const second = await boot(home, repo);
  const kept = worktreesFileSchema.parse({
    schemaVersion: 1,
    worktrees: ((await (await second.call('/api/worktrees')).json()) as { worktrees: unknown[] })
      .worktrees,
  });
  expect(kept.worktrees[0]?.status).toBe('setup-failed');

  const rerun = await second.call(`/api/worktrees/${id}/rerun`, { method: 'POST', body: {} });
  expect(rerun.status).toBe(200);
  await expect
    .poll(async () => (await second.read(id))?.commands.map((command) => command.status), {
      timeout: 15_000,
    })
    .toEqual(['done', 'failed', 'skipped']);
});
