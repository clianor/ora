import type {
  ApprovalDecision,
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
