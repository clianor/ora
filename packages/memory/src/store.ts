import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { formatKst } from '@ora/core';
import type { Clock } from '@ora/core';
import type { MemoryItem, MemoryListResponse, MemoryPassSummary } from '@ora/protocol';

export async function readIfExists(path: string): Promise<string> {
  return readFile(path, 'utf8').catch(() => '');
}

const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 10 * 60_000;

/** 이 컴퓨터에 그 pid의 프로세스가 없으면 true다. 신호 권한이 없는 경우(EPERM)는 살아 있다고 본다. */
function isProcessGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
/**
 * 메모리 폴더의 쓰기 잠금이다. `.lock`을 `wx`로 만들어 잡고, 한 번에 한 곳만 LESSONS.md와 스테이징 파일을 바꾼다 (SPEC 3.5절).
 * 시간 안에 잡지 못하면 예외를 던진다.
 */
export async function withMemoryLock<T>(
  memoryDir: string,
  action: () => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  await mkdir(memoryDir, { recursive: true });
  const lockPath = join(memoryDir, '.lock');
  const owner = `${String(process.pid)}:${randomUUID()}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(owner);
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const seenOwner = await readIfExists(lockPath);
      const ownerPid = Number(seenOwner.split(':')[0]);
      if (Number.isInteger(ownerPid) && ownerPid > 0 && isProcessGone(ownerPid)) {
        if (seenOwner === (await readIfExists(lockPath))) await rm(lockPath, { force: true });
        continue;
      }
      const held = await stat(lockPath).catch(() => undefined);
      if (held !== undefined && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
        const seen = await readIfExists(lockPath);
        if (seen !== '' && seen === (await readIfExists(lockPath))) {
          await rm(lockPath, { force: true });
        }
        continue;
      }
      if (Date.now() > deadline)
        throw new Error('메모리 잠금을 잡지 못했습니다.', { cause: error });
      await delay(LOCK_RETRY_MS);
    }
  }
  try {
    return await action();
  } finally {
    if ((await readIfExists(lockPath)) === owner) await rm(lockPath, { force: true });
  }
}

export const stagingPath = (memoryDir: string, sessionId: string): string =>
  join(memoryDir, 'staging', `${sessionId}.md`);

/** 스테이징 파일마다 세션 ID와 그 안의 항목이다. */
export async function readStagingBlocks(
  memoryDir: string,
): Promise<{ sessionId: string; blocks: LessonBlock[] }[]> {
  const names = (await readdir(join(memoryDir, 'staging')).catch(() => [])).filter((name) =>
    name.endsWith('.md'),
  );
  return Promise.all(
    names.map(async (name) => ({
      sessionId: name.slice(0, -3),
      blocks: parseLessons(await readIfExists(join(memoryDir, 'staging', name))),
    })),
  );
}

/** 세션의 스테이징 파일을 LESSONS.md 뒤에 합치고 지운다. 잠금 안에서 부른다. 이미 합친 ID는 다시 넣지 않는다. */
export async function mergeStagingFile(memoryDir: string, sessionId: string): Promise<void> {
  const path = stagingPath(memoryDir, sessionId);
  const lessonsPath = join(memoryDir, 'LESSONS.md');
  const known = new Set(parseLessons(await readIfExists(lessonsPath)).map((block) => block.id));
  const fresh = parseLessons(await readIfExists(path)).filter((block) => !known.has(block.id));
  if (fresh.length > 0) {
    await appendFile(lessonsPath, fresh.map((block) => `## ${block.raw}\n\n`).join(''), 'utf8');
  }
  await rm(path, { force: true });
}

/** 주인 없는 스테이징 파일을 모두 합친다. `isOrphan`이 세션 ID마다 판정한다. 합친 파일 수를 돌려준다. */
export async function mergeOrphanStaging(
  memoryDir: string,
  isOrphan: (sessionId: string) => Promise<boolean>,
): Promise<number> {
  let merged = 0;
  for (const { sessionId } of await readStagingBlocks(memoryDir)) {
    if (!(await isOrphan(sessionId))) continue;
    await withMemoryLock(memoryDir, () => mergeStagingFile(memoryDir, sessionId));
    merged += 1;
  }
  return merged;
}

export function countSentences(text: string): number {
  return text
    .trim()
    .split(/(?<=[.!?。])\s+|\n+/)
    .filter((part) => part.trim() !== '').length;
}
/** LESSONS.md의 항목 하나다. `raw`는 `## ` 뒤부터 항목 끝까지의 원문이다. */
export interface LessonBlock {
  readonly raw: string;
  readonly id: string;
  readonly text: string;
  /** `[global]` 또는 `[project:<키>]`다. */
  readonly scopeTag: string;
  readonly retention: string;
  readonly isUnsourced: boolean;
  readonly source?: string;
  readonly sessionId?: string;
  /** 저장 시각이다. `저장:` 줄이 없는 옛 항목은 머리의 날짜 0시(KST)다. */
  readonly savedAt: string;
}

export function parseLessons(content: string): LessonBlock[] {
  return content
    .split(/^## /m)
    .slice(1)
    .map((raw) => {
      const lines = raw.trimEnd().split('\n');
      const header = lines[0] ?? '';
      const parts = header.split(' · ');
      const field = (label: string) =>
        lines
          .slice(2)
          .find((line) => line.startsWith(`${label}: `))
          ?.slice(label.length + 2);
      const date = parts[1] ?? '1970-01-01';
      return {
        raw: raw.trimEnd(),
        id: parts[0] ?? '',
        text: lines[1] ?? '',
        scopeTag: /\[(?:global|project:[^\]]*)\]/.exec(header)?.[0] ?? '',
        retention: parts.find((part) => part.startsWith('retention:'))?.slice(10) ?? 'default',
        isUnsourced: parts.includes('unsourced'),
        ...(field('근거') === undefined ? {} : { source: field('근거') }),
        ...(field('세션') === undefined ? {} : { sessionId: field('세션') }),
        savedAt: field('저장') ?? `${date}T00:00:00+09:00`,
      };
    });
}

/** 회상 팩에 넣은 횟수와 마지막 사용 시각이다. `usage.jsonl`의 `injected: true` 줄에서 센다. */
export async function readUsage(
  memoryDir: string,
): Promise<Map<string, { count: number; lastMs: number }>> {
  const usage = new Map<string, { count: number; lastMs: number }>();
  for (const line of (await readIfExists(join(memoryDir, 'usage.jsonl'))).split('\n')) {
    try {
      const row = JSON.parse(line) as { lessonId?: unknown; ts?: unknown; injected?: unknown };
      if (typeof row.lessonId !== 'string' || typeof row.ts !== 'string' || row.injected !== true)
        continue;
      const ms = Date.parse(row.ts);
      if (Number.isNaN(ms)) continue;
      const entry = usage.get(row.lessonId) ?? { count: 0, lastMs: 0 };
      usage.set(row.lessonId, { count: entry.count + 1, lastMs: Math.max(entry.lastMs, ms) });
    } catch {
      continue;
    }
  }
  return usage;
}

// ponytail: 열린 질문 12번의 예시를 제안값으로 쓴다. 기본 보존이고 사용 0회이며 저장한 지 90일이 지난 항목이 망각 후보다.
const FORGET_AFTER_DAYS = 90;

export function isForgetCandidate(
  block: LessonBlock,
  usage: { count: number; lastMs: number } | undefined,
  nowMs: number,
): boolean {
  if (block.retention !== 'default' || (usage?.count ?? 0) > 0) return false;
  return nowMs - Date.parse(block.savedAt) > FORGET_AFTER_DAYS * 86_400_000;
}

const PASS_STATE_FILE = 'maintenance-state.json';

export async function readPassState(memoryDir: string): Promise<MemoryPassSummary | undefined> {
  try {
    return JSON.parse(
      await readFile(join(memoryDir, PASS_STATE_FILE), 'utf8'),
    ) as MemoryPassSummary;
  } catch {
    return undefined;
  }
}

export async function writePassState(memoryDir: string, state: MemoryPassSummary): Promise<void> {
  await mkdir(memoryDir, { recursive: true });
  await writeFile(join(memoryDir, PASS_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

const USER_DELETE_REASON = '사용자가 지움';

/** `maintenance-log.md`에 한 줄을 덧붙인다. 형식은 SPEC 3.4절의 `<ISO 시각> · <연산> · <대상 ID들> · <사유> · <패스 ID>`다. */
export async function appendLog(
  memoryDir: string,
  clock: Clock,
  operation: string,
  ids: readonly string[],
  reason: string,
  passId: string,
): Promise<void> {
  await mkdir(memoryDir, { recursive: true });
  await appendFile(
    join(memoryDir, 'maintenance-log.md'),
    `${formatKst(clock.now())} · ${operation} · ${ids.join(',')} · ${reason.replace(/\s+/g, ' ')} · ${passId}\n`,
    'utf8',
  );
}

/** 아카이브 파일에 항목 원문과 사유를 덧붙인다. 하드 삭제는 없다. */
export async function archiveBlock(
  memoryDir: string,
  clock: Clock,
  block: LessonBlock,
  reason: string,
  extra = '',
): Promise<void> {
  const archiveDir = join(memoryDir, 'archive');
  await mkdir(archiveDir, { recursive: true });
  await appendFile(
    join(archiveDir, `${block.id}.md`),
    `## ${block.raw}\n아카이브: ${formatKst(clock.now()).slice(0, 10)} · 사유: ${reason.replace(/\s+/g, ' ')}${extra}\n\n`,
    'utf8',
  );
}

export interface ListOptions {
  readonly memoryDir: string;
  readonly projectId: string;
  readonly clock: Clock;
  /** 세션 ID로 제목을 찾는다. 모르면 `undefined`다. */
  readonly titleOf: (sessionId: string) => Promise<string | undefined>;
}

/** 설정 › 메모리가 보여 줄 목록이다. 이 프로젝트와 `[global]` 항목만 담는다. */
export async function listMemories(
  options: ListOptions,
): Promise<Omit<MemoryListResponse, 'isTidying'>> {
  const { memoryDir } = options;
  const blocks = [
    ...parseLessons(await readIfExists(join(memoryDir, 'LESSONS.md'))),
    ...(await readStagingBlocks(memoryDir)).flatMap((entry) => entry.blocks),
  ];
  const usage = await readUsage(memoryDir);
  const nowMs = options.clock.now().getTime();
  const toItem = async (block: LessonBlock, scope: 'project' | 'global'): Promise<MemoryItem> => {
    const used = usage.get(block.id);
    const title =
      block.sessionId === undefined ? undefined : await options.titleOf(block.sessionId);
    return {
      id: block.id,
      text: block.text,
      scope,
      savedAt: block.savedAt,
      ...(block.sessionId === undefined ? {} : { sessionId: block.sessionId }),
      ...(title === undefined ? {} : { sessionTitle: title }),
      useCount: used?.count ?? 0,
      ...(used === undefined ? {} : { lastUsedAt: formatKst(new Date(used.lastMs)) }),
      isUnsourced: block.isUnsourced,
      isStale: isForgetCandidate(block, used, nowMs),
    };
  };
  const newestFirst = (a: MemoryItem, b: MemoryItem) => b.savedAt.localeCompare(a.savedAt);
  const project = await Promise.all(
    blocks
      .filter((b) => b.scopeTag === `[project:${options.projectId}]`)
      .map((b) => toItem(b, 'project')),
  );
  const global = await Promise.all(
    blocks.filter((b) => b.scopeTag === '[global]').map((b) => toItem(b, 'global')),
  );
  const deletedIds: string[] = [];
  const archivedIds: string[] = [];
  for (const name of await readdir(join(memoryDir, 'archive')).catch(() => [])) {
    if (!name.endsWith('.md')) continue;
    const id = name.slice(0, -3);
    const text = await readIfExists(join(memoryDir, 'archive', name));
    (text.includes(`사유: ${USER_DELETE_REASON}`) ? deletedIds : archivedIds).push(id);
  }
  const lastPass = await readPassState(memoryDir);
  return {
    projectName: options.projectId,
    project: project.sort(newestFirst),
    global: global.sort(newestFirst),
    deletedIds,
    archivedIds,
    ...(lastPass === undefined ? {} : { lastPass }),
  };
}

/**
 * 사용자가 항목을 지운다. LESSONS.md나 스테이징 파일에서 빼 아카이브로 옮기고 로그에 `delete`를 남긴다. 없는 ID면 `false`다.
 */
export async function deleteMemory(memoryDir: string, clock: Clock, id: string): Promise<boolean> {
  return withMemoryLock(memoryDir, async () => {
    const files = [
      join(memoryDir, 'LESSONS.md'),
      ...(await readStagingBlocks(memoryDir)).map((entry) =>
        stagingPath(memoryDir, entry.sessionId),
      ),
    ];
    for (const file of files) {
      const blocks = parseLessons(await readIfExists(file));
      const target = blocks.find((block) => block.id === id);
      if (target === undefined) continue;
      await archiveBlock(memoryDir, clock, target, USER_DELETE_REASON);
      await writeFile(
        file,
        blocks
          .filter((block) => block.id !== id)
          .map((block) => `## ${block.raw}\n\n`)
          .join(''),
        'utf8',
      );
      await appendLog(
        memoryDir,
        clock,
        'delete',
        [id],
        `${USER_DELETE_REASON}: ${target.text}`,
        'user',
      );
      return true;
    }
    return false;
  });
}
