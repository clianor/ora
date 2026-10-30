import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createFileMemory } from './index.ts';

// (나) 두 세션이 동시에 끝나는 잠금 경쟁은 e2e가 입력을 만들 수 없는 분기다.
test('두 세션이 동시에 끝나도 두 세션의 메모리가 모두 LESSONS.md에 남는다', async () => {
  const memoryDir = mkdtempSync(join(tmpdir(), 'ora-staging-'));
  const clock = { now: () => new Date('2026-10-30T03:00:00Z') };
  const sessions = ['s-20261030-aaaaaa', 's-20261030-bbbbbb'];
  const memories = sessions.map(() => createFileMemory({ memoryDir, projectId: 'proj', clock }));
  await Promise.all(
    memories.map((memory, index) =>
      memory.propose({ text: `세션 ${String(index)}이 배운 사실이다.` }, sessions[index] ?? ''),
    ),
  );
  expect(() => readFileSync(join(memoryDir, 'LESSONS.md'), 'utf8')).toThrow();

  await Promise.all(memories.map((memory) => memory.maintain()));

  const lessons = readFileSync(join(memoryDir, 'LESSONS.md'), 'utf8');
  expect(lessons).toContain('세션 0이 배운 사실이다.');
  expect(lessons).toContain('세션 1이 배운 사실이다.');
  expect(lessons.match(/^## L-/gm)).toHaveLength(2);
});
