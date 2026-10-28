import { z } from 'zod';

/** 설정 `accountPolicies`의 항목이다. 정책이 없는 계정은 우선순위 0이고 예비 한도는 `retry.usageReservePct`다. */
export const accountPolicySchema = z.strictObject({
  provider: z.enum(['claude', 'codex', 'grok']),
  account: z.string().min(1),
  /** 클수록 먼저 쓴다. */
  priority: z.number().default(0),
  /** 남은 사용량이 이 비율(%) 아래로 내려가면 그 계정을 예비로 둔다. */
  reservePct: z.number().min(0).max(100).optional(),
  /** 낮은 우선순위 계정에 고정한 세션은, 이 계정의 남은 사용량이 이 비율(%)을 넘으면 다음 요청에서 이 계정으로 돌아온다. */
  reclaimAbovePct: z.number().min(0).max(100).optional(),
});
export type AccountPolicy = z.infer<typeof accountPolicySchema>;

export interface Candidate {
  readonly name: string;
  /** 로그인한 차례다. 같은 우선순위에서는 작은 쪽이 먼저다. */
  readonly index: number;
  readonly priority: number;
  readonly reservePct: number;
  readonly reclaimAbovePct?: number;
  /** 읽지 못했으면 없다. */
  readonly remainingPct?: number;
  readonly blocked: boolean;
}

const isInReserve = (c: Candidate) => c.remainingPct !== undefined && c.remainingPct < c.reservePct;
const isUsable = (c: Candidate) => !c.blocked && !isInReserve(c);
/** 남은 사용량을 읽은 계정이 먼저이고, 그다음 우선순위, 그다음 로그인 차례다. */
const byRank = (a: Candidate, b: Candidate) =>
  Number(b.remainingPct !== undefined) - Number(a.remainingPct !== undefined) ||
  b.priority - a.priority ||
  a.index - b.index;

/**
 * 요청 하나를 보낼 계정 순서다. 앞 계정이 실패하면(한도, 갱신 실패) 다음 계정을 쓴다.
 * 차단된 계정은 빼고, 예비 한도에 든 계정은 맨 뒤에 둔다. `pinned`가 있으면 그 계정에 머물되,
 * 예비 한도에 들었고 예비 밖 계정이 있으면 옮기며, 우선순위가 더 높은 계정이 `reclaimAbovePct`를 넘게 회복하면 돌아간다.
 */
export function orderCandidates(candidates: readonly Candidate[], pinned?: string): Candidate[] {
  const live = candidates.filter((c) => !c.blocked);
  const ranked = [
    ...live.filter(isUsable).toSorted(byRank),
    ...live.filter(isInReserve).toSorted(byRank),
  ];
  const pin = live.find((c) => c.name === pinned);
  if (pin === undefined) return ranked;
  let first = pin;
  const best = ranked[0];
  if (!isUsable(pin)) {
    if (best !== undefined && isUsable(best)) first = best;
  } else {
    first =
      ranked.find(
        (c) =>
          isUsable(c) &&
          c.priority > pin.priority &&
          c.reclaimAbovePct !== undefined &&
          c.remainingPct !== undefined &&
          c.remainingPct > c.reclaimAbovePct,
      ) ?? pin;
  }
  return [first, ...ranked.filter((c) => c !== first)];
}
