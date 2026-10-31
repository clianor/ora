import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { runFullPass } from './full-pass.ts';

// 모델이 돌려줄 반성 후보의 개수와 근거 세션 수는 사용자 조작으로 만들 수 없는 입력이라서 응답을 직접 준다.
test('반성은 근거 세션 2개 이상만, 한 패스에 3개까지 받고 비밀정보는 거부한다', async () => {
  const memoryDir = mkdtempSync(join(tmpdir(), 'ora-reflect-'));
  const sessions = ['s-1', 's-2', 's-3'].map((id) => ({ id, title: id, text: '요청' }));
  const item = (text: string, ids: string[]) => ({ text, sessions: ids, reason: '반복' });
  const reflectReply = JSON.stringify({
    reflect: [
      item('커밋 메시지는 한국어로 쓴다.', ['s-1', 's-2']),
      item('수정 뒤에 출력을 직접 보여 준다.', ['s-1', 's-3']),
      item('근거가 한 세션뿐인 습관이다.', ['s-1']),
      item('토큰은 sk-abcdefghijklmnopqrstuvwx 이다.', ['s-1', 's-2']),
      item('테스트는 pnpm check로 돌린다.', ['s-2', 's-3']),
      item('네 번째 후보는 상한에 막힌다.', ['s-1', 's-2']),
    ],
  });
  const summary = await runFullPass({
    memoryDir,
    clock: { now: () => new Date('2026-10-31T00:00:00+09:00') },
    recentSessions: '',
    reflectionSessions: sessions,
    ask: () => Promise.resolve(reflectReply),
  });

  expect(summary.reflected).toBe(3);
  const lessons = readFileSync(join(memoryDir, 'LESSONS.md'), 'utf8');
  expect(lessons).toContain('커밋 메시지는 한국어로 쓴다.');
  expect(lessons).toContain('반성: s-1, s-2');
  expect(lessons).toContain('테스트는 pnpm check로 돌린다.');
  expect(lessons).not.toContain('한 세션뿐');
  expect(lessons).not.toContain('sk-');
  expect(lessons).not.toContain('네 번째');
  const log = readFileSync(join(memoryDir, 'maintenance-log.md'), 'utf8');
  expect(log.match(/ · reflect · /g)).toHaveLength(3);
});
