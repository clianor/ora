import type {
  AccountProvider,
  ApprovalDecision,
  CostSettings,
  McpServerAddBody,
  McpServerStatus,
  SkillListResponse,
  MemoryListResponse,
  LoginState,
  OraEvent,
  PendingApproval,
  PendingQuestion,
  ProviderAccounts,
  ChangesResponse,
  QuestionAnswer,
  RoutingResponse,
  SessionRecord,
  Terminal,
  WorktreeTabs,
  Todo,
} from '@ora/protocol';
import type { ThreadData } from './events.ts';
import type { CacheView } from './lib/cache.ts';
import type { ContextView } from './lib/context.ts';

/** 체인 한 항목입니다. 로그인한 계정이 없으면 hasAccount가 false입니다. */
export type RoutingModel = RoutingResponse['roles'][string][number];
export type Effort = NonNullable<RoutingModel['effort']>;

/** 새 세션 화면의 라우팅 미리보기에 쓰는 데이터입니다. others는 체인 밖의 카탈로그 모델입니다. */
export interface RoutingData {
  chain: RoutingModel[];
  others: RoutingModel[];
}

/** 상태 표시줄 항목입니다. 경고 항목은 색과 함께 글자로 알립니다. */
export type StatusItem = string | { text: string; isWarning: true };

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
  /** name이 폴더 이름만 보여 줄 때의 전체 경로입니다. */
  title?: string;
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
  /** repoLabel이 폴더 이름만 보여 줄 때의 전체 경로입니다. 툴팁과 스크린리더에 씁니다. */
  repoTitle?: string;
  diff: { add: number; del: number } | null;
  statusLine: StatusItem[];
  /** 프롬프트 캐시 적중 정보입니다. 계산할 수 없으면 null이고 상태 표시줄에서 숨깁니다. */
  cache: CacheView | null;
  /** 컨텍스트 사용 정보입니다. 창 크기를 모르거나 스텝 요청이 없으면 null이고 상태 표시줄에서 숨깁니다. */
  context: ContextView | null;
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

interface TerminalSize {
  cols: number;
  rows: number;
}

interface TerminalHandlers {
  onOutput: (bytes: Uint8Array) => void;
  onExit: (exitCode: number) => void;
  /** 서버가 스트림을 다시 이으면 버퍼를 처음부터 다시 보내므로, 화면을 비우라는 신호입니다. */
  onReset: () => void;
}

/** 화면이 엔진에 요청하는 동작입니다. */
export interface OraActions {
  /** 새 세션을 만들고 세션 ID를 돌려줍니다. cwd가 없으면 서버의 기본 작업 폴더를 씁니다. model은 `<프로바이더>/<모델>[:<추론 강도>]`이고 체인 맨 앞에 들어갑니다. */
  createSession: (task: string, cwd?: string, model?: string) => Promise<string>;
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
  /** 할 일을 포기합니다. 서버가 요청을 받으면 true입니다. 실행 중인 세션은 지금 스텝이 끝난 뒤에 반영합니다. */
  abandonTodo: (sessionId: string, todoId: string) => Promise<boolean>;
  /** 포기한 할 일을 대기 상태로 되돌립니다. 받아들이는 시점은 `abandonTodo`와 같습니다. */
  restoreTodo: (sessionId: string, todoId: string) => Promise<boolean>;
  /** 압축 요약 파일의 본문을 서버에서 읽습니다. `path`는 이벤트가 가리킨 세션 디렉터리 기준 경로입니다. */
  readCompaction: (sessionId: string, path: string) => Promise<string>;
  /** 계정 목록과 진행 중인 로그인을 서버에서 다시 읽습니다. */
  refreshAccounts: () => Promise<void>;
  /** 로그인을 시작하고 서버가 돌려준 상태(로그인 주소나 디바이스 코드)를 줍니다. 실패하면 거부합니다. */
  startLogin: (provider: AccountProvider) => Promise<LoginState>;
  cancelLogin: (provider: AccountProvider) => Promise<void>;
  /** 환경변수 이름만 보냅니다. 키 값은 화면도 서버 응답도 다루지 않습니다. */
  addApiKey: (provider: AccountProvider, envName: string) => Promise<void>;
  logoutAccount: (provider: AccountProvider, name: string) => Promise<void>;
  setAccountPriority: (provider: AccountProvider, name: string, priority: number) => Promise<void>;
  /** 설정 파일의 비용 상한과 단가를 서버에서 다시 읽습니다. */
  refreshCostSettings: () => Promise<void>;
  /** 비용 상한과 단가를 설정 파일에 씁니다. 서버가 형식을 거부하면 거부합니다. 다음에 시작하거나 이어 가는 세션부터 적용합니다. */
  saveCostSettings: (next: CostSettings) => Promise<void>;
  /** MCP 서버 목록과 상태를 서버에서 다시 읽습니다. */
  refreshMcpServers: () => Promise<void>;
  /** 스킬 목록과 최근 회상을 서버에서 다시 읽습니다. `cwd`가 있으면 그 워크트리의 프로젝트 스킬도 읽습니다. */
  refreshSkills: (cwd?: string) => Promise<void>;
  /** 메모리 목록과 마지막 전체 패스를 서버에서 다시 읽습니다. `cwd`가 있으면 그 워크트리의 프로젝트 메모리도 읽습니다. */
  refreshMemory: (cwd?: string) => Promise<void>;
  /** 메모리 하나를 지웁니다. 서버가 아카이브로 옮깁니다. 없는 항목이면 거부합니다. */
  deleteMemory: (id: string) => Promise<void>;
  /** 지금 메모리를 다듬습니다. 서버가 실행 중이라고 거부하면 그 이유로 거부합니다. */
  tidyMemory: () => Promise<void>;
  /** 서버를 설정에 더하고 연결합니다. 환경변수는 이름만 보냅니다. 서버가 거부하면 거부합니다. */
  addMcpServer: (body: McpServerAddBody) => Promise<void>;
  /** 서버를 켜거나 끕니다. 끄면 연결을 닫습니다. */
  setMcpServerEnabled: (name: string, enabled: boolean) => Promise<void>;
  removeMcpServer: (name: string) => Promise<void>;
  /** 응답 없는 서버에 다시 연결하고, 끝나면 새 상태를 읽습니다. */
  reconnectMcpServer: (name: string) => Promise<void>;
  dismissError: (sessionId: string) => void;
  /** 워크트리의 탭 목록과 그 워크트리의 터미널 목록을 서버에서 읽어 저장소에 채웁니다. */
  loadTabs: (cwd: string) => Promise<void>;
  /** 워크트리에서 바뀐 파일 목록을 서버에서 읽어 저장소에 채웁니다. */
  loadChanges: (cwd: string) => Promise<void>;
  /** 탭 목록을 저장소에 먼저 반영하고 서버 파일에 씁니다. */
  saveTabs: (cwd: string, tabs: WorktreeTabs) => Promise<void>;
  /** 워크트리 폴더에서 셸을 열고 터미널 ID를 돌려줍니다. */
  createTerminal: (cwd: string, size: TerminalSize) => Promise<string>;
  killTerminal: (terminalId: string) => Promise<void>;
  sendTerminalInput: (terminalId: string, data: string) => Promise<void>;
  resizeTerminal: (terminalId: string, size: TerminalSize) => Promise<void>;
  /** 터미널 출력 스트림을 구독합니다. 돌려주는 함수로 멈춥니다. */
  watchTerminal: (terminalId: string, handlers: TerminalHandlers) => () => void;
}

/** 설정 › 계정 페이지가 그리는 데이터입니다. */
export interface AccountsData {
  status: 'loading' | 'ready' | 'error';
  errorMessage?: string;
  providers: ProviderAccounts[];
}

/** 설정 › 비용 상한 페이지가 그리는 데이터입니다. */
export interface CostSettingsData {
  status: 'loading' | 'ready' | 'error';
  errorMessage?: string;
  settings?: CostSettings;
}

/** 설정 › MCP 페이지가 그리는 데이터입니다. */
export interface McpServersData {
  status: 'loading' | 'ready' | 'error';
  errorMessage?: string;
  servers: McpServerStatus[];
}

/** 설정 › 스킬 페이지가 그리는 데이터입니다. */
export interface SkillsData {
  status: 'loading' | 'ready' | 'error';
  errorMessage?: string;
  list?: SkillListResponse;
}

/** 설정 › 메모리 페이지와 대화의 저장 줄이 그리는 데이터입니다. */
export interface MemoryData {
  status: 'loading' | 'ready' | 'error';
  errorMessage?: string;
  list?: MemoryListResponse;
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
  /** 서버의 라우팅 정보입니다. 읽지 못했으면 null이고 새 세션 화면은 모델 고르기를 숨깁니다. */
  routing: RoutingData | null;
  /** 경로에 세션 ID가 없을 때 여는 세션입니다. 세션이 없으면 undefined입니다. */
  defaultSessionId: string | undefined;
  /** 탭 목록입니다. `loadTabs`가 끝나기 전에는 undefined입니다. */
  getTabs: (cwd: string) => WorktreeTabs | undefined;
  /** `loadTabs`가 읽은 터미널입니다. 서버가 다시 떠서 사라진 터미널은 undefined입니다. */
  getTerminal: (terminalId: string) => Terminal | undefined;
  /** 워크트리의 브랜치입니다. 목록을 읽을 때와 `loadTabs`가 서버에서 읽어 채웁니다. git 저장소가 아니거나 detached HEAD면 undefined입니다. */
  getBranch: (cwd: string) => string | undefined;
  /** 서버가 알려 준 저장소의 기본 브랜치입니다. 찾지 못했으면 undefined입니다. */
  getDefaultBranch: (cwd: string) => string | undefined;
  /** `loadChanges`가 읽은 변경 목록입니다. 읽기 전에는 undefined입니다. */
  getChanges: (cwd: string) => ChangesResponse | undefined;
  /** 작업 폴더가 없는 옛 세션입니다. 사이드바에는 없고 기록 화면에만 보입니다. */
  sessionsWithoutFolder: SessionNode[];
  getSession: (sessionId: string) => SessionView | undefined;
  /** 세션의 실시간 이벤트를 받기 시작합니다. 돌려주는 함수로 멈춥니다. */
  watchSession: (sessionId: string) => () => void;
  actions: OraActions;
  accounts: AccountsData;
  costSettings: CostSettingsData;
  mcpServers: McpServersData;
  skills: SkillsData;
  memory: MemoryData;
}

export interface OraStoreSource {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => OraStore;
}
