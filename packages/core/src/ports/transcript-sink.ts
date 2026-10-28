import type { OraEvent } from '@ora/protocol';

/** 구현체는 `append`의 Promise를 끝내기 전에 이벤트를 디스크에 반영한다. */
export interface TranscriptSink {
  append(event: OraEvent): Promise<void>;
}
