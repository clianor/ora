import type { OraEvent, SessionRecord } from '@ora/protocol';
import type { Effort, RoutingModel, StatusItem } from '../model.ts';

export interface ModelState {
  model?: string;
  effort?: Effort;
  /** 0부터 시작하는 체인 위치입니다. */
  position: number;
  chainLength: number;
  fallbackCount: number;
}

/**
 * 세션이 지금 쓰는 모델과 체인 위치, 폴백 횟수를 이벤트와 세션 기록에서 읽습니다.
 * chain은 `GET /api/routing`의 default 체인입니다. 사용자가 고른 모델이 체인에 없으면 체인 길이에 더합니다.
 */
export function getModelState(
  events: readonly OraEvent[],
  record: SessionRecord,
  chain: readonly RoutingModel[] = [],
): ModelState {
  const requests = events.filter(
    (event) =>
      event.type === 'model_request' &&
      event.payload.purpose === undefined &&
      (event.payload.role ?? 'default') === 'default',
  );
  const last = requests.at(-1);
  const used = record.models.filter((entry) => entry.role === 'default');
  const model = last?.type === 'model_request' ? last.payload.model : used.at(0)?.model;
  const position = last?.type === 'model_request' ? last.payload.chainPosition : 0;
  const entry = used.findLast((item) => item.model === model);
  const picked = used.find((item) => item.source === 'user');
  const isOutsideChain =
    picked !== undefined &&
    !chain.some((item) => item.provider === picked.provider && item.model === picked.model);
  return {
    model,
    effort: entry?.effort,
    position,
    chainLength: Math.max(
      chain.length + (isOutsideChain ? 1 : 0),
      position + 1,
      ...used.map((item) => item.chainPosition + 1),
    ),
    fallbackCount: events.filter(
      (event) => event.type === 'retry' && event.payload.reason !== 'revert',
    ).length,
  };
}

/** 상태 표시줄의 모델 칸입니다. 폴백이 한 번이라도 있었으면 "폴백 K회"를 경고로 더합니다. */
export function buildModelItems(state: ModelState): StatusItem[] {
  if (state.model === undefined) return [];
  return [
    `${state.model} · 체인 ${state.position + 1}/${state.chainLength}`,
    ...(state.fallbackCount > 0
      ? [{ text: `폴백 ${state.fallbackCount}회`, isWarning: true as const }]
      : []),
  ];
}
