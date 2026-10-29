import type { EventOf, OraEvent } from '@ora/protocol';

/** 서버가 세션 정보로 알려 주는 컨텍스트 한도입니다. 창 크기를 모르면 비율을 계산하지 않습니다. */
export interface ContextLimits {
  contextWindow?: number;
  compactAtRatio: number;
  keepRecentTokens: number;
}

export type CompactionMethod = EventOf<'compaction'>['payload']['method'];

export const methodLabel: Record<CompactionMethod, string> = {
  prune: '도구 출력 생략',
  shake: '참조로 치환',
  handoff: '인계 문서',
  summary: '요약',
  remote: '서버 요약',
};

export interface ContextView {
  /** 마지막 스텝 요청의 입력 합계를 창 크기로 나눈 값입니다. 1을 넘을 수 있습니다. */
  rate: number;
  used: number;
  window: number;
  compactAtRatio: number;
  keepRecentTokens: number;
  /** 가지치기로 생략한 도구 출력 수와 그때 줄인 어림 토큰 수입니다. */
  pruned: { count: number; savedTokens: number };
  /** `shake`, `handoff`, `summary`로 컨텍스트를 바꾼 횟수와 마지막 방식·범위입니다. */
  compaction: {
    count: number;
    last: { method: CompactionMethod; range: StepRange | null } | null;
  };
}

/**
 * 이벤트에서 컨텍스트 사용 보기를 만듭니다. 요약 요청(`purpose: 'compaction'`)은 스텝 입력이 아니므로 뺍니다.
 * 창 크기를 모르거나 스텝 요청이 아직 없으면 null이라 항목을 숨깁니다.
 */
export function buildContextView(
  events: readonly OraEvent[],
  limits: ContextLimits | undefined,
): ContextView | null {
  if (limits?.contextWindow === undefined) return null;
  const last = events.findLast(
    (event) => event.type === 'model_request' && event.payload.purpose === undefined,
  );
  if (last?.type !== 'model_request') return null;
  const { uncachedInputTokens, cacheReadInputTokens, cacheCreationInputTokens } =
    last.payload.usage;
  const used = uncachedInputTokens + cacheReadInputTokens + cacheCreationInputTokens;

  const prunedIds = new Set<string>();
  let savedTokens = 0;
  let count = 0;
  let lastCompaction: ContextView['compaction']['last'] = null;
  for (const event of events) {
    if (event.type !== 'compaction') continue;
    const { method, fromSeq, toSeq, prunedCallIds, savedTokens: saved } = event.payload;
    if (method === 'prune') {
      prunedCallIds.forEach((id) => prunedIds.add(id));
      savedTokens += saved ?? 0;
    } else {
      count += 1;
      lastCompaction = { method, range: getStepRange(events, fromSeq, toSeq) };
    }
  }
  return {
    rate: used / limits.contextWindow,
    used,
    window: limits.contextWindow,
    compactAtRatio: limits.compactAtRatio,
    keepRecentTokens: limits.keepRecentTokens,
    pruned: { count: prunedIds.size, savedTokens },
    compaction: { count, last: lastCompaction },
  };
}

/** 창 크기와 기준 토큰을 `200k`, `160k`처럼 적습니다. 소수 한 자리는 0이면 뺍니다. */
export function formatWindow(count: number): string {
  return `${Math.round(count / 100) / 10}k`;
}

export interface StepRange {
  from: number;
  to: number;
}

/**
 * seq 범위 안에 있는 이벤트의 `stepId`("step-N")로 첫 스텝과 마지막 스텝을 찾습니다.
 * step-0(시작 준비)은 건너뜁니다. 범위 안에 스텝이 붙은 이벤트가 없으면 null입니다.
 */
export function getStepRange(
  events: readonly OraEvent[],
  fromSeq: number,
  toSeq: number,
): StepRange | null {
  let range: StepRange | null = null;
  for (const event of events) {
    if (event.seq < fromSeq || event.seq > toSeq) continue;
    const step = Number(/^step-(\d+)$/.exec(event.stepId ?? '')?.[1]);
    if (!(step > 0)) continue;
    range = range
      ? { from: Math.min(range.from, step), to: Math.max(range.to, step) }
      : { from: step, to: step };
  }
  return range;
}

/** 압축이 바꾼 범위를 "스텝 1~24"처럼 적습니다. 스텝을 알 수 없으면 "앞부분"입니다. */
export function formatRange(range: StepRange | null): string {
  return range ? `스텝 ${range.from}~${range.to}` : '앞부분';
}

interface SummarySpan {
  text: string;
  isCode: boolean;
}

export interface SummarySection {
  title: string;
  lines: SummarySpan[][];
}

const sectionTitles: Record<string, string> = {
  'todo 상태': '할 일',
  '사용자 지시 (원문)': '사용자 지시',
  '해결하지 못한 오류': '남은 오류',
  '진행 중인 턴 앞부분': '진행 중인 턴 앞부분',
};

function toSpans(raw: string): SummarySpan[] {
  return raw
    .split(/(`[^`]+`)/)
    .filter((part) => part !== '')
    .map((part) =>
      part.startsWith('`') && part.endsWith('`') && part.length > 1
        ? { text: part.slice(1, -1), isCode: true }
        : { text: part, isCode: false },
    );
}

/** "- t1 [verified] 내용" 줄과 바로 아래 "증거: `명령` 종료 코드 0, …" 줄을 시안처럼 한 줄로 합칩니다. */
function mergeTodoLines(lines: readonly string[]): SummarySpan[][] {
  const merged: SummarySpan[][] = [];
  for (const line of lines) {
    const head = /^- (\S+) \[(\w+)\] (.*)$/.exec(line);
    if (head) {
      merged.push([
        { text: `${head[1]} ${head[2]}`, isCode: true },
        { text: ` ${head[3]}`, isCode: false },
      ]);
      continue;
    }
    const evidence = /^\s+- 증거: `(.*)` 종료 코드 (\S+?),/.exec(line);
    const target = merged.at(-1);
    if (evidence && target) {
      target.push(
        { text: ' · ', isCode: false },
        { text: `${evidence[1]} → exit ${evidence[2]}`, isCode: true },
      );
    } else if (!line.includes('증거 없음')) {
      merged.push(toSpans(line.trim()));
    }
  }
  return merged;
}

/**
 * 압축 요약 파일(SPEC 4.3절)을 절로 나눕니다. 엔진이 기록에서 만든 절(할 일, 사용자 지시, 남은 오류)과
 * 모델이 쓴 절(인계 문서 또는 결정·경과)을 같은 모양으로 돌려주고, 그리는 쪽이 순서를 정합니다.
 */
export function parseSummaryDocument(
  text: string,
  method: 'handoff' | 'summary',
): SummarySection[] {
  const modelTitle = method === 'handoff' ? '인계 문서' : '결정·경과';
  return text
    .split(/^## /m)
    .slice(1)
    .map((block): SummarySection => {
      const [heading = '', ...rest] = block.split('\n');
      const title = heading.trim();
      const body = rest.map((line) => line.replace(/\s+$/, '')).filter((line) => line !== '');
      if (title === 'todo 상태') {
        return { title: sectionTitles[title] ?? title, lines: mergeTodoLines(body) };
      }
      if (title === '사용자 지시 (원문)') {
        return {
          title: sectionTitles[title] ?? title,
          lines: body
            .filter((line) => !line.startsWith('### '))
            .map((line) => [{ text: `“${line}”`, isCode: false }]),
        };
      }
      return {
        title: sectionTitles[title] ?? (title === '결정 기록과 작업 경과' ? modelTitle : title),
        lines: body.map((line) => toSpans(line.replace(/^- /, ''))),
      };
    });
}
