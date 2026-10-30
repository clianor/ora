export interface MemoryCandidate {
  readonly text: string;
  readonly source?: string;
}

export type MemoryDecision =
  | { readonly decision: 'remember'; readonly lessonId: string; readonly isUnsourced: boolean }
  | { readonly decision: 'refuse'; readonly reason: string }
  | { readonly decision: 'rejected'; readonly reason: string };

export interface RecallRequest {
  readonly query: string;
  readonly tokenBudget: number;
  readonly sessionId: string;
}

export interface RecallLesson {
  readonly id: string;
  readonly text: string;
}

export interface RecallPack {
  readonly lessons: readonly RecallLesson[];
  readonly tokenCount: number;
}

export interface MaintenanceResult {
  /** 같은 사실이 겹쳐 `archivedIds`를 아카이브로 옮기고 `keptId`만 남긴 합침이다. */
  readonly merged: readonly { readonly keptId: string; readonly archivedIds: readonly string[] }[];
  /** 새 교훈과 모순이어서 아카이브로 옮긴 기존 교훈이다. */
  readonly invalidated: readonly { readonly id: string; readonly replacedBy: string }[];
}

/** 새 교훈과 같은 범위의 기존 교훈 후보의 관계를 모델이 판정한 결과다. 모델 응답 형식이 두 번 틀리면 판정 함수는 `undefined`를 돌려준다. */
export interface ConflictJudgement {
  readonly relation: 'contradicts' | 'duplicate' | 'unrelated';
  readonly confident: boolean;
  readonly targetId: string;
  readonly reason: string;
}

export type ConflictJudge = (input: {
  readonly lessonId: string;
  readonly text: string;
  readonly candidates: readonly RecallLesson[];
}) => Promise<ConflictJudgement | undefined>;

/** `rejected`는 한 사실이 아니라서 기록하지 않고 모델에게 쪼개 다시 내게 하는 판정이다. */
export interface MemoryPort {
  recall(request: RecallRequest): Promise<RecallPack>;
  propose(candidate: MemoryCandidate, sessionId: string): Promise<MemoryDecision>;
  /** 가벼운 유지보수 패스다 (SPEC 3.4절). 이 세션이 기억에 올린 교훈만 대상으로 한다. `judge`가 없으면 중복 제거만 한다. */
  maintain(judge?: ConflictJudge): Promise<MaintenanceResult>;
}
