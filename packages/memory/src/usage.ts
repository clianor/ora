import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { formatKst } from '@ora/core';
import type { Clock } from '@ora/core';
import type { MemorySessionFeedback, MemoryUsageResponse } from '@ora/protocol';
import { parseLessons, readIfExists, readStagingBlocks, readUsageRows } from './store.ts';

const USAGE_WINDOW_DAYS = 30;

/** 메모리 ID로 문장을 찾는다. LESSONS.md와 스테이징을 먼저 보고, 없으면 보관한 항목의 마지막 문장이다. */
async function readTexts(memoryDir: string): Promise<(id: string) => Promise<string>> {
  const live = new Map(
    [
      ...parseLessons(await readIfExists(join(memoryDir, 'LESSONS.md'))),
      ...(await readStagingBlocks(memoryDir)).flatMap((entry) => entry.blocks),
    ].map((block) => [block.id, block.text]),
  );
  return async (id) => {
    const found = live.get(id);
    if (found !== undefined) return found;
    const archived = parseLessons(await readIfExists(join(memoryDir, 'archive', `${id}.md`)));
    return archived.at(-1)?.text ?? id;
  };
}

/**
 * 사용자가 고른 도움 여부를 `usage.jsonl`에 새 줄로 덧붙인다. 기존 줄은 고치지 않는다.
 * 같은 세션·메모리에서 다시 고르면 마지막 줄이 이기고, `helpful: null` 줄이 선택을 해제한다.
 * 그 세션이 그 메모리를 회상 팩에 넣은 적이 없으면 `false`다.
 */
export async function recordHelpful(
  memoryDir: string,
  clock: Clock,
  input: { sessionId: string; lessonId: string; helpful: boolean | null },
): Promise<boolean> {
  const rows = await readUsageRows(memoryDir);
  if (!rows.some((row) => row.sessionId === input.sessionId && row.lessonId === input.lessonId)) {
    return false;
  }
  await mkdir(memoryDir, { recursive: true });
  await appendFile(
    join(memoryDir, 'usage.jsonl'),
    `${JSON.stringify({ lessonId: input.lessonId, sessionId: input.sessionId, ts: formatKst(clock.now()), injected: false, helpful: input.helpful })}\n`,
    'utf8',
  );
  return true;
}

/** 세션 하나가 회상 팩에 넣은 메모리와 사용자가 고른 도움 여부다. 넣은 메모리가 없으면 `items`가 빈다. */
export async function readSessionFeedback(
  memoryDir: string,
  sessionId: string,
): Promise<MemorySessionFeedback> {
  const textOf = await readTexts(memoryDir);
  const picked = new Map<string, boolean | null>();
  for (const row of await readUsageRows(memoryDir)) {
    if (row.sessionId === sessionId) picked.set(row.lessonId, row.helpful);
  }
  const items: MemorySessionFeedback['items'] = [];
  for (const [lessonId, helpful] of picked) {
    items.push({ lessonId, text: await textOf(lessonId), helpful });
  }
  return { items };
}

/** 최근 30일 사용 요약과 메모리별로 쓴 세션이다. 넣은 횟수가 많은 메모리가 먼저다. */
export async function readUsageReport(
  memoryDir: string,
  clock: Clock,
  titleOf: (sessionId: string) => Promise<string | undefined>,
): Promise<MemoryUsageResponse> {
  const sinceMs = clock.now().getTime() - USAGE_WINDOW_DAYS * 86_400_000;
  const rows = (await readUsageRows(memoryDir)).filter((row) => row.ms >= sinceMs);
  const textOf = await readTexts(memoryDir);
  const byLesson = new Map<string, typeof rows>();
  for (const row of rows) byLesson.set(row.lessonId, [...(byLesson.get(row.lessonId) ?? []), row]);
  const items: MemoryUsageResponse['items'] = [];
  for (const [id, list] of byLesson) {
    const sessions: MemoryUsageResponse['items'][number]['sessions'] = [];
    for (const row of [...list].sort((a, b) => b.ms - a.ms)) {
      const title = await titleOf(row.sessionId);
      sessions.push({
        sessionId: row.sessionId,
        ...(title === undefined ? {} : { sessionTitle: title }),
        at: row.ts,
        helpful: row.helpful,
      });
    }
    items.push({
      id,
      text: await textOf(id),
      useCount: list.length,
      helpfulCount: list.filter((row) => row.helpful === true).length,
      sessions,
    });
  }
  items.sort((a, b) => b.useCount - a.useCount);
  return {
    windowDays: USAGE_WINDOW_DAYS,
    injectedCount: rows.length,
    helpfulCount: rows.filter((row) => row.helpful === true).length,
    unhelpfulCount: rows.filter((row) => row.helpful === false).length,
    unansweredCount: rows.filter((row) => row.helpful === null).length,
    items,
  };
}
