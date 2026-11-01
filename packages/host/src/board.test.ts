import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { BoardError, createBoardApi } from './board.ts';

// (나) 기본 제공 정의가 다섯 레인을 모두 덮으므로, 서버 e2e로는 정의가 없는 레인을 만들 수 없다.
test('레인 이름의 에이전트 정의가 없으면 카드 시작을 거부하고 세션을 열지 않는다', async () => {
  let started = 0;
  const api = createBoardApi({
    env: { ORA_HOME: mkdtempSync(join(tmpdir(), 'ora-board-')) },
    resolveRepo: (cwd) => Promise.resolve(cwd),
    assertKnownWorktree: () => Promise.resolve(),
    listWorktrees: () => Promise.resolve([]),
    readSession: () => Promise.resolve(undefined),
    listSessions: () => Promise.resolve([]),
    listAgentNames: () => Promise.resolve(['builder']),
    startSession: () => {
      started += 1;
      return Promise.resolve('s-20260101-abcdef');
    },
  });
  const card = await api.createCard('/repo', {
    title: 't',
    description: '',
    lane: 'qa',
    writeScope: [],
  });
  expect(card.startBlockedReason).toBeDefined();
  const error = await api.startCard('/repo', card.id, '/repo').catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(BoardError);
  expect((error as BoardError).code).toBe('no_definition');
  expect(started).toBe(0);
});
