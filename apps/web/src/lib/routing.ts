import type { OraEvent, SessionRecord } from '@ora/protocol';
import type { Effort } from '../model.ts';

export interface ModelState {
  model?: string;
  effort?: Effort;
}

/** 세션이 지금 쓰는 모델과 추론 강도를 이벤트와 세션 기록에서 읽습니다. 입력창 모델 칩이 이 값을 보입니다. */
export function getModelState(events: readonly OraEvent[], record: SessionRecord): ModelState {
  const last = events.findLast(
    (event) =>
      event.type === 'model_request' &&
      event.payload.purpose === undefined &&
      (event.payload.role ?? 'default') === 'default',
  );
  const used = record.models.filter((entry) => entry.role === 'default');
  const model = last?.type === 'model_request' ? last.payload.model : used.at(0)?.model;
  return { model, effort: used.findLast((item) => item.model === model)?.effort };
}
