import type { OraEvent, SessionRecord, Todo } from '@ora/protocol';

/** 사이드바 세션 행입니다. 둘째 줄은 `record.status`의 글자에 detail(검증 진행, 경과 시간)을 덧붙여 만듭니다. */
export interface SessionNode {
  record: SessionRecord;
  detail?: string;
  todoTitles: string[];
}

/** 워크트리 행입니다. stack은 이 워크트리 위에 쌓은 자식 워크트리입니다(SPEC 2.12.1절). */
export interface WorktreeNode {
  name: string;
  add: number;
  del: number;
  sessions: SessionNode[];
  stack: WorktreeNode[];
}

export interface RepoNode {
  name: string;
  worktrees: WorktreeNode[];
}

export interface SidebarData {
  repos: RepoNode[];
  deviceName: string;
}

/** 워크트리별 새 세션 화면이 보여 주는 고정 맥락입니다. */
export interface WorktreeContext {
  path: string;
  branch: string;
  add: number;
  del: number;
}

export interface PendingApproval {
  callId: string;
  risk: string;
  explanation: string;
}

/** 세션 화면 하나를 그리는 데 필요한 데이터입니다. 서버 응답으로 바꿀 때 이 모양을 채웁니다. */
export interface SessionView {
  record: SessionRecord;
  events: OraEvent[];
  todos: Todo[];
  repoLabel: string;
  diff: { add: number; del: number } | null;
  statusLine: string[];
  placeholder?: string;
  approval?: PendingApproval;
  initialSearch?: { query: string };
  /** 사용자가 이미 고른 답입니다. 질문마다 고른 선택지 번호이고, current는 보고 있는 질문 번호입니다. */
  questionDraft?: { current: number; picks: number[][] };
}

/** 화면이 엔진에 요청하는 동작입니다. 작업 C에서 서버 호출로 구현합니다. */
export interface OraActions {
  sendMessage: (text: string) => Promise<void>;
  cancelRun: () => Promise<void>;
  decideApproval: (
    callId: string,
    decision: 'approved' | 'denied',
    options?: { scope?: 'once' | 'session'; editedCommand?: string },
  ) => Promise<void>;
  answerQuestions: (callId: string, answers: { picks: number[]; text: string }[]) => Promise<void>;
  resumeSession: (sessionId: string) => Promise<void>;
}

/**
 * 앱이 하나의 Provider로 받는 저장소 인터페이스입니다. 데이터 읽기와 엔진 요청을 함께 담습니다.
 * 고정 예시 데이터 구현과 서버 응답 구현이 모두 이 모양을 채웁니다.
 */
export interface OraStore {
  sidebar: SidebarData;
  newSession: WorktreeContext;
  empty: { repos: string[]; branches: string[] };
  /** 경로에 세션 ID가 없을 때 여는 세션입니다. 세션이 없으면 undefined입니다. */
  defaultSessionId: string | undefined;
  getSession: (sessionId: string) => SessionView | undefined;
  actions: OraActions;
}
