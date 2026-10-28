export interface MemoryCandidate {
  readonly text: string;
  readonly source?: string;
}

export type MemoryDecision =
  | { readonly decision: 'remember'; readonly lessonId: string }
  | { readonly decision: 'refuse'; readonly reason: string }
  | { readonly decision: 'defer'; readonly reason: string }
  | { readonly decision: 'rejected'; readonly reason: string };

export interface RecallRequest {
  readonly query: string;
  readonly tokenBudget: number;
}

export interface RecallLesson {
  readonly id: string;
  readonly text: string;
}

export interface RecallPack {
  readonly lessons: readonly RecallLesson[];
  readonly tokenCount: number;
}

/** `rejected`는 한 사실이 아니라서 기록하지 않고 모델에게 쪼개 다시 내게 하는 판정이다. */
export interface MemoryPort {
  recall(request: RecallRequest): Promise<RecallPack>;
  propose(candidate: MemoryCandidate, sessionId: string): Promise<MemoryDecision>;
}
