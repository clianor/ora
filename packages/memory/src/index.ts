import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findSecretPatterns, formatKst, scoreBm25 } from '@ora/core';
import type {
  Clock,
  ConflictJudge,
  ConflictJudgement,
  MaintenanceResult,
  MemoryCandidate,
  MemoryDecision,
  MemoryPort,
  RecallPack,
} from '@ora/core';

export interface FileMemoryOptions {
  readonly memoryDir: string;
  readonly projectId: string;
  readonly clock: Clock;
}

const MAX_LESSON_CHARS = 240;
// ponytail: 3.3절이 수치를 정하지 않아 정한 제안값이다. 점수는 BM25에 `RECENCY_WEIGHT × 0.5^(마지막 사용 후 일수 / 반감기)`를 더한다.
const RECENCY_WEIGHT = 0.3;
const RECENCY_HALF_LIFE_DAYS = 14;

// ponytail: 3.4절이 기준을 정하지 않아 정한 제안값이다. 후보는 새 교훈 자신과의 BM25 점수 대비 0.3 이상인 기존 교훈 가운데 상위 3개다.
const CONFLICT_MIN_RELATIVE_SCORE = 0.3;
const CONFLICT_CANDIDATE_COUNT = 3;

function pickConflictCandidates(
  text: string,
  pool: readonly { id: string; text: string }[],
): { id: string; text: string }[] {
  if (pool.length === 0) return [];
  const scores = scoreBm25(text, [...pool.map((item) => item.text), text]);
  const self = scores.at(-1) ?? 0;
  if (self <= 0) return [];
  return pool
    .map((item, index) => ({ id: item.id, text: item.text, relative: (scores[index] ?? 0) / self }))
    .filter((item) => item.relative >= CONFLICT_MIN_RELATIVE_SCORE)
    .sort((a, b) => b.relative - a.relative)
    .slice(0, CONFLICT_CANDIDATE_COUNT)
    .map(({ id, text: body }) => ({ id, text: body }));
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}]+/gu, '');
}
const CHARS_PER_TOKEN = 4;
const TIMESTAMP_LINE = /^\s*(?:\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\[?\d{2}:\d{2}:\d{2})/;

function countSentences(text: string): number {
  return text
    .trim()
    .split(/(?<=[.!?。])\s+|\n+/)
    .filter((part) => part.trim() !== '').length;
}

function looksLikeRawLog(text: string): boolean {
  const lines = text.split('\n');
  const quoted = lines.filter((line) => line.trimStart().startsWith('>')).length;
  const timestamped = lines.filter((line) => TIMESTAMP_LINE.test(line)).length;
  return quoted >= 2 || timestamped >= 2;
}

async function readIfExists(path: string): Promise<string> {
  return readFile(path, 'utf8').catch(() => '');
}

/**
 * LESSONS.md와 review-queue.md를 직접 쓰는 기억 저장소다 (M1 단일 세션 허용 범위).
 * 판정 순서는 Refuse, 형식 반려, Defer, Remember다. 한 사실이 아닌 후보는 큐에 쌓지 않는다.
 */
export function createFileMemory(options: FileMemoryOptions): MemoryPort {
  const lessonsPath = join(options.memoryDir, 'LESSONS.md');
  const queuePath = join(options.memoryDir, 'review-queue.md');
  const dateStamp = () => formatKst(options.clock.now()).slice(0, 10);

  /** 일련번호는 LESSONS.md와 archive/에 있는 ID 가운데 가장 큰 값 다음이다. 아카이브한 ID를 다시 주지 않는다. */
  async function nextId(prefix: 'L' | 'Q', path: string): Promise<string> {
    const compact = dateStamp().replaceAll('-', '');
    const pattern = new RegExp(`${prefix}-${compact}-(\\d{3})`, 'g');
    const archived =
      prefix === 'L'
        ? (await readdir(join(options.memoryDir, 'archive')).catch(() => [])).join('\n')
        : '';
    const found = [...`${await readIfExists(path)}\n${archived}`.matchAll(pattern)].map((match) =>
      Number(match[1]),
    );
    return `${prefix}-${compact}-${String(Math.max(0, ...found) + 1).padStart(3, '0')}`;
  }

  async function appendEntry(path: string, entry: string): Promise<void> {
    await mkdir(options.memoryDir, { recursive: true });
    await appendFile(path, `${entry}\n\n`, 'utf8');
  }

  const sessionLessons = new Map<string, string>();
  const usagePath = join(options.memoryDir, 'usage.jsonl');

  async function readLastUsed(): Promise<Map<string, number>> {
    const lastUsed = new Map<string, number>();
    for (const line of (await readIfExists(usagePath)).split('\n')) {
      try {
        const row = JSON.parse(line) as { lessonId?: unknown; ts?: unknown; injected?: unknown };
        if (typeof row.lessonId !== 'string' || typeof row.ts !== 'string' || row.injected !== true)
          continue;
        const ms = Date.parse(row.ts);
        if (!Number.isNaN(ms))
          lastUsed.set(row.lessonId, Math.max(lastUsed.get(row.lessonId) ?? 0, ms));
      } catch {
        continue;
      }
    }
    return lastUsed;
  }

  return {
    async recall(request): Promise<RecallPack> {
      const content = await readIfExists(lessonsPath);
      const candidates: { id: string; text: string }[] = [];
      for (const block of content.split(/^## /m).slice(1)) {
        const [header = '', text = ''] = block.split('\n');
        const id = header.split(' · ')[0] ?? '';
        const inScope =
          header.includes('[global]') || header.includes(`[project:${options.projectId}]`);
        if (inScope) candidates.push({ id, text });
      }
      const lastUsed = await readLastUsed();
      const nowMs = options.clock.now().getTime();
      const scores = scoreBm25(
        request.query,
        candidates.map((candidate) => candidate.text),
      );
      const ranked = candidates
        .map((lesson, index) => {
          const used = lastUsed.get(lesson.id);
          const days = used === undefined ? Infinity : Math.max(0, (nowMs - used) / 86_400_000);
          const recency = RECENCY_WEIGHT * 0.5 ** (days / RECENCY_HALF_LIFE_DAYS);
          return { lesson, score: (scores[index] ?? 0) + recency };
        })
        .sort((a, b) => b.score - a.score);
      const lessons: { id: string; text: string }[] = [];
      let tokenCount = 0;
      for (const { lesson } of ranked) {
        const tokens = Math.ceil(lesson.text.length / CHARS_PER_TOKEN);
        if (tokenCount + tokens > request.tokenBudget) continue;
        lessons.push(lesson);
        tokenCount += tokens;
      }
      if (lessons.length > 0) {
        const ts = formatKst(options.clock.now());
        const lines = lessons.map(
          (lesson) =>
            `${JSON.stringify({ lessonId: lesson.id, sessionId: request.sessionId, ts, injected: true, helpful: null })}\n`,
        );
        await mkdir(options.memoryDir, { recursive: true });
        await appendFile(usagePath, lines.join(''), 'utf8');
      }
      return { lessons, tokenCount };
    },

    async propose(candidate: MemoryCandidate, sessionId: string): Promise<MemoryDecision> {
      const text = candidate.text.trim();
      const source = candidate.source?.trim();
      const secrets = findSecretPatterns(`${text}\n${source ?? ''}`);
      if (secrets.length > 0) {
        return { decision: 'refuse', reason: `비밀 패턴(${secrets.join(', ')})이 들어 있습니다.` };
      }
      if (/^#/m.test(text) || (source !== undefined && /[\r\n]|^#/.test(source))) {
        return {
          decision: 'rejected',
          reason: '텍스트와 출처는 한 줄이어야 하고 #으로 시작할 수 없습니다.',
        };
      }
      if (looksLikeRawLog(text)) {
        return { decision: 'refuse', reason: '원시 로그나 대화 전문 형태입니다.' };
      }
      if (text.length > MAX_LESSON_CHARS || countSentences(text) > 1) {
        return {
          decision: 'rejected',
          reason: `한 사실(${MAX_LESSON_CHARS}자 이내, 한 문장)이어야 합니다. 쪼개서 다시 냅니다.`,
        };
      }
      if (source === undefined) {
        const id = await nextId('Q', queuePath);
        await appendEntry(
          queuePath,
          `## ${id} · ${dateStamp()} · defer\n${text}\n사유: 출처 없음\n세션: ${sessionId}`,
        );
        return { decision: 'defer', reason: `출처가 없어 리뷰 큐 ${id}에 보냈습니다.` };
      }
      const id = await nextId('L', lessonsPath);
      await appendEntry(
        lessonsPath,
        `## ${id} · ${dateStamp()} · [project:${options.projectId}] · lesson · retention:default\n${text}\n근거: ${source}`,
      );
      sessionLessons.set(id, sessionId);
      return { decision: 'remember', lessonId: id };
    },

    async maintain(judge?: ConflictJudge): Promise<MaintenanceResult> {
      const result: {
        merged: { keptId: string; archivedIds: string[] }[];
        invalidated: { id: string; replacedBy: string }[];
        deferred: { id: string; queueId: string }[];
      } = { merged: [], invalidated: [], deferred: [] };
      if (sessionLessons.size === 0) return result;
      const blocks = (await readIfExists(lessonsPath))
        .split(/^## /m)
        .slice(1)
        .map((raw) => {
          const [header = '', text = ''] = raw.split('\n');
          const scope = /\[(?:global|project:[^\]]*)\]/.exec(header)?.[0] ?? '';
          return { raw: raw.trimEnd(), id: header.split(' · ')[0] ?? '', text, scope };
        });
      const ts = formatKst(options.clock.now());
      const passId = `pass-${[...new Set(sessionLessons.values())].join(', ')}`;
      const logLines: string[] = [];
      const log = (operation: string, ids: readonly string[], reason: string) => {
        logLines.push(
          `${ts} · ${operation} · ${ids.join(',')} · ${reason.replace(/\s+/g, ' ')} · ${passId}\n`,
        );
      };
      /** 아카이브로 옮길 교훈과 아카이브 파일에 덧붙일 줄이다. */
      const archived = new Map<string, string>();
      const deferred = new Set<string>();
      const mergedInto = new Map<string, string[]>();
      const isGone = (id: string) => archived.has(id) || deferred.has(id);
      const archive = (id: string, reason: string, label: string, other: string) => {
        archived.set(
          id,
          `아카이브: ${dateStamp()} · 사유: ${reason.replace(/\s+/g, ' ')} · ${label}: ${other}`,
        );
      };
      const merge = (keptId: string, id: string, reason: string) => {
        archive(id, '중복', '유지', keptId);
        mergedInto.set(keptId, [...(mergedInto.get(keptId) ?? []), id]);
        log('merge', [keptId, id], reason);
      };

      const keptByKey = new Map<string, string>();
      for (const block of blocks) {
        const key = `${block.scope}${normalizeText(block.text)}`;
        const kept = keptByKey.get(key);
        if (kept === undefined) keptByKey.set(key, block.id);
        else if (sessionLessons.has(block.id)) merge(kept, block.id, '같은 사실 중복');
      }

      if (judge !== undefined) {
        for (const block of blocks.filter((item) => sessionLessons.has(item.id))) {
          if (isGone(block.id)) continue;
          const pool = blocks.filter(
            (item) =>
              item.scope === block.scope && !sessionLessons.has(item.id) && !isGone(item.id),
          );
          const candidates = pickConflictCandidates(block.text, pool);
          if (candidates.length === 0) continue;
          let verdict: ConflictJudgement | undefined;
          try {
            verdict = await judge({ lessonId: block.id, text: block.text, candidates });
          } catch (error) {
            log(
              'skip',
              [block.id],
              `충돌 판정 요청 실패: ${error instanceof Error ? error.message : String(error)}`,
            );
            continue;
          }
          if (verdict === undefined) {
            log('skip', [block.id], '충돌 판정 응답 형식 오류');
            continue;
          }
          if (verdict.relation === 'unrelated') continue;
          const target = candidates.find((candidate) => candidate.id === verdict.targetId);
          if (target === undefined) {
            log('skip', [block.id], '판정의 대상 ID가 후보에 없음');
            continue;
          }
          if (verdict.relation === 'duplicate') {
            merge(target.id, block.id, `같은 사실 중복: ${verdict.reason}`);
          } else if (verdict.confident) {
            archive(target.id, `새 교훈과 모순: ${verdict.reason}`, '대체', block.id);
            result.invalidated.push({ id: target.id, replacedBy: block.id });
            log('invalidate', [target.id, block.id], verdict.reason);
          } else {
            const queueId = await nextId('Q', queuePath);
            await appendEntry(
              queuePath,
              `## ${queueId} · ${dateStamp()} · defer\n${block.text}\n사유: 기존 교훈 ${target.id}와 충돌할 수 있음\n세션: ${sessionLessons.get(block.id) ?? ''}`,
            );
            deferred.add(block.id);
            result.deferred.push({ id: block.id, queueId });
            log('defer', [block.id, queueId], verdict.reason);
          }
        }
      }

      if (archived.size > 0) {
        const archiveDir = join(options.memoryDir, 'archive');
        await mkdir(archiveDir, { recursive: true });
        for (const block of blocks.filter((item) => archived.has(item.id))) {
          await appendFile(
            join(archiveDir, `${block.id}.md`),
            `## ${block.raw}\n${archived.get(block.id) ?? ''}\n\n`,
            'utf8',
          );
        }
      }
      if (archived.size > 0 || deferred.size > 0) {
        const rewritten = blocks
          .filter((block) => !isGone(block.id))
          .map((block) => {
            const ids = mergedInto.get(block.id);
            return `## ${block.raw}${ids === undefined ? '' : `\n합침: ${ids.join(', ')}`}\n\n`;
          });
        await writeFile(lessonsPath, rewritten.join(''), 'utf8');
      }
      if (logLines.length > 0) {
        await mkdir(options.memoryDir, { recursive: true });
        await appendFile(join(options.memoryDir, 'maintenance-log.md'), logLines.join(''), 'utf8');
      }
      result.merged = [...mergedInto].map(([keptId, ids]) => ({ keptId, archivedIds: ids }));
      return result;
    },
  };
}
