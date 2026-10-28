import type {
  ApprovalDecision,
  ApprovalRule,
  ApprovalRequest,
  QuestionAnswer,
  QuestionRequest,
} from '@ora/protocol';

/** 사용자가 응답할 때까지 시간 제한 없이 기다린다. 호출자가 `signal`을 취소하면 구현체가 요청을 거부로 끝낸다. */
export interface ApprovalPort {
  request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
}

/** `ask_user`의 답을 기다린다. 호출자가 `signal`을 취소하면 구현체가 예외를 던진다. */
export interface QuestionPort {
  ask(request: QuestionRequest, signal: AbortSignal): Promise<QuestionAnswer[]>;
}

/** "항상 승인"을 세션 밖에 저장한다. 호스트가 `<oraHome>/permissions.json`으로 구현한다. */
export interface AlwaysApprovalPort {
  has(rule: ApprovalRule): Promise<boolean>;
  /** 저장하지 못해도 던지지 않고 이유를 돌려준다. 호출자가 이번 승인은 그대로 적용한다. */
  add(rule: ApprovalRule): Promise<{ saved: true } | { saved: false; reason: string }>;
}
