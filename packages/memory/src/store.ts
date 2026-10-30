import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatKst } from '@ora/core';
import type { Clock } from '@ora/core';
import type { MemoryItem, MemoryListResponse, MemoryPassSummary } from '@ora/protocol';

export async function readIfExists(path: string): Promise<string> {
  return readFile(path, 'utf8').catch(() => '');
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
  const blocks = parseLessons(await readIfExists(join(memoryDir, 'LESSONS.md')));
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

/** 사용자가 항목을 지운다. LESSONS.md에서 빼 아카이브로 옮기고 로그에 `delete`를 남긴다. 없는 ID면 `false`다. */
export async function deleteMemory(memoryDir: string, clock: Clock, id: string): Promise<boolean> {
  const lessonsPath = join(memoryDir, 'LESSONS.md');
  const blocks = parseLessons(await readIfExists(lessonsPath));
  const target = blocks.find((block) => block.id === id);
  if (target === undefined) return false;
  await archiveBlock(memoryDir, clock, target, USER_DELETE_REASON);
  await writeFile(
    lessonsPath,
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
