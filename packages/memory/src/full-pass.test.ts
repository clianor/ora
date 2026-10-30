import { expect, test } from 'vitest';
import { decideFullPass } from './full-pass.ts';

// 하루 경과와 실행 중 세션은 사용자 조작으로 만들 수 없는 분기라서 입력을 직접 준다.
test('전체 패스는 세션이 없고 새 메모리가 있을 때, 하루가 지났거나 20개를 넘으면 돈다', () => {
  const hour = 3_600_000;
  const base = { hasLiveSession: false, newCount: 3, lastPassAtMs: 0, nowMs: 25 * hour };
  expect(decideFullPass(base)).toBe(true);
  expect(decideFullPass({ ...base, nowMs: 23 * hour })).toBe(false);
  expect(decideFullPass({ ...base, nowMs: 23 * hour, newCount: 21 })).toBe(true);
  expect(decideFullPass({ ...base, newCount: 0 })).toBe(false);
  expect(decideFullPass({ ...base, hasLiveSession: true })).toBe(false);
  expect(decideFullPass({ hasLiveSession: false, newCount: 3, nowMs: 25 * hour })).toBe(true);
});
