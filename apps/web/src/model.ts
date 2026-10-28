import type {
  ApprovalDecision,
  OraEvent,
  PendingApproval,
  PendingQuestion,
  QuestionAnswer,
  SessionRecord,
  Todo,
} from '@ora/protocol';
import type { ThreadData } from './events.ts';

/** 입력창 칩에 적는 글자입니다. 서버가 주지 않는 값은 비워 두고, 비어 있으면 칩을 그리지 않습니다. */
export interface ComposerChips {
  model?: string;
  effort?: string;
  permission?: string;
}

/** 사이드바 세션 행입니다. 둘째 줄은 `record.status`의 글자에 detail(검증 진행, 경과 시간)을 덧붙여 만듭니다. */
export interface SessionNode {
  record: SessionRecord;
  detail?: string;
  todoTitles: string[];
}

/** 워크트리 행입니다. stack은 이 워크트리 위에 쌓은 자식 워크트리입니다(SPEC 2.12.1절). */
export interface WorktreeNode {
  name: string;
  /** 이 행에서 새 세션을 열 때 쓰는 작업 폴더입니다. 없으면 서버 기본 폴더입니다. */
  cwd?: string;
  add?: number;
  del?: number;
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

/** 새 세션 화면이 보여 주는 작업 폴더 맥락입니다. 서버가 주지 않는 값은 비웁니다. */
export interface WorktreeContext {
  chips?: ComposerChips;
  path?: string;
  branch?: string;
  add?: number;
  del?: number;
}

/** 세션 화면 하나를 그리는 데 필요한 데이터입니다. 저장소 구현이 이 모양을 채웁니다. */
export interface SessionView {
  record: SessionRecord;
  events: OraEvent[];
  thread: ThreadData;
  todos: Todo[];
  /** 승인을 기다리는 요청입니다. 서버가 보낸 모양 그대로입니다. */
  approvals: PendingApproval[];
  /** 답을 기다리는 `ask_user` 질문입니다. */
  questions: PendingQuestion[];
  repoLabel: string;
  diff: { add: number; del: number } | null;
  statusLine: string[];
  chips?: ComposerChips;
  placeholder?: string;
  initialSearch?: { query: string };
  /** 사용자가 이미 고른 답입니다. 질문마다 고른 선택지 번호이고, current는 보고 있는 질문 번호입니다. */
  questionDraft?: { current: number; picks: number[][] };
  /** 소프트 스톱을 보낸 뒤 세션이 멈추기를 기다리는 중입니다. 이때 한 번 더 중지하면 하드 킬입니다. */
  isStopping: boolean;
  /** 마지막으로 실패한 요청의 오류입니다. 화면이 알림으로 보여 줍니다. */
  error: string | null;
  /** 조향 메시지를 세션에 전달하지 못했을 때 돌려받은 메시지입니다. id가 바뀌면 입력창에 되살립니다. */
  steerFailure: { id: number; error: string; texts: string[] } | null;
}

/** 화면이 엔진에 요청하는 동작입니다. */
export interface OraActions {
  /** 새 세션을 만들고 세션 ID를 돌려줍니다. cwd가 없으면 서버의 기본 작업 폴더를 씁니다. */
  createSession: (task: string, cwd?: string) => Promise<string>;
  sendMessage: (sessionId: string, text: string) => Promise<void>;
  cancelRun: (sessionId: string, mode: 'soft' | 'hard') => Promise<void>;
  decideApproval: (
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
  ) => Promise<void>;
  answerQuestions: (
    sessionId: string,
    requestId: string,
    answers: QuestionAnswer[],
  ) => Promise<void>;
  resumeSession: (sessionId: string) => Promise<void>;
  dismissError: (sessionId: string) => void;
}

/**
 * 앱이 하나의 Provider로 받는 저장소의 한 시점입니다. 데이터 읽기와 엔진 요청을 함께 담습니다.
 * 고정 예시 데이터 구현과 서버 구현이 모두 이 모양을 채우고, 바뀔 때마다 새 객체를 돌려줍니다.
 */
export interface OraStore {
  status: 'loading' | 'ready' | 'error';
  errorMessage?: string;
  /** 서버 기본값(`/api/info`)을 읽지 못했을 때의 오류입니다. */
  infoError?: string;
  sidebar: SidebarData;
  getNewSessionContext: (cwd?: string) => WorktreeContext;
  empty: { repos: string[]; branches: string[]; chips?: ComposerChips };
  /** 경로에 세션 ID가 없을 때 여는 세션입니다. 세션이 없으면 undefined입니다. */
  defaultSessionId: string | undefined;
  getSession: (sessionId: string) => SessionView | undefined;
  /** 세션의 실시간 이벤트를 받기 시작합니다. 돌려주는 함수로 멈춥니다. */
  watchSession: (sessionId: string) => () => void;
  actions: OraActions;
}

export interface OraStoreSource {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => OraStore;
}
