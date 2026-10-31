import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { startLocalServer } from './server.ts';
import type { LocalServer } from './server.ts';

const servers: LocalServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

// 시작할 때 주기 판정이 패스를 돌리지 않도록, 시드 메모리보다 나중인 시각의 패스 기록을 둔다.
const SEEDED_PASS = {
  at: '2099-01-01T00:00:00+09:00',
  outcome: 'ok',
  merged: 0,
  rewritten: 0,
  archived: 0,
  decayed: 0,
  reflected: 0,
  skippedBatches: 0,
};
const entry = (id: string, date: string, text: string, tags = '') =>
  `## ${id} · ${date} · [project:proj] · lesson · retention:default${tags}\n${text}\n근거: ${tags === ' · unsourced' ? '출처 없음' : '세션'}\n\n`;

const SEED =
  entry('L-20200101-001', '2020-01-01', 'add는 두 수를 더한다.') +
  entry('L-20200101-002', '2020-01-01', 'add는 두 수를 더하는 함수다.') +
  entry('L-20200101-003', '2020-01-01', '테스트는 pnpm check로 돈다.', ' · unsourced') +
  entry('L-20200101-004', '2020-01-01', 'node 18은 fetch 경고를 낸다.');

const SEED_SESSION = 's-20261030-seed01';
const SEED_TS = '2026-10-30T00:00:00+09:00';

/** `unused`에 든 시드 메모리를 뺀 나머지는 회상 팩에 넣은 적이 있는 것으로 usage.jsonl에 적는다. */
function createHome(scriptReplies: string[], unused: string[] = []) {
  const home = mkdtempSync(join(tmpdir(), 'ora-memory-'));
  const memoryDir = join(home, 'memory');
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, 'LESSONS.md'), SEED);
  writeFileSync(
    join(memoryDir, 'usage.jsonl'),
    ['001', '002', '003', '004']
      .filter((suffix) => !unused.includes(suffix))
      .map(
        (suffix) =>
          `${JSON.stringify({ lessonId: `L-20200101-${suffix}`, sessionId: SEED_SESSION, ts: SEED_TS, injected: true, helpful: null })}\n`,
      )
      .join(''),
  );
  writeFileSync(join(home, 'engine.config.json'), JSON.stringify({ projectId: 'proj' }));
  writeFileSync(join(memoryDir, 'maintenance-state.json'), JSON.stringify(SEEDED_PASS));
  const script = join(home, 'script.json');
  writeFileSync(
    script,
    JSON.stringify({
      responses: scriptReplies.map((text) => ({ content: [{ type: 'text', text }] })),
    }),
  );
  return { home, memoryDir, script };
}

async function boot(home: string, script: string) {
  const server = await startLocalServer({
    env: { ORA_HOME: home },
    cwd: home,
    modelScriptPath: script,
    port: 0,
  });
  servers.push(server);
  const start = await fetch(server.startUrl, { redirect: 'manual' });
  const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  return async (method: 'GET' | 'POST' | 'DELETE', path: string, body: unknown = {}) => {
    const response = await fetch(`${server.origin}${path}`, {
      method,
      headers: { cookie, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };
}

interface Item {
  id: string;
  text: string;
  isUnsourced: boolean;
  isStale: boolean;
}

test('목록은 출처 없음과 오래 안 씀을 표시하고 지운 항목은 아카이브와 로그에 남는다', async () => {
  const { home, memoryDir, script } = createHome([], ['004']);
  const call = await boot(home, script);

  const before = await call('GET', '/api/memory');
  const items = before.json.project as Item[];
  expect(items.find((item) => item.id === 'L-20200101-003')).toMatchObject({
    isUnsourced: true,
  });
  expect(items.find((item) => item.id === 'L-20200101-004')).toMatchObject({ isStale: true });

  expect((await call('DELETE', '/api/memory/L-20200101-003')).status).toBe(200);
  expect((await call('DELETE', '/api/memory/L-20200101-003')).status).toBe(404);

  const after = await call('GET', '/api/memory');
  expect((after.json.project as Item[]).map((item) => item.id)).not.toContain('L-20200101-003');
  expect(after.json.deletedIds).toEqual(['L-20200101-003']);
  expect(readFileSync(join(memoryDir, 'archive', 'L-20200101-003.md'), 'utf8')).toContain(
    '사유: 사용자가 지움',
  );
  expect(readFileSync(join(memoryDir, 'maintenance-log.md'), 'utf8')).toMatch(
    / · delete · L-20200101-003 · 사용자가 지움/,
  );
});

test('지금 다듬기는 합침, 문장 고침, 출처 없음 아카이브, 오래 안 쓴 항목 보관을 한다', async () => {
  const reply = JSON.stringify({
    merge: [{ keep: 'L-20200101-001', drop: ['L-20200101-002'], reason: '같은 사실' }],
    rewrite: [{ id: 'L-20200101-001', text: 'add 함수는 두 수를 더한다.', reason: '명확하게' }],
    archive: [{ id: 'L-20200101-003', reason: 'README와 모순' }],
  });
  const { home, memoryDir, script } = createHome([reply], ['004']);
  const call = await boot(home, script);

  const done = await call('POST', '/api/memory/tidy');
  expect(done.json).toMatchObject({
    outcome: 'ok',
    merged: 1,
    rewritten: 1,
    archived: 1,
    decayed: 1,
  });

  const lessons = readFileSync(join(memoryDir, 'LESSONS.md'), 'utf8');
  expect(lessons).toContain('add 함수는 두 수를 더한다.');
  expect(lessons).toContain('합침: L-20200101-002');
  expect(lessons).not.toContain('L-20200101-003');
  expect(lessons).not.toContain('L-20200101-004');
  expect(existsSync(join(memoryDir, 'archive', 'L-20200101-002.md'))).toBe(true);
  expect(readFileSync(join(memoryDir, 'archive', 'L-20200101-004.md'), 'utf8')).toContain(
    '사유: 오래 안 씀',
  );
  const log = readFileSync(join(memoryDir, 'maintenance-log.md'), 'utf8');
  expect(log).toMatch(/ · rewrite · L-20200101-001 · 이전 문장: "add는 두 수를 더한다\."/);
  expect(log).toMatch(/ · decay · L-20200101-004 · /);

  const list = await call('GET', '/api/memory');
  expect(list.json.lastPass).toMatchObject({ outcome: 'ok', merged: 1, archived: 1 });
});

test('응답 형식이 두 번 틀리면 그 묶음의 메모리를 건드리지 않는다', async () => {
  const { home, memoryDir, script } = createHome(['모르겠습니다', '{"merge":"없음"}']);
  const call = await boot(home, script);

  const done = await call('POST', '/api/memory/tidy');
  expect(done.json).toMatchObject({ outcome: 'ok', skippedBatches: 1, merged: 0, archived: 0 });
  expect(readFileSync(join(memoryDir, 'LESSONS.md'), 'utf8')).toBe(SEED);
  expect(existsSync(join(memoryDir, 'archive'))).toBe(false);
  expect(readFileSync(join(memoryDir, 'maintenance-log.md'), 'utf8')).toContain(
    '응답 형식이 두 번 틀려 이 묶음은 건드리지 않음',
  );
});

interface LogEntry {
  line: number;
  operation: string;
  isReverted: boolean;
}

test('변경 취소는 연산별로 되살리고, 이미 취소했거나 뒤에 바뀐 줄은 이유와 함께 거부한다', async () => {
  const reply = JSON.stringify({
    merge: [{ keep: 'L-20200101-001', drop: ['L-20200101-002'], reason: '같은 사실' }],
    rewrite: [{ id: 'L-20200101-001', text: 'add 함수는 두 수를 더한다.', reason: '명확하게' }],
    archive: [{ id: 'L-20200101-003', reason: 'README와 모순' }],
  });
  const { home, memoryDir, script } = createHome([reply], ['004']);
  const call = await boot(home, script);
  await call('POST', '/api/memory/tidy');
  const lineOf = async (operation: string) =>
    ((await call('GET', '/api/memory/log')).json.entries as LogEntry[]).find(
      (entry) => entry.operation === operation,
    )?.line ?? 0;
  const lessons = () => readFileSync(join(memoryDir, 'LESSONS.md'), 'utf8');

  const mergeLine = await lineOf('merge');
  const rewriteLine = await lineOf('rewrite');
  const early = await call('POST', '/api/memory/revert', { line: mergeLine });
  expect(early.status).toBe(409);
  expect(JSON.stringify(early.json)).toContain(`${rewriteLine}번 줄(rewrite)`);

  expect((await call('POST', '/api/memory/revert', { line: rewriteLine })).status).toBe(200);
  expect(lessons()).toContain('add는 두 수를 더한다.');
  const again = await call('POST', '/api/memory/revert', { line: rewriteLine });
  expect(again.status).toBe(409);
  expect(JSON.stringify(again.json)).toContain('이미 취소했습니다');

  expect((await call('POST', '/api/memory/revert', { line: mergeLine })).status).toBe(200);
  expect(lessons()).toContain('L-20200101-002');
  expect(lessons()).not.toContain('합침:');
  expect((await call('POST', '/api/memory/revert', { line: await lineOf('archive') })).status).toBe(
    200,
  );
  expect((await call('POST', '/api/memory/revert', { line: await lineOf('decay') })).status).toBe(
    200,
  );
  expect(lessons()).toContain('L-20200101-003');
  expect(lessons()).toContain('L-20200101-004');
  expect(existsSync(join(memoryDir, 'archive', 'L-20200101-004.md'))).toBe(false);

  const entries = (await call('GET', '/api/memory/log')).json.entries as LogEntry[];
  expect(entries.filter((entry) => entry.operation === 'revert')).toHaveLength(4);
  expect(entries.find((entry) => entry.line === rewriteLine)?.isReverted).toBe(true);

  const pick = (helpful: boolean | null) =>
    call('POST', '/api/memory/feedback', {
      sessionId: SEED_SESSION,
      lessonId: 'L-20200101-001',
      helpful,
    });
  const helpfulOf = async () =>
    (
      (await call('GET', `/api/memory/sessions/${SEED_SESSION}`)).json.items as {
        lessonId: string;
        helpful: boolean | null;
      }[]
    ).find((item) => item.lessonId === 'L-20200101-001')?.helpful;
  await pick(true);
  await pick(false);
  expect(await helpfulOf()).toBe(false);
  await pick(null);
  expect(await helpfulOf()).toBeNull();
  expect(
    readFileSync(join(memoryDir, 'usage.jsonl'), 'utf8').split('\n').filter(Boolean),
  ).toHaveLength(6);
  expect(
    (
      await call('POST', '/api/memory/feedback', {
        sessionId: 's-20261030-nouse1',
        lessonId: 'L-20200101-001',
        helpful: true,
      })
    ).status,
  ).toBe(404);
});
