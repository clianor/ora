import { oraEventSchema } from '@ora/protocol';
import type {
  Actor,
  ContentBlock,
  EventOf,
  OraEvent,
  SessionStatus,
  Stage,
  Todo,
} from '@ora/protocol';
import type { ModelMessage, ModelUsage } from './ports/model.ts';
import { applyPrune, shakeMessages, summaryMessage } from './compaction.ts';
import type { OpenError } from './compaction.ts';
import { ensurePhase, phaseOf } from './todos.ts';
import type { EventDraft } from './recorder.ts';

export class TranscriptCorruptError extends Error {}

export interface ParsedTranscript {
  readonly events: readonly OraEvent[];
  /** 마지막 줄이 깨져 있어 버린 내용이다. */
  readonly torn?: { readonly lines: number; readonly bytes: number };
}

function parseLine(line: string): OraEvent | undefined {
  try {
    const parsed = oraEventSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * transcript.jsonl 본문을 이벤트로 읽는다 (SPEC 4.1.2절).
 * 깨진 줄은 마지막 줄이거나 바로 뒤에 `recovered` 이벤트가 있을 때만 허용한다. 그 밖의 깨진 줄은 손상이다.
 */
export function parseTranscript(text: string): ParsedTranscript {
  const events: OraEvent[] = [];
  let bad: string | undefined;
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line === '') continue;
    const event = parseLine(line);
    if (event === undefined) {
      if (bad !== undefined) {
        throw new TranscriptCorruptError(
          `transcript가 손상됐습니다: ${index}번째 줄 앞이 깨졌습니다.`,
        );
      }
      bad = line;
      continue;
    }
    if (bad !== undefined && event.type !== 'recovered') {
      throw new TranscriptCorruptError(
        `transcript가 손상됐습니다: ${index}번째 줄 앞에 깨진 줄이 있는데 recovered 이벤트가 없습니다.`,
      );
    }
    bad = undefined;
    events.push(event);
  }
  if (bad === undefined) return { events };
  return { events, torn: { lines: 1, bytes: new TextEncoder().encode(bad).length } };
}

export interface DraftEntry {
  readonly actor: Actor;
  readonly draft: EventDraft;
}

export interface StopCause {
  readonly hardKill: boolean;
  readonly reason: string;
}

function isRunOpen(events: readonly OraEvent[]): boolean {
  const marker = events.findLast(
    (event) =>
      event.type === 'session_end' || event.type === 'session_start' || event.type === 'resume',
  );
  return marker?.type !== 'session_end';
}

/**
 * 워커가 죽은 뒤 transcript에 덧붙일 이벤트를 만든다: 깨진 줄의 `recovered`, 결과 없는 호출의 `aborted` 결과,
 * 하드 킬이면 `cancel`, 마지막으로 `crashed` 종료. 이미 `session_end`로 닫힌 실행에는 봉인하지 않는다.
 */
export function planRecovery(parsed: ParsedTranscript, cause: StopCause): DraftEntry[] {
  const { events } = parsed;
  const drafts: DraftEntry[] = [];
  if (parsed.torn !== undefined) {
    drafts.push({
      actor: 'engine',
      draft: {
        type: 'recovered',
        payload: {
          droppedLines: parsed.torn.lines,
          droppedBytes: parsed.torn.bytes,
          afterSeq: events.at(-1)?.seq ?? 0,
        },
      },
    });
  }
  if (!isRunOpen(events)) return drafts;

  const pending = new Set<string>();
  for (const event of events) {
    if (event.type === 'tool_call') pending.add(event.payload.callId);
    if (event.type === 'tool_result') pending.delete(event.payload.callId);
  }
  for (const callId of pending) {
    drafts.push({
      actor: 'tool',
      draft: {
        type: 'tool_result',
        payload: {
          callId,
          status: 'aborted',
          summary: '워커가 종료되어 호출이 중단됐습니다.',
          durationMs: 0,
        },
      },
    });
  }
  if (cause.hardKill) {
    drafts.push({
      actor: 'engine',
      draft: { type: 'cancel', payload: { mode: 'hard', previousStatus: 'running' } },
    });
  }
  drafts.push({
    actor: 'engine',
    draft: {
      type: 'session_end',
      payload: {
        status: 'crashed',
        endReason: cause.hardKill ? 'user_cancel' : 'error',
        summary: cause.reason,
      },
    },
  });
  return drafts;
}

/** 같은 역할 메시지가 이어지면 내용 블록을 하나로 합친다. 모델 API는 같은 역할의 연속 메시지를 받지 않는다. */
export function appendMessage(history: ModelMessage[], message: ModelMessage): void {
  const last = history.at(-1);
  if (last?.role === message.role && message.role === 'user') {
    history[history.length - 1] = { role: 'user', content: [...last.content, ...message.content] };
    return;
  }
  history.push(message);
}

/** 기록에서 todo 상태를 다시 만든 결과다. 엔진이 실행 중에 만드는 값과 같은 규칙으로 계산한다. */
export interface TodoState {
  readonly todos: Map<string, Todo>;
  readonly objective: string;
  readonly phases: { name: string; criterion?: string }[];
  readonly current?: string;
}

export function reduceTodoState(events: readonly OraEvent[]): TodoState {
  const todos = new Map<string, Todo>();
  const order: string[] = [];
  const criteria = new Map<string, string>();
  let objective = '';
  let current: string | undefined;
  for (const event of events) {
    if (event.type === 'todo_update' && event.payload.rejected === undefined) {
      todos.set(event.payload.todoId, event.payload.todo);
      ensurePhase(order, phaseOf(event.payload.todo));
      if (event.payload.current !== undefined) current = event.payload.current ?? undefined;
    } else if (event.type === 'objective') {
      objective = event.payload.text;
    } else if (event.type === 'phase') {
      ensurePhase(order, event.payload.name);
      if (event.payload.criterion === null) criteria.delete(event.payload.name);
      else criteria.set(event.payload.name, event.payload.criterion);
    }
  }
  const phases = order.map((name) => {
    const criterion = criteria.get(name);
    return criterion === undefined ? { name } : { name, criterion };
  });
  return { todos, objective, phases, ...(current === undefined ? {} : { current }) };
}

export interface ContextTrim {
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly reason: 'failed_batch' | 'aborted_batch';
}

export interface ResumePlan {
  readonly task: string;
  readonly fromStatus: SessionStatus;
  readonly hardKilled: boolean;
  readonly stage: Stage;
  readonly todos: readonly Todo[];
  /** 세션 목표다. 없으면 빈 문자열이다. */
  readonly objective: string;
  /** 처음 나온 순서의 phase 목록과 완료 조건이다. */
  readonly phases: readonly { readonly name: string; readonly criterion?: string }[];
  /** 마지막 기록이 가리키는 작업 중 todo의 ID다. */
  readonly current?: string;
  readonly history: readonly ModelMessage[];
  readonly trim?: ContextTrim;
  /** 관찰 메시지를 쓰기 전에 죽은 배치의 도구 결과다. 모델 컨텍스트가 짝 없는 tool_use를 갖지 않게 한다. */
  readonly repair: readonly ContentBlock[];
  /** 마지막으로 검증 증거가 남은 todo다. */
  readonly resumePointTodoId?: string;
  readonly lastSeq: number;
  /** `history` 메시지마다 마지막으로 합쳐진 이벤트의 seq다. 요약이 대신하는 첫 메시지는 압축 범위의 시작 seq다. */
  readonly historySeqs: readonly number[];
  /** 사용자가 쓴 지시 원문이다(최초 요청과 조향). 압축으로 transcript가 컨텍스트에서 빠져도 전부 남는다. */
  readonly instructions: readonly string[];
  /** 도구마다 마지막 결과가 실패인 것이다. */
  readonly openErrors: readonly OpenError[];
  /** 마지막 압축 요약을 읽지 못해 되돌아간 기록이다. */
  readonly summaryFallback?: EventOf<'resume'>['payload']['summaryFallback'];
  /** 마지막 압축 요약이 `history`의 첫 메시지를 대신한다. */
  readonly hasSummary: boolean;
  /** 지난 실행까지 모델 요청마다 쓴 토큰이다. 재개한 세션이 비용 누적을 이어받는 데 쓴다. */
  readonly modelUsage: readonly { readonly model: string; readonly usage: ModelUsage }[];
  /** 비용 경고를 이미 한 번 남겼는지다. */
  readonly costWarned: boolean;
}

const BATCH_EVENT_TYPES: readonly OraEvent['type'][] = [
  'message',
  'intent',
  'tool_call',
  'tool_result',
  'permission',
  'approval_request',
  'question',
  'answer',
  'todo_update',
  'verification',
];

/**
 * 봉인까지 끝난 transcript에서 재개 계획을 만든다 (SPEC 4.1.3절, 2.9절).
 * 마지막 배치가 전부 실패·중단이면 그 꼬리를 모델 컨텍스트에서 뺀다. 일부라도 성공했으면 결과를 그대로 둔다.
 */
export function planResume(
  events: readonly OraEvent[],
  readSummary: (path: string) => string | undefined = () => undefined,
): ResumePlan {
  const lastEnd = events.findLast(
    (event): event is EventOf<'session_end'> => event.type === 'session_end',
  );
  if (lastEnd === undefined)
    throw new Error('끝나지 않은 실행은 먼저 봉인해야 재개할 수 있습니다.');

  const trimmedRanges = events.flatMap((event) =>
    event.type === 'context_trim' ? [[event.payload.fromSeq, event.payload.toSeq] as const] : [],
  );
  // 마지막 압축 요약 파일을 읽지 못하면 이전 압축으로, 그것도 없으면 원본 메시지 전체로 컨텍스트를 만든다.
  const missing: string[] = [];
  let compaction: EventOf<'compaction'> | undefined;
  let summaryText: string | undefined;
  for (const candidate of events
    .filter(
      (event): event is EventOf<'compaction'> =>
        event.type === 'compaction' && event.payload.path !== undefined,
    )
    .reverse()) {
    const path = candidate.payload.path ?? '';
    summaryText = readSummary(path);
    if (summaryText !== undefined) {
      compaction = candidate;
      break;
    }
    missing.push(path);
  }
  let messages = events.flatMap((event) =>
    event.type === 'message' &&
    event.seq > (compaction?.payload.toSeq ?? 0) &&
    !trimmedRanges.some(([from, to]) => event.seq >= from && event.seq <= to)
      ? [{ seq: event.seq, role: event.payload.role, content: event.payload.content }]
      : [],
  );

  let trim: ContextTrim | undefined;
  let repair: ContentBlock[] = [];
  const tail = messages.findLast((message) => message.role === 'assistant');
  const calls = tail?.content.flatMap((block) => (block.type === 'tool_use' ? [block] : [])) ?? [];
  if (tail !== undefined && calls.length > 0) {
    const results = new Map<string, EventOf<'tool_result'>['payload']>();
    for (const event of events) {
      if (event.seq > tail.seq && event.type === 'tool_result') {
        results.set(event.payload.callId, event.payload);
      }
    }
    const statuses = calls.map((call) => results.get(call.callId)?.status ?? 'aborted');
    if (statuses.every((status) => status !== 'ok')) {
      const toSeq = events.findLast(
        (event) => event.seq >= tail.seq && BATCH_EVENT_TYPES.includes(event.type),
      )?.seq;
      trim = {
        fromSeq: tail.seq,
        toSeq: toSeq ?? tail.seq,
        reason: statuses.includes('aborted') ? 'aborted_batch' : 'failed_batch',
      };
      messages = messages.filter((message) => message.seq < tail.seq);
    } else if (!messages.some((message) => message.seq > tail.seq && message.role === 'user')) {
      repair = calls.map((call) => {
        const result = results.get(call.callId);
        return {
          type: 'tool_result',
          callId: call.callId,
          text: result?.summary ?? '실행하지 않았습니다.',
          isError: result?.status !== 'ok',
        };
      });
    }
  }

  const history: ModelMessage[] = [];
  const historySeqs: number[] = [];
  if (compaction !== undefined && summaryText !== undefined) {
    history.push(summaryMessage(summaryText));
    historySeqs.push(compaction.payload.fromSeq);
  }
  for (const message of messages) {
    const before = history.length;
    appendMessage(history, message);
    if (history.length > before) historySeqs.push(message.seq);
    else historySeqs[historySeqs.length - 1] = message.seq;
  }
  // 가지치기와 shake는 원본 메시지에 같은 순서로 다시 적용한다. 요약이 대신한 메시지는 이미 없으므로 남은 메시지에만 닿는다.
  const firstEligible = compaction === undefined ? 0 : 1;
  for (const event of events) {
    if (event.type !== 'compaction') continue;
    if (event.payload.method === 'prune') applyPrune(history, new Set(event.payload.prunedCallIds));
    if (event.payload.method === 'shake') {
      shakeMessages(history, historySeqs, event.payload.toSeq, firstEligible);
    }
  }

  const toolOf = new Map<string, string>();
  const lastResult = new Map<string, { status: string; summary: string }>();
  // 새 기록은 `instructions` 필드가 지시 원문이다. 그 필드가 없는 옛 기록은 사용자가 쓴 메시지 전체를 지시로 읽는다.
  const hasInstructionField = events.some(
    (event) => event.type === 'message' && event.payload.instructions !== undefined,
  );
  const instructions: string[] = [];
  for (const event of events) {
    if (event.type === 'tool_call') toolOf.set(event.payload.callId, event.payload.tool);
    if (event.type === 'tool_result') {
      lastResult.set(toolOf.get(event.payload.callId) ?? event.payload.callId, event.payload);
    }
    if (event.type !== 'message') continue;
    if (hasInstructionField) {
      instructions.push(...(event.payload.instructions ?? []));
    } else if (event.actor === 'user' && event.payload.role === 'user') {
      const text = event.payload.content.flatMap((block) =>
        block.type === 'text' ? [block.text] : [],
      );
      if (text.length > 0) instructions.push(text.join('\n'));
    }
  }
  const openErrors = [...lastResult]
    .filter(([, result]) => result.status !== 'ok')
    .map(([tool, result]) => ({ tool, summary: result.summary }));

  const state = reduceTodoState(events);
  const todos = state.todos;
  const stage = events.findLast(
    (event): event is EventOf<'stage'> =>
      event.type === 'stage' && event.payload.outcome === 'entered',
  )?.payload.stage;
  const firstUser = events.find(
    (event): event is EventOf<'message'> =>
      event.type === 'message' && event.payload.role === 'user',
  );
  const firstText = firstUser?.payload.content.find((block) => block.type === 'text');
  const resumePoint = events.findLast(
    (event): event is EventOf<'verification'> =>
      event.type === 'verification' && todos.get(event.payload.todoId)?.evidence !== undefined,
  );

  return {
    task: firstText?.type === 'text' ? firstText.text : '',
    fromStatus: lastEnd.payload.status,
    hardKilled: lastEnd.payload.status === 'crashed',
    stage: stage ?? 'understand',
    todos: [...todos.values()],
    objective: state.objective,
    phases: state.phases,
    ...(state.current === undefined ? {} : { current: state.current }),
    history,
    ...(trim === undefined ? {} : { trim }),
    repair,
    ...(resumePoint === undefined ? {} : { resumePointTodoId: resumePoint.payload.todoId }),
    lastSeq: events.at(-1)?.seq ?? 0,
    historySeqs,
    instructions,
    openErrors,
    hasSummary: compaction !== undefined,
    modelUsage: events.flatMap((event) =>
      event.type === 'model_request'
        ? [{ model: event.payload.model, usage: event.payload.usage }]
        : [],
    ),
    costWarned: events.some(
      (event) => event.type === 'cost_guard' && event.payload.outcome === 'warn',
    ),
    ...(missing.length === 0
      ? {}
      : {
          summaryFallback: {
            missing,
            ...(compaction === undefined ? {} : { usedPath: compaction.payload.path }),
          },
        }),
  };
}
