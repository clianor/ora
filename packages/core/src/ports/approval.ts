import type { ApprovalScope, ToolTier } from '@ora/protocol';

export type RiskLevel = 'low' | 'medium' | 'high';

export type ApprovalDetail =
  | {
      readonly kind: 'shell';
      readonly command: string;
      readonly cwd: string;
      readonly risk: RiskLevel;
    }
  | { readonly kind: 'file'; readonly path: string; readonly content: string }
  | { readonly kind: 'arguments'; readonly args: Record<string, unknown> };

export interface ApprovalRequest {
  readonly callId: string;
  readonly tool: string;
  readonly tier: ToolTier;
  readonly reason: string;
  readonly detail: ApprovalDetail;
}

export type ApprovalDecision =
  | {
      readonly outcome: 'approved';
      readonly scope: ApprovalScope;
      readonly editedCommand?: string;
    }
  | { readonly outcome: 'denied'; readonly steer?: string };

/** 사용자가 응답할 때까지 시간 제한 없이 기다린다. 호출자가 `signal`을 취소하면 구현체가 요청을 거부로 끝낸다. */
export interface ApprovalPort {
  request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
}
