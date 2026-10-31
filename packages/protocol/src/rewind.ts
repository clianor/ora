import { z } from 'zod';
import { sessionIdSchema, timestampSchema } from './common.ts';
import type { EventOf, OraEvent } from './event.ts';

/** 되돌리기로 가려지는 이벤트 유형이다. 비용 기록, 실행 시작·끝, 되돌리기 이벤트는 가리지 않는다. */
const REWOUND_EVENT_TYPES = new Set<OraEvent['type']>([
  'stage',
  'message',
  'memory_saved',
  'review',
  'recall',
  'mcp_server',
  'intent',
  'tool_call',
  'tool_result',
  'permission',
  'approval_request',
  'question',
  'answer',
  'delegate_start',
  'delegate_end',
  'todo_update',
  'objective',
  'phase',
  'verification',
  'compaction',
  'context_trim',
]);

interface RewindScan {
  scanned: number;
  rewinds: EventOf<'rewind'>[];
  undone: Set<number>;
}

/** 이벤트 배열마다 이미 훑은 길이를 기억한다. 배열 끝에 이벤트가 붙으면 새로 붙은 부분만 훑는다. */
const scans = new WeakMap<readonly OraEvent[], RewindScan>();

/** 취소하지 않은 되돌리기가 가리는 seq 범위다. */
function listRewoundRanges(events: readonly OraEvent[]): (readonly [number, number])[] {
  let scan = scans.get(events);
  if (scan === undefined || scan.scanned > events.length) {
    scan = { scanned: 0, rewinds: [], undone: new Set() };
    scans.set(events, scan);
  }
  for (; scan.scanned < events.length; scan.scanned += 1) {
    const event = events[scan.scanned];
    if (event?.type === 'rewind') scan.rewinds.push(event);
    else if (event?.type === 'rewind_undo') scan.undone.add(event.payload.rewindSeq);
  }
  const { undone } = scan;
  return scan.rewinds.flatMap((event) =>
    undone.has(event.seq) ? [] : [[event.payload.fromSeq, event.payload.toSeq] as const],
  );
}

/** 되돌리기가 가린 이벤트를 뺀다. 되돌린 기록이 없으면 받은 배열을 그대로 돌려준다. */
export function dropRewoundEvents(events: readonly OraEvent[]): readonly OraEvent[] {
  const ranges = listRewoundRanges(events);
  if (ranges.length === 0) return events;
  return events.filter(
    (event) =>
      !REWOUND_EVENT_TYPES.has(event.type) ||
      !ranges.some(([from, to]) => event.seq >= from && event.seq <= to),
  );
}

/** 마지막 되돌리기가 아직 취소할 수 있으면 그 이벤트다. 취소했거나 그 뒤에 메시지를 보내 실행을 이어 갔으면 `undefined`다. */
export function getUndoableRewind(events: readonly OraEvent[]): EventOf<'rewind'> | undefined {
  const marker = events.findLast(
    (event) => event.type === 'rewind' || event.type === 'rewind_undo' || event.type === 'resume',
  );
  return marker?.type === 'rewind' ? marker : undefined;
}

export const rewindBodySchema = z.strictObject({ seq: z.number().int().positive() });
export type RewindBody = z.infer<typeof rewindBodySchema>;

export const editMessageBodySchema = z.strictObject({
  seq: z.number().int().positive(),
  text: z.string().min(1),
});
export type EditMessageBody = z.infer<typeof editMessageBodySchema>;

/** `GET /api/sessions/:id/rewind-preview?seq=`의 응답이다. 되돌리기 전에 바뀌는 내용을 미리 보인다 (SPEC 4.4절). 경로는 워크트리 기준 상대 경로이고, 밖의 파일은 절대 경로다. */
export const rewindPreviewSchema = z.strictObject({
  targetSeq: z.number().int().positive(),
  text: z.string(),
  /** `false`면 대화만 되돌리고 파일은 건드리지 않는다. */
  isGitRepo: z.boolean(),
  restoreFiles: z.array(z.string()),
  deleteFiles: z.array(z.string()),
  /** 세션이 마지막으로 쓴 뒤 사용자가 고친 파일이다. 되돌리면 그 수정을 덮어쓴다. */
  overwrittenFiles: z.array(z.strictObject({ path: z.string(), modifiedAt: timestampSchema })),
  /** 너무 커서 기록하지 못해 되돌리지 못하는 파일이다. */
  skippedFiles: z.array(z.string()),
  removedMessages: z.number().int().nonnegative(),
  /** 그 지점 뒤에 세션이 만든 커밋 수다. 브랜치에 그대로 남는다. */
  commitCount: z.number().int().nonnegative(),
  /** 그 지점 뒤에 같은 워크트리의 다른 세션이 바꾼 파일이다. */
  otherSessionFiles: z.array(
    z.strictObject({ sessionId: sessionIdSchema, title: z.string(), path: z.string() }),
  ),
  /** 있으면 지금은 되돌릴 수 없다. 화면이 이유를 보이고 단추를 끈다. */
  blockedReason: z.string().optional(),
});
export type RewindPreview = z.infer<typeof rewindPreviewSchema>;

export const rewindResultSchema = z.strictObject({
  /** 기록에 덧붙인 `rewind` 이벤트의 seq다. */
  eventSeq: z.number().int().positive(),
  text: z.string(),
  restoredFiles: z.array(z.string()),
  deletedFiles: z.array(z.string()),
});
export type RewindResult = z.infer<typeof rewindResultSchema>;

export const rewindUndoResponseSchema = z.strictObject({ eventSeq: z.number().int().positive() });
