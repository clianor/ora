import type { EndReason, PermissionMode, SessionStatus, Todo } from '@ora/protocol';
import type { ApprovalPort } from './approval.ts';

/** 에이전트 정의 하나다 (SPEC 2.15.1절). `tools`는 도구 이름, `tier:read` 같은 티어, `*`(모든 도구)를 적는다. */
export interface AgentDefinition {
  readonly name: string;
  readonly description: string;
  readonly tools: readonly string[];
  readonly role: string;
  readonly maxSteps: number;
  /** 하위 세션의 시스템 프롬프트에 덧붙인다. */
  readonly body: string;
  readonly scope: 'project' | 'global' | 'builtin';
  /** 정의 파일의 실제 경로다. 기본 제공 정의에는 없다. */
  readonly path?: string;
}

export interface DelegateBrief {
  readonly goal: string;
  readonly writeScope: readonly string[];
  readonly verifyCommand?: string;
  readonly stopCondition: string;
}

export interface DelegateRequest {
  readonly callId: string;
  readonly agent: string;
  readonly intent: string;
  readonly brief: DelegateBrief;
  readonly parentSessionId: string;
  readonly permissionMode: PermissionMode;
  /** 부모가 쓸 수 있는 도구 이름이다. 하위 세션의 도구는 이 목록과 정의의 허용 목록의 교집합이다. */
  readonly parentToolNames: readonly string[];
  /** 부모의 위임 깊이다. 최상위 세션은 0이다. */
  readonly depth: number;
  readonly cwd: string;
  /** 부모와 하위 세션이 함께 더하는 비용 합계다. 모든 모델 요청이 이 합계로 상한을 확인한다. */
  readonly ledger: { spent: number };
  readonly signal: AbortSignal;
  readonly softStop: AbortSignal;
  /** 부모 세션의 승인 포트다. 하위 세션의 승인 요청이 이 포트로 올라간다. */
  readonly approval?: ApprovalPort;
  /** 하위 세션을 만든 직후, 첫 모델 요청 전에 부른다. */
  readonly onStart: (info: {
    readonly sessionId: string;
    readonly tools: readonly string[];
    readonly maxSteps: number;
  }) => Promise<void>;
}

export type DelegateOutcome =
  | {
      readonly sessionId: string;
      readonly status: SessionStatus;
      readonly endReason: EndReason;
      readonly summary: string;
      readonly todos: readonly Todo[];
      /** 하위 세션이 쓴 비용이다. 단위는 `pricing`과 같다. */
      readonly cost: number;
      /** 이 하위 세션의 파일 도구 호출만 센 바꾼 파일, 모델 요청 수, 더하고 지운 줄 수다. 셸이 바꾼 파일은 세지 않는다. */
      readonly changedFiles: readonly string[];
      readonly steps: number;
      readonly added: number;
      readonly deleted: number;
    }
  | { readonly error: string };

/** 하위 세션을 만들고 끝날 때까지 돌린다. 구현은 호스트가 넣는다. */
export interface DelegatePort {
  run(request: DelegateRequest): Promise<DelegateOutcome>;
}
