import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findSecretPatterns, formatKst } from '@ora/core';
import type { Clock, MemoryCandidate, MemoryDecision, MemoryPort, RecallPack } from '@ora/core';

export interface FileMemoryOptions {
  readonly memoryDir: string;
  readonly projectId: string;
  readonly clock: Clock;
}

const MAX_LESSON_CHARS = 240;
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

  async function nextId(prefix: 'L' | 'Q', path: string): Promise<string> {
    const date = dateStamp();
    const compact = date.replaceAll('-', '');
    const existing = (await readIfExists(path)).match(
      new RegExp(`^## ${prefix}-${compact}-\\d{3}`, 'gm'),
    );
    return `${prefix}-${compact}-${String((existing?.length ?? 0) + 1).padStart(3, '0')}`;
  }

  async function appendEntry(path: string, entry: string): Promise<void> {
    await mkdir(options.memoryDir, { recursive: true });
    await appendFile(path, `${entry}\n\n`, 'utf8');
  }

  return {
    async recall(request): Promise<RecallPack> {
      const content = await readIfExists(lessonsPath);
      const lessons: { id: string; text: string }[] = [];
      let tokenCount = 0;
      for (const block of content.split(/^## /m).slice(1)) {
        const [header = '', text = ''] = block.split('\n');
        const id = header.split(' · ')[0] ?? '';
        const inScope =
          header.includes('[global]') || header.includes(`[project:${options.projectId}]`);
        const tokens = Math.ceil(text.length / CHARS_PER_TOKEN);
        if (!inScope || tokenCount + tokens > request.tokenBudget) continue;
        lessons.push({ id, text });
        tokenCount += tokens;
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
      return { decision: 'remember', lessonId: id };
    },
  };
}
