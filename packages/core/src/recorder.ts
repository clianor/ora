import { oraEventSchema } from '@ora/protocol';
import type { Actor, OraEvent } from '@ora/protocol';
import type { TranscriptSink } from './ports/transcript-sink.ts';
import type { Clock } from './ports/system.ts';
import { scrubValue } from './scrub.ts';
import type { ScrubHits } from './scrub.ts';
import { formatKst } from './time.ts';

export type EventDraft = OraEvent extends infer E
  ? E extends OraEvent
    ? Omit<E, 'seq' | 'ts' | 'sessionId' | 'actor' | 'stepId'>
    : never
  : never;

export interface Recorder {
  emit(actor: Actor, draft: EventDraft, stepId?: string): Promise<void>;
  /** 이벤트 필드에서 마스킹한 패턴별 횟수의 누적이다. */
  scrubbedHits(): Readonly<ScrubHits>;
  /** 마지막으로 붙인 seq다. */
  lastSeq(): number;
}

/** seq는 `lastSeq` 다음 번호부터 호출 순서대로 붙이고, 디스크 쓰기는 한 번에 하나씩 이어서 한다. 쓰기 전에 모든 문자열을 스크럽한다. */
export function createRecorder(
  sessionId: string,
  sink: TranscriptSink,
  clock: Clock,
  lastSeq = 0,
): Recorder {
  let seq = lastSeq;
  let tail: Promise<void> = Promise.resolve();
  const hits: ScrubHits = {};
  return {
    emit(actor, draft, stepId) {
      seq += 1;
      const envelope = {
        ...draft,
        seq,
        ts: formatKst(clock.now()),
        sessionId,
        actor,
        ...(stepId === undefined ? {} : { stepId }),
      };
      tail = tail.then(() => sink.append(oraEventSchema.parse(scrubValue(envelope, hits))));
      return tail;
    },
    scrubbedHits: () => hits,
    lastSeq: () => seq,
  };
}
