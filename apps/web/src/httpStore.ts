import {
  approvalDecisionSchema,
  okResponseSchema,
  oraEventSchema,
  pendingApprovalSchema,
  pendingQuestionSchema,
  requestResolvedSchema,
  errorResponseSchema,
  infoResponseSchema,
  type InfoResponse,
  sessionDetailResponseSchema,
  sessionIdResponseSchema,
  sessionListResponseSchema,
  sseEventNames,
  steerFailedSchema,
  type ApprovalDecision,
  type OraEvent,
  type PendingApproval,
  type PendingQuestion,
  type QuestionAnswer,
  type SessionRecord,
  type Todo,
} from '@ora/protocol';
import type { ThreadMessageLike } from '@assistant-ui/react';
import { buildThread, reuseMessages } from './events.ts';
import { buildCacheView } from './lib/cache.ts';
import { basename } from './lib/path.ts';
import { permissionLabel } from './lib/status.ts';
import type {
  OraActions,
  OraStore,
  OraStoreSource,
  RepoNode,
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
  init?: { method: 'POST'; body: unknown },
): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: init ? { 'content-type': 'application/json' } : undefined,
    body: init ? JSON.stringify(init.body) : undefined,
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

/** 세션의 `repo` 경로로 저장소 그룹을 만들고, 그룹마다 그 작업 폴더 하나를 워크트리 행으로 둡니다(SPEC 2.7절). */
function buildRepos(records: readonly SessionRecord[]): RepoNode[] {
  const groups = new Map<string, SessionRecord[]>();
  for (const record of records) {
    const key = record.repo ?? '';
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.entries()].map(([repo, list]) => {
    const worktree: WorktreeNode = {
      name: repo === '' ? '작업 폴더 없음' : basename(repo),
      cwd: repo === '' ? undefined : repo,
      title: repo === '' ? undefined : repo,
      sessions: list.map((record) => ({ record, todoTitles: [] })),
      stack: [],
    };
    return { name: repo === '' ? '작업 폴더 없음' : basename(repo), worktrees: [worktree] };
  });
}

function buildStatusLine(events: readonly OraEvent[], maxSteps: number | undefined): string[] {
  const requests = events.filter((event) => event.type === 'model_request');
  const start = events.find((event) => event.type === 'session_start');
  const lastModel = requests.at(-1);
  return [
    ...(requests.length > 0
      ? [`스텝 ${requests.length}${maxSteps === undefined ? '' : `/${maxSteps}`}`]
      : []),
    ...(lastModel ? [lastModel.payload.model] : []),
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
  let infoError: string | undefined;
  let snapshot: OraStore;
  let notifyTimer: ReturnType<typeof setTimeout> | null = null;
  let listRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let steerFailureCount = 0;

  /** 폴더를 고르지 않은 새 세션은 서버가 알려 준 기본 작업 폴더와 브랜치를 보여 줍니다. */
  function getNewSessionContext(cwd?: string): WorktreeContext {
    if (cwd !== undefined) return { path: cwd };
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
      chips: {
        model: state.record.models[0]?.model,
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
      sidebar: { repos: buildRepos(records), deviceName: '이 컴퓨터' },
      getNewSessionContext: getNewSessionContext,
      empty: { repos: [], branches: [] },
      defaultSessionId: records[0]?.id,
      getSession: (id) => views.get(id),
      watchSession,
      actions,
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
    createSession: async (task, cwd) => {
      const created = await requestJson('/api/sessions', sessionIdResponseSchema, {
        method: 'POST',
        body: { task, ...(cwd ? { cwd } : {}) },
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
    resumeSession: async (id) => {
      await post(id, 'resume', {}, sessionIdResponseSchema);
    },
    dismissError: (id) => {
      const state = sessions.get(id);
      if (!state) return;
      state.error = null;
      touch(state);
    },
  };

  snapshot = {
    status: 'loading',
    sidebar: { repos: [], deviceName: '이 컴퓨터' },
    getNewSessionContext: getNewSessionContext,
    empty: { repos: [], branches: [] },
    defaultSessionId: undefined,
    getSession: () => undefined,
    watchSession,
    actions,
  };

  refreshList().catch(() => undefined);
  requestJson('/api/info', infoResponseSchema)
    .then((result) => {
      info = result;
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
