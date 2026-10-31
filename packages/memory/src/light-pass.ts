import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatKst } from '@ora/core';
import type { Clock } from '@ora/core';
import {
  appendLog,
  archiveBlock,
  normalizeText,
  parseLessons,
  readIfExists,
  withMemoryLock,
} from './store.ts';

/**
 * 모델 없이 도는 가벼운 패스다 (`ora memory maintain`). 같은 범위에서 문장이 같은 항목을 먼저 저장한 항목 하나로 합치고,
 * 나머지는 아카이브로 옮겨 로그에 `merge`로 남긴다. 합친 항목 수를 돌려준다.
 */
export async function runLightPass(memoryDir: string, clock: Clock): Promise<number> {
  return withMemoryLock(memoryDir, async () => {
    const lessonsPath = join(memoryDir, 'LESSONS.md');
    const blocks = parseLessons(await readIfExists(lessonsPath));
    const passId = `pass-light-${formatKst(clock.now()).replace(/\D/g, '').slice(0, 14)}`;
    const keptByKey = new Map<string, string>();
    const droppedInto = new Map<string, string[]>();
    const dropped = new Set<string>();
    for (const block of blocks) {
      const key = `${block.scopeTag}${normalizeText(block.text)}`;
      const kept = keptByKey.get(key);
      if (kept === undefined) {
        keptByKey.set(key, block.id);
        continue;
      }
      dropped.add(block.id);
      droppedInto.set(kept, [...(droppedInto.get(kept) ?? []), block.id]);
      await archiveBlock(memoryDir, clock, block, '중복', ` · 유지: ${kept}`);
      await appendLog(memoryDir, clock, 'merge', [kept, block.id], '같은 사실 중복', passId);
    }
    if (dropped.size > 0) {
      const output = blocks
        .filter((block) => !dropped.has(block.id))
        .map((block) => {
          const ids = droppedInto.get(block.id);
          return `## ${block.raw}${ids === undefined ? '' : `\n합침: ${ids.join(', ')}`}\n\n`;
        });
      await writeFile(lessonsPath, output.join(''), 'utf8');
    }
    return dropped.size;
  });
}
