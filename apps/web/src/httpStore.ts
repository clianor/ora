import {
  accountListResponseSchema,
  costSettingsSchema,
  generalSettingsSchema,
  isolationSettingsResponseSchema,
  modelSettingsSchema,
  permissionRulesResponseSchema,
  permissionSettingsResponseSchema,
  mcpServerListResponseSchema,
  skillListResponseSchema,
  memoryDeleteResponseSchema,
  memoryListResponseSchema,
  memoryPassSummarySchema,
  changesResponseSchema,
  branchResponseSchema,
  accountViewSchema,
  loginStateSchema,
  approvalDecisionSchema,
  okResponseSchema,
  oraEventSchema,
  pendingApprovalSchema,
  pendingQuestionSchema,
  requestResolvedSchema,
  compactionFileResponseSchema,
  errorResponseSchema,
  infoResponseSchema,
  type InfoResponse,
  routingResponseSchema,
  sessionDetailResponseSchema,
  sessionIdResponseSchema,
  sessionListResponseSchema,
  sseEventNames,
  tabsResponseSchema,
  terminalExitEventSchema,
  terminalListResponseSchema,
  terminalOutputEventSchema,
  terminalResponseSchema,
  terminalSseEventNames,
  steerFailedSchema,
  todoActionResponseSchema,
  worktreeListResponseSchema,
  worktreeResponseSchema,
  worktreeOptionsResponseSchema,
  reposSettingsResponseSchema,
  type WorktreeRecord,
  type ApprovalDecision,
  type CostSettings,
  type McpServerStatus,
  type ChangesResponse,
  type OraEvent,
  type PendingApproval,
  type PendingQuestion,
  type QuestionAnswer,
  type SessionRecord,
  type Terminal,
  type WorktreeTabs,
  type Todo,
} from '@ora/protocol';
import type { ThreadMessageLike } from '@assistant-ui/react';
import { buildThread, reuseMessages } from './events.ts';
import { buildCacheView } from './lib/cache.ts';
import { buildContextView, type ContextLimits } from './lib/context.ts';
import { basename } from './lib/path.ts';
import { permissionLabel } from './lib/status.ts';
import { getModelState } from './lib/routing.ts';
import type {
  AccountsData,
  CostSettingsData,
  EngineSettingsData,
  McpServersData,
  SkillsData,
  MemoryData,
  OraActions,
  OraStore,
  OraStoreSource,
  RepoNode,
  RoutingData,
  StatusItem,
  WorktreeContext,
  SessionView,
  WorktreeNode,
} from './model.ts';

/** 서버가 보낸 이벤트 중 세션 상태, 대기 요청, 사이드바를 서버에서 다시 읽어야 하는 종류입니다. */
const refreshEventTypes = new Set<OraEvent['type']>([
  'session_end',
  'resume',
  'cancel',
  'recovered',
  'approval_request',
  'question',
  'permission',
  'answer',
]);

const createListRetries = 20;
const createListRetryDelayMs = 100;
const notifyDelayMs = 30;
const refreshDelayMs = 100;
const accountPollMs = 1500;

interface SessionState {
  record: SessionRecord;
  todos: Todo[];
  events: OraEvent[];
  approvals: PendingApproval[];
  questions: PendingQuestion[];
  isStopping: boolean;
  error: string | null;
  steerFailure: SessionView['steerFailure'];
  lastMessages: ThreadMessageLike[];
  maxSteps: number | undefined;
  limits: ContextLimits | undefined;
  /** SSE 연결이 한 번 끊겼다가 다시 열렸을 때 놓친 이벤트와 대기 요청을 서버에서 다시 맞추기 위한 표시입니다. */
  hadStreamError: boolean;
  watchers: number;
  source: EventSource | null;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  view: SessionView | null;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** zod 스키마처럼 `parse`로 응답을 검증하는 객체입니다. 웹은 zod를 직접 import하지 않습니다. */
interface Parser<T> {
  parse: (input: unknown) => T;
}

interface SafeParser<T> {
  safeParse: (input: unknown) => { success: true; data: T } | { success: false };
}

async function requestJson<T>(
  path: string,
  schema: Parser<T>,
  init?: { method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown },
): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'same-origin',
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = errorResponseSchema.safeParse(body);
    const reason = failure.success
      ? failure.data.error
      : `요청이 실패했습니다(${response.status}).`;
    throw new Error(
      response.status === 401
        ? '인증이 필요합니다. 터미널에 출력된 시작 주소를 다시 엽니다.'
        : reason,
    );
  }
  return schema.parse(body);
}

/**
 * 세션의 `repo` 경로마다 워크트리 행 하나를 만들고, 저장소 기준으로 묶습니다(SPEC 2.7절).
 * 사용자가 만든 worktree는 그 저장소 그룹에 넣습니다. 서버 시작 폴더는 세션이 없어도 행으로 둡니다.
 * 작업 폴더가 없는 세션은 여기에 넣지 않습니다.
 */
function buildRepos(
  records: readonly SessionRecord[],
  startCwd: string | undefined,
  worktrees: readonly WorktreeRecord[],
): RepoNode[] {
  const byPath = new Map(worktrees.map((item) => [item.path, item]));
  const folders = new Map<string, SessionRecord[]>();
  const add = (folder: string, record?: SessionRecord) => {
    folders.set(folder, [...(folders.get(folder) ?? []), ...(record ? [record] : [])]);
  };
  if (startCwd !== undefined) add(startCwd);
  for (const item of worktrees) {
    add(item.repo);
    add(item.path);
  }
  for (const record of records) {
    if (record.repo !== undefined) add(record.repo, record);
  }
  const groups = new Map<string, WorktreeNode[]>();
  for (const [folder, list] of folders) {
    const setup = byPath.get(folder);
    const node: WorktreeNode = {
      name: setup?.name ?? basename(folder),
      cwd: folder,
      title: folder,
      ...(setup === undefined ? {} : { setup }),
      sessions: list.map((record) => ({ record, todoTitles: [] })),
      stack: [],
    };
    const repo = setup?.repo ?? folder;
    groups.set(repo, [...(groups.get(repo) ?? []), node]);
  }
  return [...groups.entries()].map(([repo, nodes]) => ({
    name: basename(repo),
    path: repo,
    worktrees: nodes.toSorted((a, b) => Number(a.cwd !== repo) - Number(b.cwd !== repo)),
  }));
}

function buildStatusLine(events: readonly OraEvent[], maxSteps: number | undefined): StatusItem[] {
  const requests = events.filter((event) => event.type === 'model_request');
  const start = events.find((event) => event.type === 'session_start');
  return [
    ...(requests.length > 0
      ? [`스텝 ${requests.length}${maxSteps === undefined ? '' : `/${maxSteps}`}`]
      : []),
    ...(start ? [`격리 ${start.payload.isolation}`] : []),
  ];
}

function createSessionState(record: SessionRecord): SessionState {
  return {
    record,
    todos: [],
    events: [],
    approvals: [],
    questions: [],
    isStopping: false,
    error: null,
    steerFailure: null,
    lastMessages: [],
    maxSteps: undefined,
    limits: undefined,
    hadStreamError: false,
    watchers: 0,
    source: null,
    refreshTimer: null,
    view: null,
  };
}

/** `ora serve`의 HTTP API와 SSE에 연결한 저장소입니다. */
export function createHttpStore(): OraStoreSource {
  const sessions = new Map<string, SessionState>();
  const listeners = new Set<() => void>();
  let listLoaded: 'loading' | 'ready' | 'error' = 'loading';
  let listError: string | undefined;
  let info: InfoResponse | null = null;
  let worktrees: WorktreeRecord[] = [];
  let worktreePollTimer: ReturnType<typeof setTimeout> | null = null;
  let routing: RoutingData | null = null;
  let infoError: string | undefined;
  let snapshot: OraStore;
  let notifyTimer: ReturnType<typeof setTimeout> | null = null;
  let listRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let steerFailureCount = 0;
  let accounts: AccountsData = { status: 'loading', providers: [] };
  let accountPollTimer: ReturnType<typeof setTimeout> | null = null;
  let costSettings: CostSettingsData = { status: 'loading' };
  let engineSettings: EngineSettingsData = {
    general: { status: 'loading' },
    models: { status: 'loading' },
    permissions: { status: 'loading' },
    isolation: { status: 'loading' },
    approvalRules: { status: 'loading' },
    repos: { status: 'loading' },
  };
  let mcpPollTimer: ReturnType<typeof setTimeout> | null = null;
  let mcpServers: McpServersData = { status: 'loading', servers: [] };
  let skills: SkillsData = { status: 'loading' };
  let skillsCwd: string | undefined;
  let memory: MemoryData = { status: 'loading' };
  let memoryCwd: string | undefined;
  const tabs = new Map<string, WorktreeTabs>();
  const terminals = new Map<string, Terminal>();
  const branches = new Map<string, string>();
  const defaultBranches = new Map<string, string>();
  const changes = new Map<string, ChangesResponse>();
  const requestedBranches = new Set<string>();
  let terminalInputChain: Promise<unknown> = Promise.resolve();

  /** 워크트리의 브랜치와 저장소 기본 브랜치를 읽어 사이드바 배지에 씁니다. 읽지 못하면 폴더 이름만 보입니다. */
  const loadBranch = async (cwd: string): Promise<void> => {
    const head = await requestJson(
      `/api/branch?cwd=${encodeURIComponent(cwd)}`,
      branchResponseSchema,
    ).catch(() => undefined);
    if (head === undefined) return;
    if (head.branch !== undefined) branches.set(cwd, head.branch);
    if (head.defaultBranch !== undefined) defaultBranches.set(cwd, head.defaultBranch);
    notifySoon();
  };

  /** 아직 묻지 않은 폴더만 서버에 묻습니다. 목록을 다시 읽을 때마다 호출해도 폴더당 한 번만 요청합니다. */
  const requestBranches = (cwds: readonly string[]): void => {
    for (const cwd of cwds) {
      if (requestedBranches.has(cwd)) continue;
      requestedBranches.add(cwd);
      loadBranch(cwd).catch(() => undefined);
    }
  };

  /** 폴더를 고르지 않은 새 세션은 서버가 알려 준 기본 작업 폴더와 브랜치를 보여 줍니다. */
  function getNewSessionContext(cwd?: string): WorktreeContext {
    if (cwd !== undefined) {
      return {
        path: cwd,
        branch: branches.get(cwd),
        chips: info ? { permission: permissionLabel[info.permissionMode] } : undefined,
      };
    }
    return {
      path: info?.cwd,
      branch: info?.branch,
      chips: info ? { permission: permissionLabel[info.permissionMode] } : undefined,
    };
  }

  const getView = (state: SessionState): SessionView => {
    if (state.view) return state.view;
    const waitingCallIds = new Set([
      ...state.approvals.map((item) => item.request.callId),
      ...state.questions.map((item) => item.request.callId),
    ]);
    const built = buildThread(state.events, waitingCallIds);
    state.lastMessages = reuseMessages(state.lastMessages, built.messages);
    const modelState = getModelState(state.events, state.record);
    state.view = {
      record: state.record,
      events: state.events,
      thread: { ...built, messages: state.lastMessages },
      todos: state.todos,
      approvals: state.approvals,
      questions: state.questions,
      repoLabel: state.record.repo === undefined ? '' : basename(state.record.repo),
      repoTitle: state.record.repo,
      diff: null,
      statusLine: buildStatusLine(state.events, state.maxSteps ?? info?.maxSteps),
      cache: buildCacheView(state.events),
      context: buildContextView(state.events, state.limits),
      chips: {
        model: modelState.model,
        effort: modelState.effort,
        permission: permissionLabel[state.record.permissionMode],
      },
      isStopping: state.isStopping,
      error: state.error,
      steerFailure: state.steerFailure,
    };
    return state.view;
  };

  const rebuildSnapshot = (): void => {
    const records = [...sessions.values()]
      .map((state) => state.record)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const views = new Map<string, SessionView>();
    for (const [id, state] of sessions) views.set(id, getView(state));
    snapshot = {
      status: listLoaded,
      errorMessage: listError,
      infoError,
      sidebar: { repos: buildRepos(records, info?.cwd, worktrees), deviceName: '이 컴퓨터' },
      sessionsWithoutFolder: records
        .filter((record) => record.repo === undefined)
        .map((record) => ({ record, todoTitles: [] })),
      getBranch: (cwd) => branches.get(cwd),
      getWorktreeSetup: (cwd) => worktrees.find((item) => item.path === cwd),
      getDefaultBranch: (cwd) => defaultBranches.get(cwd),
      getChanges: (cwd) => changes.get(cwd),
      getNewSessionContext: getNewSessionContext,
      empty: { repos: [], branches: [] },
      routing,
      defaultSessionId: records[0]?.id,
      getTabs: (cwd) => tabs.get(cwd),
      getTerminal: (id) => terminals.get(id),
      getSession: (id) => views.get(id),
      watchSession,
      actions,
      accounts,
      costSettings,
      engineSettings,
      mcpServers,
      skills,
      memory,
    };
  };

  const notifyNow = (): void => {
    notifyTimer = null;
    rebuildSnapshot();
    listeners.forEach((listener) => {
      listener();
    });
  };

  /** 이벤트가 몰려 와도 화면 갱신은 한 번으로 묶습니다. */
  const notifySoon = (): void => {
    notifyTimer ??= setTimeout(notifyNow, notifyDelayMs);
  };

  const touch = (state: SessionState): void => {
    state.view = null;
    notifySoon();
  };

  const ensureState = (record: SessionRecord): SessionState => {
    const existing = sessions.get(record.id);
    if (existing) {
      if (
        existing.record.updatedAt !== record.updatedAt ||
        existing.record.status !== record.status
      ) {
        existing.record = record;
        existing.view = null;
      }
      return existing;
    }
    const created = createSessionState(record);
    sessions.set(record.id, created);
    return created;
  };

  const refreshList = async (): Promise<void> => {
    try {
      const list = await requestJson('/api/sessions', sessionListResponseSchema);
      const ids = new Set(list.sessions.map((record) => record.id));
      for (const [id, state] of sessions) {
        if (ids.has(id)) continue;
        state.source?.close();
        if (state.refreshTimer) clearTimeout(state.refreshTimer);
        sessions.delete(id);
      }
      for (const record of list.sessions) ensureState(record);
      requestBranches(
        list.sessions.flatMap((record) => (record.repo === undefined ? [] : [record.repo])),
      );
      listLoaded = 'ready';
      listError = undefined;
    } catch (error) {
      listLoaded = 'error';
      listError = toMessage(error);
    }
    notifySoon();
  };

  const scheduleListRefresh = (): void => {
    listRefreshTimer ??= setTimeout(() => {
      listRefreshTimer = null;
      refreshList().catch(() => undefined);
      refreshSkills(skillsCwd).catch(() => undefined);
      refreshMemory(memoryCwd).catch(() => undefined);
    }, refreshDelayMs);
  };

  const refreshDetail = async (id: string): Promise<void> => {
    const state = sessions.get(id);
    if (!state) return;
    try {
      const detail = await requestJson(`/api/sessions/${id}`, sessionDetailResponseSchema);
      state.record = detail.session;
      state.todos = detail.todos;
      state.approvals = detail.pendingApprovals;
      state.questions = detail.pendingQuestions;
      state.maxSteps = detail.maxSteps;
      state.limits = {
        ...(detail.contextWindow === undefined ? {} : { contextWindow: detail.contextWindow }),
        compactAtRatio: detail.compactAtRatio,
        keepRecentTokens: detail.keepRecentTokens,
      };
      if (!detail.live) state.isStopping = false;
    } catch (error) {
      state.error = toMessage(error);
    }
    touch(state);
  };

  const scheduleDetailRefresh = (id: string): void => {
    const state = sessions.get(id);
    if (!state || state.refreshTimer) return;
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      refreshDetail(id).catch(() => undefined);
    }, refreshDelayMs);
    scheduleListRefresh();
  };

  /** SSE 데이터를 JSON으로 읽고 스키마로 검증합니다. 실패하면 화면에 보이는 오류로 남기고 null을 돌려줍니다. */
  const parseSse = <T>(state: SessionState, schema: SafeParser<T>, data: string): T | null => {
    try {
      const parsed = schema.safeParse(JSON.parse(data));
      if (parsed.success) return parsed.data;
    } catch {
      // JSON이 아니어도 아래의 오류 알림으로 처리합니다.
    }
    state.error = '서버가 보낸 이벤트의 모양이 맞지 않습니다.';
    touch(state);
    return null;
  };

  const handleTranscript = (id: string, state: SessionState, data: string): void => {
    const event = parseSse(state, oraEventSchema, data);
    if (!event) return;
    if (event.seq <= (state.events.at(-1)?.seq ?? 0)) return;
    // 이벤트마다 배열을 복사하면 기록이 길수록 느려지므로 제자리에 덧붙입니다. 화면은 view를 새로 만들 때 읽습니다.
    state.events.push(event);
    if (event.type === 'todo_update') {
      const { todo } = event.payload;
      const known = state.todos.some((item) => item.id === todo.id);
      state.todos = known
        ? state.todos.map((item) => (item.id === todo.id ? todo : item))
        : [...state.todos, todo];
    }
    if (refreshEventTypes.has(event.type)) scheduleDetailRefresh(id);
    touch(state);
  };

  const openSource = (id: string, state: SessionState): void => {
    const source = new EventSource(`/api/sessions/${id}/events`);
    state.source = source;
    // 브라우저가 자동으로 다시 연결할 때는 Last-Event-ID를 보냅니다. 끊겨 있던 동안 놓친 대기 요청과 해결은 다시 읽어 맞춥니다.
    source.onerror = () => {
      state.hadStreamError = true;
      if (source.readyState !== EventSource.CLOSED || state.watchers === 0) return;
      source.close();
      openSource(id, state);
    };
    source.onopen = () => {
      if (!state.hadStreamError) return;
      state.hadStreamError = false;
      refreshDetail(id).catch(() => undefined);
    };
    source.onmessage = (message: MessageEvent<string>) => {
      handleTranscript(id, state, message.data);
    };
    source.addEventListener(sseEventNames.approvalRequest, (message: MessageEvent<string>) => {
      const parsed = parseSse(state, pendingApprovalSchema, message.data);
      if (!parsed) return;
      const { requestId } = parsed;
      state.approvals = [...state.approvals.filter((item) => item.requestId !== requestId), parsed];
      touch(state);
    });
    source.addEventListener(sseEventNames.questionRequest, (message: MessageEvent<string>) => {
      const parsed = parseSse(state, pendingQuestionSchema, message.data);
      if (!parsed) return;
      const { requestId } = parsed;
      state.questions = [...state.questions.filter((item) => item.requestId !== requestId), parsed];
      touch(state);
    });
    source.addEventListener(sseEventNames.requestResolved, (message: MessageEvent<string>) => {
      const parsed = parseSse(state, requestResolvedSchema, message.data);
      if (!parsed) return;
      const { requestId } = parsed;
      state.approvals = state.approvals.filter((item) => item.requestId !== requestId);
      state.questions = state.questions.filter((item) => item.requestId !== requestId);
      touch(state);
    });
    source.addEventListener(sseEventNames.steerFailed, (message: MessageEvent<string>) => {
      const parsed = parseSse(state, steerFailedSchema, message.data);
      if (!parsed) return;
      steerFailureCount += 1;
      state.steerFailure = { id: steerFailureCount, ...parsed };
      state.error = `조향 메시지를 전달하지 못했습니다. ${parsed.error}`;
      touch(state);
    });
  };

  function watchSession(id: string): () => void {
    const state = sessions.get(id);
    if (!state) return () => undefined;
    state.watchers += 1;
    if (state.watchers === 1) {
      openSource(id, state);
      refreshDetail(id).catch(() => undefined);
    }
    return () => {
      state.watchers -= 1;
      if (state.watchers === 0) {
        state.source?.close();
        state.source = null;
      }
    };
  }

  const fail = (id: string, error: unknown): void => {
    const state = sessions.get(id);
    if (!state) return;
    state.error = toMessage(error);
    touch(state);
  };

  const after = (id: string): void => {
    scheduleDetailRefresh(id);
  };

  /** 로그인이 진행 중인 동안에는 서버가 끝났는지 주기적으로 다시 읽습니다. */
  const refreshAccounts = async (): Promise<void> => {
    try {
      const list = await requestJson('/api/accounts', accountListResponseSchema);
      accounts = { status: 'ready', providers: list.providers };
    } catch (error) {
      accounts = { status: 'error', errorMessage: toMessage(error), providers: accounts.providers };
    }
    if (accounts.providers.some((entry) => entry.login?.status === 'pending')) {
      accountPollTimer ??= setTimeout(() => {
        accountPollTimer = null;
        refreshAccounts().catch(() => undefined);
      }, accountPollMs);
    }
    notifySoon();
  };

  const refreshCostSettings = async (): Promise<void> => {
    try {
      costSettings = {
        status: 'ready',
        settings: await requestJson('/api/cost-settings', costSettingsSchema),
      };
    } catch (error) {
      costSettings = {
        status: 'error',
        errorMessage: toMessage(error),
        ...(costSettings.settings === undefined ? {} : { settings: costSettings.settings }),
      };
    }
    notifySoon();
  };

  const engineSettingRequests = {
    general: { path: '/api/settings/general', schema: generalSettingsSchema },
    models: { path: '/api/settings/models', schema: modelSettingsSchema },
    permissions: { path: '/api/settings/permissions', schema: permissionSettingsResponseSchema },
    isolation: { path: '/api/settings/isolation', schema: isolationSettingsResponseSchema },
    approvalRules: { path: '/api/permission-rules', schema: permissionRulesResponseSchema },
    repos: { path: '/api/settings/repos', schema: reposSettingsResponseSchema },
  } as const;
  const refreshEngineSettings = async (page: keyof EngineSettingsData): Promise<void> => {
    const { path, schema } = engineSettingRequests[page];
    try {
      const value = await requestJson<unknown>(path, schema);
      engineSettings = { ...engineSettings, [page]: { status: 'ready', value } };
    } catch (error) {
      const previous = engineSettings[page].value;
      engineSettings = {
        ...engineSettings,
        [page]: {
          status: 'error',
          errorMessage: toMessage(error),
          ...(previous === undefined ? {} : { value: previous }),
        },
      };
    }
    notifySoon();
  };

  const applyMcpServers = (servers: McpServerStatus[]): void => {
    mcpServers = { status: 'ready', servers };
    // 연결 중인 서버가 있으면 끝날 때까지 상태를 다시 읽는다.
    if (servers.some((server) => server.state === 'connecting')) {
      mcpPollTimer ??= setTimeout(() => {
        mcpPollTimer = null;
        refreshMcpServers().catch(() => undefined);
      }, 1500);
    }
    notifySoon();
  };
  const refreshMcpServers = async (): Promise<void> => {
    try {
      applyMcpServers((await requestJson('/api/mcp-servers', mcpServerListResponseSchema)).servers);
    } catch (error) {
      mcpServers = { status: 'error', errorMessage: toMessage(error), servers: mcpServers.servers };
      notifySoon();
    }
  };
  const refreshSkills = async (cwd?: string): Promise<void> => {
    skillsCwd = cwd;
    const query = cwd === undefined ? '' : `?cwd=${encodeURIComponent(cwd)}`;
    try {
      skills = {
        status: 'ready',
        list: await requestJson(`/api/skills${query}`, skillListResponseSchema),
      };
    } catch (error) {
      skills = { status: 'error', errorMessage: toMessage(error) };
    }
    notifySoon();
  };
  const refreshMemory = async (cwd?: string): Promise<void> => {
    memoryCwd = cwd;
    const query = cwd === undefined ? '' : `?cwd=${encodeURIComponent(cwd)}`;
    try {
      memory = {
        status: 'ready',
        list: await requestJson(`/api/memory${query}`, memoryListResponseSchema),
      };
    } catch (error) {
      memory = { status: 'error', errorMessage: toMessage(error) };
    }
    notifySoon();
  };
  /** 만든 worktree의 상태를 읽습니다. 만들거나 초기 명령이 도는 동안은 1초마다 다시 읽습니다. */
  const refreshWorktrees = async (): Promise<void> => {
    try {
      const next = (await requestJson('/api/worktrees', worktreeListResponseSchema)).worktrees;
      for (const item of next) {
        const before = worktrees.find((entry) => entry.id === item.id);
        if (before?.terminalId !== item.terminalId) {
          actions.loadTabs(item.path).catch(() => undefined);
        }
      }
      worktrees = next;
      requestBranches(next.map((item) => item.path));
      if (next.some((item) => item.status === 'creating' || item.status === 'setup')) {
        worktreePollTimer ??= setTimeout(() => {
          worktreePollTimer = null;
          refreshWorktrees().catch(() => undefined);
        }, 1000);
      }
    } catch {
      // 다음 목록 갱신에서 다시 읽습니다.
    }
    notifySoon();
  };
  const changeMcpServers = async (
    path: string,
    init: { method: 'POST' | 'PATCH' | 'DELETE'; body?: unknown },
  ): Promise<void> => {
    applyMcpServers((await requestJson(path, mcpServerListResponseSchema, init)).servers);
  };

  const post = async <T>(
    id: string,
    path: string,
    body: unknown,
    schema: Parser<T>,
  ): Promise<T | null> => {
    try {
      const result = await requestJson(`/api/sessions/${id}/${path}`, schema, {
        method: 'POST',
        body,
      });
      after(id);
      return result;
    } catch (error) {
      fail(id, error);
      return null;
    }
  };

  const actions: OraActions = {
    createSession: async (task, cwd, model) => {
      const created = await requestJson('/api/sessions', sessionIdResponseSchema, {
        method: 'POST',
        body: { task, ...(cwd ? { cwd } : {}), ...(model ? { model } : {}) },
      });
      // 서버가 세션 기록을 쓰기 전에 목록을 읽을 수 있어서, 새 세션이 목록에 보일 때까지 다시 읽습니다.
      for (let attempt = 0; attempt < createListRetries; attempt += 1) {
        await refreshList();
        if (sessions.has(created.sessionId)) break;
        await new Promise((resolve) => setTimeout(resolve, createListRetryDelayMs));
      }
      return created.sessionId;
    },
    sendMessage: async (id, text) => {
      await post(id, 'message', { text }, sessionIdResponseSchema);
    },
    cancelRun: async (id, mode) => {
      const result = await post(id, 'cancel', { mode }, okResponseSchema);
      const state = sessions.get(id);
      if (result && state && mode === 'soft') {
        state.isStopping = true;
        touch(state);
      }
    },
    decideApproval: async (id, requestId, decision: ApprovalDecision) => {
      const checked = approvalDecisionSchema.safeParse(decision);
      if (!checked.success) {
        fail(id, new Error('승인 결정의 모양이 맞지 않습니다.'));
        return;
      }
      await post(id, 'approval', { requestId, decision: checked.data }, okResponseSchema);
    },
    answerQuestions: async (id, requestId, answers: QuestionAnswer[]) => {
      await post(id, 'answer', { requestId, answers }, okResponseSchema);
    },
    readCompaction: async (id, path) => {
      const file = await requestJson(
        `/api/sessions/${id}/compaction?path=${encodeURIComponent(path)}`,
        compactionFileResponseSchema,
      );
      return file.text;
    },
    resumeSession: async (id) => {
      await post(id, 'resume', {}, sessionIdResponseSchema);
    },
    abandonTodo: async (id, todoId) =>
      (await post(id, 'todo-abandon', { todoId }, todoActionResponseSchema)) !== null,
    restoreTodo: async (id, todoId) =>
      (await post(id, 'todo-restore', { todoId }, todoActionResponseSchema)) !== null,
    refreshAccounts,
    startLogin: async (provider) => {
      const state = await requestJson(`/api/accounts/${provider}/login`, loginStateSchema, {
        method: 'POST',
        body: {},
      });
      await refreshAccounts();
      return state;
    },
    cancelLogin: async (provider) => {
      await requestJson(`/api/accounts/${provider}/login/cancel`, loginStateSchema, {
        method: 'POST',
        body: {},
      });
      await refreshAccounts();
    },
    addApiKey: async (provider, envName) => {
      await requestJson(`/api/accounts/${provider}/api-key`, accountViewSchema, {
        method: 'POST',
        body: { envName },
      });
      await refreshAccounts();
    },
    logoutAccount: async (provider, name) => {
      await requestJson(
        `/api/accounts/${provider}/${encodeURIComponent(name)}/logout`,
        okResponseSchema,
        { method: 'POST', body: {} },
      );
      await refreshAccounts();
    },
    setAccountPriority: async (provider, name, priority) => {
      await requestJson(
        `/api/accounts/${provider}/${encodeURIComponent(name)}/priority`,
        okResponseSchema,
        { method: 'POST', body: { priority } },
      );
      await refreshAccounts();
    },
    refreshCostSettings,
    saveCostSettings: async (next: CostSettings) => {
      await requestJson('/api/cost-settings', costSettingsSchema, { method: 'PUT', body: next });
      await refreshCostSettings();
    },
    refreshEngineSettings,
    saveGeneralSettings: async (next) => {
      await requestJson('/api/settings/general', generalSettingsSchema, {
        method: 'PUT',
        body: next,
      });
      await refreshEngineSettings('general');
    },
    saveModelSettings: async (next) => {
      await requestJson('/api/settings/models', modelSettingsSchema, { method: 'PUT', body: next });
      await refreshEngineSettings('models');
    },
    savePermissionSettings: async (next) => {
      await requestJson('/api/settings/permissions', permissionSettingsResponseSchema, {
        method: 'PUT',
        body: next,
      });
      await refreshEngineSettings('permissions');
    },
    saveIsolationSettings: async (next) => {
      await requestJson('/api/settings/isolation', isolationSettingsResponseSchema, {
        method: 'PUT',
        body: next,
      });
      await refreshEngineSettings('isolation');
    },
    deleteApprovalRule: async (key) => {
      await requestJson(
        `/api/permission-rules/${encodeURIComponent(key)}`,
        permissionRulesResponseSchema,
        { method: 'DELETE' },
      );
      await refreshEngineSettings('approvalRules');
    },
    openNewTab: async (cwd) => {
      const saved = await requestJson(
        `/api/tabs?cwd=${encodeURIComponent(cwd)}`,
        tabsResponseSchema,
      );
      const tab = {
        id: crypto.randomUUID().replaceAll('-', '').slice(0, 10),
        kind: 'new' as const,
        isSessionMode: true,
      };
      await actions.saveTabs(cwd, { tabs: [...saved.tabs.tabs, tab], activeTabId: tab.id });
      return tab.id;
    },
    createWorktree: async (body) => {
      const created = await requestJson('/api/worktrees', worktreeResponseSchema, {
        method: 'POST',
        body,
      });
      await refreshWorktrees();
      await refreshEngineSettings('repos');
      return created.worktree;
    },
    loadWorktreeOptions: (repo) =>
      requestJson(
        `/api/worktrees/options?repo=${encodeURIComponent(repo)}`,
        worktreeOptionsResponseSchema,
      ),
    rerunWorktreeSetup: async (id) => {
      await requestJson(`/api/worktrees/${id}/rerun`, worktreeResponseSchema, {
        method: 'POST',
        body: {},
      });
      await refreshWorktrees();
    },
    saveReposSettings: async (next) => {
      await requestJson('/api/settings/repos', reposSettingsResponseSchema, {
        method: 'PUT',
        body: next,
      });
      await refreshEngineSettings('repos');
    },
    refreshMcpServers,
    refreshSkills,
    refreshMemory,
    deleteMemory: async (id) => {
      await requestJson(`/api/memory/${encodeURIComponent(id)}`, memoryDeleteResponseSchema, {
        method: 'DELETE',
      });
      await refreshMemory(memoryCwd);
    },
    tidyMemory: async () => {
      await requestJson('/api/memory/tidy', memoryPassSummarySchema, { method: 'POST', body: {} });
      await refreshMemory(memoryCwd);
    },
    addMcpServer: (body) => changeMcpServers('/api/mcp-servers', { method: 'POST', body }),
    setMcpServerEnabled: (name, enabled) =>
      changeMcpServers(`/api/mcp-servers/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        body: { enabled },
      }),
    removeMcpServer: (name) =>
      changeMcpServers(`/api/mcp-servers/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    reconnectMcpServer: (name) =>
      changeMcpServers(`/api/mcp-servers/${encodeURIComponent(name)}/reconnect`, {
        method: 'POST',
      }),
    dismissError: (id) => {
      const state = sessions.get(id);
      if (!state) return;
      state.error = null;
      touch(state);
    },
    loadTabs: async (cwd) => {
      const query = `?cwd=${encodeURIComponent(cwd)}`;
      const [saved, listed] = await Promise.all([
        requestJson(`/api/tabs${query}`, tabsResponseSchema),
        requestJson(`/api/terminals${query}`, terminalListResponseSchema),
        loadBranch(cwd),
      ]);
      tabs.set(cwd, saved.tabs);
      for (const terminal of listed.terminals) terminals.set(terminal.id, terminal);
      notifyNow();
    },
    loadChanges: async (cwd) => {
      changes.set(
        cwd,
        await requestJson(`/api/changes?cwd=${encodeURIComponent(cwd)}`, changesResponseSchema),
      );
      notifyNow();
    },
    saveTabs: async (cwd, next) => {
      tabs.set(cwd, next);
      notifyNow();
      await requestJson('/api/tabs', tabsResponseSchema, {
        method: 'PUT',
        body: { cwd, tabs: next },
      });
    },
    createTerminal: async (cwd, size) => {
      const created = await requestJson('/api/terminals', terminalResponseSchema, {
        method: 'POST',
        body: { cwd, ...size },
      });
      terminals.set(created.terminal.id, created.terminal);
      notifyNow();
      return created.terminal.id;
    },
    killTerminal: async (id) => {
      await requestJson(`/api/terminals/${id}/kill`, okResponseSchema, {
        method: 'POST',
        body: {},
      });
    },
    sendTerminalInput: (id, data) => {
      // 키 입력이 서로 앞지르지 않도록 한 번에 하나씩 보냅니다.
      const sent = terminalInputChain
        .catch(() => undefined)
        .then(() =>
          requestJson(`/api/terminals/${id}/input`, okResponseSchema, {
            method: 'POST',
            body: { data },
          }),
        );
      terminalInputChain = sent;
      return sent.then(() => undefined);
    },
    resizeTerminal: async (id, size) => {
      await requestJson(`/api/terminals/${id}/resize`, okResponseSchema, {
        method: 'POST',
        body: size,
      });
    },
    watchTerminal: (id, handlers) => {
      const source = new EventSource(`/api/terminals/${id}/output`);
      let hasOpened = false;
      source.addEventListener('open', () => {
        if (hasOpened) handlers.onReset();
        hasOpened = true;
      });
      source.addEventListener(terminalSseEventNames.output, (event) => {
        const body = terminalOutputEventSchema.parse(
          JSON.parse((event as MessageEvent<string>).data),
        );
        handlers.onOutput(Uint8Array.from(atob(body.data), (char) => char.charCodeAt(0)));
      });
      source.addEventListener(terminalSseEventNames.exit, (event) => {
        const body = terminalExitEventSchema.parse(
          JSON.parse((event as MessageEvent<string>).data),
        );
        handlers.onExit(body.exitCode);
        source.close();
      });
      return () => {
        source.close();
      };
    },
  };

  snapshot = {
    status: 'loading',
    sidebar: { repos: [], deviceName: '이 컴퓨터' },
    sessionsWithoutFolder: [],
    getBranch: () => undefined,
    getWorktreeSetup: () => undefined,
    getDefaultBranch: () => undefined,
    getChanges: () => undefined,
    getNewSessionContext: getNewSessionContext,
    empty: { repos: [], branches: [] },
    routing,
    defaultSessionId: undefined,
    getTabs: () => undefined,
    getTerminal: () => undefined,
    getSession: () => undefined,
    watchSession,
    actions,
    accounts,
    costSettings,
    engineSettings,
    mcpServers,
    skills,
    memory,
  };

  refreshList().catch(() => undefined);
  refreshAccounts().catch(() => undefined);
  refreshCostSettings().catch(() => undefined);
  for (const page of [
    'general',
    'models',
    'permissions',
    'isolation',
    'approvalRules',
    'repos',
  ] as const) {
    refreshEngineSettings(page).catch(() => undefined);
  }
  refreshWorktrees().catch(() => undefined);
  refreshMcpServers().catch(() => undefined);
  refreshSkills().catch(() => undefined);
  refreshMemory().catch(() => undefined);
  requestJson('/api/routing', routingResponseSchema)
    .then((result) => {
      const chain = result.roles.default ?? [];
      routing = {
        chain,
        others: result.catalog.filter(
          (entry) =>
            !chain.some((item) => item.provider === entry.provider && item.model === entry.model),
        ),
      };
      for (const state of sessions.values()) state.view = null;
      notifySoon();
    })
    .catch(() => undefined);
  requestJson('/api/info', infoResponseSchema)
    .then((result) => {
      info = result;
      requestBranches([result.cwd]);
      for (const state of sessions.values()) state.view = null;
      notifySoon();
    })
    .catch((error: unknown) => {
      infoError = `서버의 기본 작업 폴더를 읽지 못했습니다. ${toMessage(error)}`;
      notifySoon();
    });

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
  };
}
