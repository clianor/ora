import { appendFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatKst } from '@ora/core';
import type { Clock } from '@ora/core';
import type { MemoryLogEntry } from '@ora/protocol';
import {
  appendLog,
  archiveBlock,
  parseLessons,
  readIfExists,
  readStagingBlocks,
  withMemoryLock,
} from './store.ts';
import type { LessonBlock } from './store.ts';

/** 변경 취소를 거부할 때 던진다. 메시지가 사용자에게 보이는 이유다. */
export class MemoryRevertRefused extends Error {}

const REVERTIBLE = new Set(['merge', 'rewrite', 'archive', 'decay', 'delete', 'reflect']);
/** 메모리 내용을 바꾸지 않는 줄은 뒤의 변경 취소를 막지 않는다. */
const NON_CHANGING = new Set(['skip', 'flag']);
const REVERT_REASON = /^대상 줄 (\d+) · /;

/** `maintenance-log.md`를 줄 번호와 함께 읽는다. 줄 번호는 파일의 1부터 센 줄이다. 파일 순서대로 돌려준다. */
async function readLogEntries(memoryDir: string): Promise<MemoryLogEntry[]> {
  const entries: MemoryLogEntry[] = [];
  const lines = (await readIfExists(join(memoryDir, 'maintenance-log.md'))).split('\n');
  for (const [index, text] of lines.entries()) {
    const parts = text.split(' · ');
    const [at, operation, ids] = parts;
    const passId = parts.at(-1);
    if (parts.length < 5 || at === undefined || operation === undefined || passId === undefined)
      continue;
    const reason = parts.slice(3, -1).join(' · ');
    const revertsLine =
      operation === 'revert' ? Number(REVERT_REASON.exec(reason)?.[1]) : Number.NaN;
    entries.push({
      line: index + 1,
      at,
      operation,
      ids: (ids ?? '').split(',').filter((id) => id !== ''),
      reason,
      passId,
      isReverted: false,
      ...(Number.isNaN(revertsLine) ? {} : { revertsLine }),
    });
  }
  const reverted = new Set(entries.flatMap((entry) => entry.revertsLine ?? []));
  return entries.map((entry) => ({ ...entry, isReverted: reverted.has(entry.line) }));
}

interface ArchivedBlock {
  /** `아카이브:` 줄을 뺀 항목 원문이다. */
  readonly raw: string;
  /** 남아 있는 앞쪽 블록들이다. */
  readonly rest: string[];
  readonly block: LessonBlock;
}

async function peekArchived(memoryDir: string, id: string): Promise<ArchivedBlock | undefined> {
  const parts = (await readIfExists(join(memoryDir, 'archive', `${id}.md`)))
    .split(/^## /m)
    .slice(1);
  const last = parts.pop();
  if (last === undefined) return undefined;
  const raw = last
    .trimEnd()
    .split('\n')
    .filter((line) => !line.startsWith('아카이브: '))
    .join('\n');
  const block = parseLessons(`## ${raw}`)[0];
  return block === undefined ? undefined : { raw, rest: parts, block };
}

/** 아카이브 파일의 마지막 항목을 꺼내 LESSONS.md 뒤에 되살린다. 남은 항목이 없으면 파일을 지운다. */
async function restoreArchived(
  memoryDir: string,
  clock: Clock,
  found: ArchivedBlock,
): Promise<void> {
  await appendFile(
    join(memoryDir, 'LESSONS.md'),
    `## ${found.raw}\n복원: ${formatKst(clock.now())}\n\n`,
    'utf8',
  );
  const path = join(memoryDir, 'archive', `${found.block.id}.md`);
  if (found.rest.length === 0) await rm(path);
  else await writeFile(path, found.rest.map((part) => `## ${part.trimEnd()}\n\n`).join(''), 'utf8');
}

/** 로그 줄의 대상 메모리 문장을 채워 최신 줄이 먼저인 목록으로 돌려준다. 문장은 LESSONS.md, 스테이징, 아카이브 순으로 찾는다. */
export async function readMemoryLog(memoryDir: string): Promise<MemoryLogEntry[]> {
  const live = new Map(
    [
      ...parseLessons(await readIfExists(join(memoryDir, 'LESSONS.md'))),
      ...(await readStagingBlocks(memoryDir)).flatMap((entry) => entry.blocks),
    ].map((block) => [block.id, block.text]),
  );
  const entries = await readLogEntries(memoryDir);
  const withText: MemoryLogEntry[] = [];
  for (const entry of entries) {
    const id = entry.ids[0];
    const text =
      id === undefined
        ? undefined
        : (live.get(id) ?? (await peekArchived(memoryDir, id))?.block.text);
    withText.push(text === undefined ? entry : { ...entry, text });
  }
  return withText.reverse();
}

/**
 * 유지보수 변경 하나를 되돌린다 (SPEC 3.4절). 취소한 사실은 `revert` 줄로 로그에 덧붙이고 기존 줄은 고치지 않는다.
 * 거부하는 경우: 줄이 없음, 이미 취소함, 취소할 수 없는 연산, 같은 메모리를 뒤의 다른 줄이 이미 바꿈, 메모리가 기대한 자리에 없음.
 * 이미 취소한 줄과, 더 뒤의 줄을 취소하는 `revert` 줄은 같은 메모리를 바꾼 것으로 세지 않는다.
 */
export async function revertMemory(
  memoryDir: string,
  clock: Clock,
  line: number,
): Promise<{ line: number; operation: string }> {
  return withMemoryLock(memoryDir, async () => {
    const entries = await readLogEntries(memoryDir);
    const refuse = (message: string): never => {
      throw new MemoryRevertRefused(message);
    };
    const target = entries.find((entry) => entry.line === line);
    if (target === undefined) return refuse(`로그 ${line}번 줄이 없습니다.`);
    const { operation, ids } = target;
    if (target.isReverted) return refuse(`로그 ${line}번 줄은 이미 취소했습니다.`);
    if (!REVERTIBLE.has(operation)) {
      return refuse(
        `${operation} 줄은 취소할 수 없습니다. 취소할 수 있는 연산은 ${[...REVERTIBLE].join(', ')}입니다.`,
      );
    }
    const touched = new Set(ids);
    const later = entries.find(
      (entry) =>
        entry.line > line &&
        !NON_CHANGING.has(entry.operation) &&
        !entry.isReverted &&
        !((entry.revertsLine ?? 0) > line) &&
        entry.ids.some((id) => touched.has(id)),
    );
    if (later !== undefined) {
      return refuse(
        `${later.line}번 줄(${later.operation})이 같은 메모리를 이미 바꿨습니다. 그 줄을 먼저 취소해야 합니다.`,
      );
    }

    const lessonsPath = join(memoryDir, 'LESSONS.md');
    const blocks = parseLessons(await readIfExists(lessonsPath));
    const inLessons = (id: string) => blocks.find((block) => block.id === id);
    const [first = '', ...others] = ids;
    const writeLessons = (next: readonly { raw: string }[]) =>
      writeFile(lessonsPath, next.map((block) => `## ${block.raw}\n\n`).join(''), 'utf8');

    if (operation === 'merge') {
      const kept = inLessons(first);
      if (kept === undefined) return refuse(`합쳐서 남긴 ${first}가 LESSONS.md에 없습니다.`);
      const dropped: ArchivedBlock[] = [];
      for (const id of others) {
        const found = await peekArchived(memoryDir, id);
        if (found === undefined || inLessons(id) !== undefined) {
          return refuse(`원래 메모리 ${id}를 보관함에서 되살릴 수 없습니다.`);
        }
        dropped.push(found);
      }
      for (const found of dropped) await restoreArchived(memoryDir, clock, found);
      // restoreArchived가 LESSONS.md 뒤에 덧붙였으므로 합침 줄은 그 뒤에 다시 읽어 고친다.
      const fresh = parseLessons(await readIfExists(lessonsPath)).map((block) => {
        if (block.id !== first) return block;
        const rows = block.raw.split('\n').flatMap((row) => {
          if (!row.startsWith('합침: ')) return [row];
          const left = row
            .slice(4)
            .split(', ')
            .filter((id) => !others.includes(id));
          return left.length === 0 ? [] : [`합침: ${left.join(', ')}`];
        });
        return { ...block, raw: rows.join('\n') };
      });
      await writeLessons(fresh);
    } else if (operation === 'rewrite') {
      const previous = /이전 문장: "(.*)" · 사유: /.exec(target.reason)?.[1];
      const block = inLessons(first);
      if (previous === undefined) return refuse('로그에 이전 문장이 없어 되돌릴 수 없습니다.');
      if (block === undefined) return refuse(`${first}가 LESSONS.md에 없습니다.`);
      await writeLessons(
        blocks.map((item) => {
          if (item.id !== first) return item;
          const rows = item.raw.split('\n');
          rows[1] = previous;
          return { ...item, raw: rows.join('\n') };
        }),
      );
    } else if (operation === 'reflect') {
      const block = inLessons(first);
      if (block === undefined) return refuse(`반성으로 만든 ${first}가 LESSONS.md에 없습니다.`);
      await archiveBlock(memoryDir, clock, block, '반성 변경 취소');
      await writeLessons(blocks.filter((item) => item.id !== first));
    } else {
      const found = await peekArchived(memoryDir, first);
      const live =
        inLessons(first) !== undefined ||
        (await readStagingBlocks(memoryDir)).some((entry) =>
          entry.blocks.some((b) => b.id === first),
        );
      if (found === undefined || live) return refuse(`${first}를 보관함에서 되살릴 수 없습니다.`);
      await restoreArchived(memoryDir, clock, found);
    }

    await appendLog(memoryDir, clock, 'revert', ids, `대상 줄 ${line} · ${operation} 취소`, 'user');
    const after = await readLogEntries(memoryDir);
    return { line: after.at(-1)?.line ?? line, operation };
  });
}
