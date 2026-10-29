import type { OraEvent, SessionStatus } from '@ora/protocol';

export interface CostStop {
  /** `limit`은 상한에 닿은 경우, `pricing_missing`은 상한을 설정했지만 모델 단가가 없는 경우입니다. */
  reason: 'limit' | 'pricing_missing';
  model?: string;
  isLearnSkipped: boolean;
}

export interface CostView {
  /** 상한을 설정한 세션에서 마지막 모델 요청까지 쓴 양이 상한의 몇 %인지입니다. 상한이 없으면 없습니다. */
  ratioPct?: number;
  /** 경고 비율에 한 번이라도 닿았는지입니다. */
  isWarned: boolean;
  stop?: CostStop;
}

/** 세션 이벤트에서 비용 상한 표시에 필요한 값을 읽습니다. 금액은 이벤트에 없고 비율만 있습니다. */
export function getCostView(events: readonly OraEvent[], status: SessionStatus): CostView {
  const ratioPct = events.findLast(
    (event) => event.type === 'model_request' && event.payload.costRatioPct !== undefined,
  );
  const view: CostView = {
    isWarned: events.some(
      (event) => event.type === 'cost_guard' && event.payload.outcome === 'warn',
    ),
  };
  if (ratioPct?.type === 'model_request' && ratioPct.payload.costRatioPct !== undefined) {
    view.ratioPct = ratioPct.payload.costRatioPct;
  }
  const end = events.findLast((event) => event.type === 'session_end');
  if (status !== 'stopped' || end?.payload.endReason !== 'cost_limit') return view;
  const guard = events.findLast(
    (event) =>
      event.type === 'cost_guard' &&
      (event.payload.outcome === 'limit' || event.payload.outcome === 'pricing_missing'),
  );
  const isMissing = guard?.type === 'cost_guard' && guard.payload.outcome === 'pricing_missing';
  if (guard?.type === 'cost_guard' && guard.payload.outcome === 'limit') {
    view.ratioPct = guard.payload.ratioPct;
  }
  view.stop = {
    reason: isMissing ? 'pricing_missing' : 'limit',
    ...(guard?.type === 'cost_guard' && guard.payload.outcome === 'pricing_missing'
      ? { model: guard.payload.model }
      : {}),
    isLearnSkipped: events.some((event) => event.type === 'memory'),
  };
  return view;
}

export function formatCostRatio(pct: number): string {
  return pct === 0 ? '1% 미만' : `${pct}%`;
}
