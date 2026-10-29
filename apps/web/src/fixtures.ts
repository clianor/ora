import { buildThread } from './events.ts';
import { buildCacheView } from './lib/cache.ts';
import type { AccountProvider, LoginState, ProviderAccounts } from '@ora/protocol';
import type {
  Actor,
  EventOf,
  OraEvent,
  OraEventType,
  PendingApproval,
  PendingQuestion,
  SessionRecord,
  SessionStatus,
  Stage,
  Todo,
} from '@ora/protocol';
import type {
  AccountsData,
  OraActions,
  OraStore,
  OraStoreSource,
  RepoNode,
  SessionNode,
  SessionView,
  WorktreeNode,
} from './model.ts';

// 작업 C에서 서버 응답으로 바꾸기 전까지 화면을 그리는 고정 예시 데이터입니다.

const day = '2026-10-28';

function createRecord(
  id: string,
  title: string,
  status: SessionStatus,
  repo: string,
): SessionRecord {
  return {
    schemaVersion: 1,
    id,
    createdAt: `${day}T09:00:00+09:00`,
    updatedAt: `${day}T10:42:00+09:00`,
    title,
    actor: 'user',
    status,
    repo,
    models: [{ model: 'default', role: 'main' }],
    permissionMode: 'always-ask',
    isolation: 'harness',
    promptHash: 'p-demo',
    engineVersion: '0.0.0',
  };
}

function createEventFactory(sessionId: string) {
  let seq = 0;
  return <T extends OraEventType>(
    type: T,
    time: string,
    actor: Actor,
    payload: EventOf<T>['payload'],
  ): OraEvent => {
    seq += 1;
    return {
      seq,
      ts: `${day}T${time}:00+09:00`,
      sessionId,
      actor,
      type,
      payload,
    } as unknown as OraEvent;
  };
}

function createStageEvents(
  make: ReturnType<typeof createEventFactory>,
  upTo: Stage,
  stagesInOrder: readonly Stage[],
): OraEvent[] {
  return stagesInOrder
    .slice(0, stagesInOrder.indexOf(upTo) + 1)
    .map((stage) => make('stage', '09:01', 'engine', { outcome: 'entered', stage }));
}

const stageOrder: readonly Stage[] = [
  'understand',
  'research',
  'decide',
  'plan',
  'execute',
  'verify',
  'operate',
  'learn',
];

const sessionStart = (make: ReturnType<typeof createEventFactory>): OraEvent =>
  make('session_start', '09:00', 'engine', {
    configSummary: {},
    isolation: 'harness',
    permissionMode: 'always-ask',
    instructionFiles: [],
    promptHash: 'p-demo',
  });

const mathId = 's-20261028-m4th01';
const makeMath = createEventFactory(mathId);
const mathEvents: OraEvent[] = [
  sessionStart(makeMath),
  ...createStageEvents(makeMath, 'execute', stageOrder),
  makeMath('message', '09:02', 'user', {
    role: 'user',
    content: [
      { type: 'text', text: 'math.js의 add가 뺄셈을 하고 있어요. 고치고 테스트까지 돌려 주세요.' },
    ],
  }),
  makeMath('tool_call', '09:02', 'model', { callId: 'c0', tool: 'ask_user', args: {} }),
  makeMath('question', '09:02', 'engine', {
    callId: 'c0',
    questions: [
      { header: '대상 파일', question: '어떤 파일을 고칠까요?', options: ['math.js', 'check.js'] },
      {
        question: '함께 확인할 항목을 고르세요.',
        options: ['덧셈', '뺄셈', '곱셈'],
        multiSelect: true,
      },
    ],
  }),
  makeMath('answer', '09:03', 'user', {
    callId: 'c0',
    answers: [{ choices: ['math.js'] }, { choices: ['덧셈', '뺄셈'], text: '음수도 확인' }],
  }),
  makeMath('tool_result', '09:03', 'tool', {
    callId: 'c0',
    status: 'ok',
    summary: '답을 받았습니다',
    durationMs: 4000,
  }),
  makeMath('tool_call', '09:03', 'model', {
    callId: 'c1',
    tool: 'read',
    args: { path: 'math.js' },
    tier: 'read',
  }),
  makeMath('tool_result', '09:03', 'tool', {
    callId: 'c1',
    status: 'ok',
    summary: '1줄',
    durationMs: 12,
  }),
  makeMath('tool_call', '09:04', 'model', {
    callId: 'c2',
    tool: 'edit',
    args: {
      path: 'math.js',
      diff: [
        ['1', '-', 'exports.add = (a, b) => a - b;'],
        ['1', '+', 'exports.add = (a, b) => a + b;'],
      ],
    },
    tier: 'write',
  }),
  makeMath('tool_result', '09:04', 'tool', {
    callId: 'c2',
    status: 'ok',
    summary: '1줄 바꿈',
    durationMs: 30,
  }),
  makeMath('message', '09:05', 'model', {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: [
          '**원인:** `add`가 뺄셈 부호를 쓰고 있었습니다.',
          '',
          '- 덧셈으로 고쳤습니다',
          '- 이제 저장소에 있는 `check.js`로 검증합니다',
          '',
          '| 항목 | 결과 |',
          '| --- | --- |',
          '| add(1, 2) | 3 |',
          '',
          '```js',
          'exports.add = (a, b) => a + b;',
          '```',
        ].join('\n'),
      },
    ],
  }),
  makeMath('model_request', '09:02', 'engine', {
    model: 'fake/scripted',
    adapter: 'fake',
    chainPosition: 0,
    nativeToolCalls: true,
    usage: {
      outputTokens: 420,
      uncachedInputTokens: 25200,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 8000,
    },
    durationMs: 2100,
  }),
  makeMath('model_request', '09:03', 'engine', {
    model: 'fake/scripted',
    adapter: 'fake',
    chainPosition: 0,
    nativeToolCalls: true,
    usage: {
      outputTokens: 380,
      uncachedInputTokens: 900,
      cacheReadInputTokens: 70000,
      cacheCreationInputTokens: 2000,
    },
    durationMs: 1800,
  }),
  makeMath('model_request', '09:04', 'engine', {
    model: 'fake/scripted',
    adapter: 'fake',
    chainPosition: 0,
    nativeToolCalls: true,
    usage: {
      outputTokens: 210,
      uncachedInputTokens: 700,
      cacheReadInputTokens: 71200,
      cacheCreationInputTokens: 1500,
    },
    durationMs: 1500,
  }),
  makeMath('model_request', '09:05', 'engine', {
    model: 'fake/scripted',
    adapter: 'fake',
    chainPosition: 0,
    nativeToolCalls: true,
    usage: {
      outputTokens: 160,
      uncachedInputTokens: 300,
      cacheReadInputTokens: 41200,
      cacheCreationInputTokens: 1100,
    },
    durationMs: 1300,
  }),
  makeMath('tool_call', '09:06', 'model', {
    callId: 'c3',
    tool: 'bash',
    args: { command: 'node check.js', cwd: '~/projects/math-demo' },
    tier: 'exec',
  }),
];

const mathTodos: Todo[] = [
  {
    id: 't1',
    content: 'math.js의 add를 덧셈으로 고친다',
    status: 'attempted',
    attempts: 1,
    writeScope: ['math.js'],
    verify: { command: 'node check.js', origin: 'model' },
    updatedAt: `${day}T09:05:00+09:00`,
  },
  {
    id: 't2',
    content: 'README 예제 출력을 갱신한다',
    status: 'verified',
    attempts: 1,
    writeScope: ['README.md'],
    verify: { command: 'pnpm test -- readme', origin: 'repo' },
    evidence: {
      command: 'pnpm test -- readme',
      exitCode: 0,
      summary: '통과',
      origin: 'repo',
      ranAt: `${day}T09:04:00+09:00`,
      scopeDigest: 'sha256:ab12',
    },
    updatedAt: `${day}T09:04:00+09:00`,
  },
  {
    id: 't3',
    content: '변경 요약을 남긴다',
    status: 'pending',
    attempts: 0,
    writeScope: [],
    updatedAt: `${day}T09:00:00+09:00`,
  },
];

const designChips = { model: '기본 모델', effort: 'medium', permission: '승인 생략' };

type ViewBase = Omit<
  SessionView,
  'thread' | 'approvals' | 'questions' | 'isStopping' | 'error' | 'steerFailure' | 'cache'
>;

/** 기다리는 요청(승인, 질문)을 정하고 이벤트에서 채팅 메시지를 만들어 화면 데이터를 완성합니다. */
function finishView(
  base: ViewBase,
  waiting: { approvals?: PendingApproval[]; questions?: PendingQuestion[] } = {},
): SessionView {
  const approvals = waiting.approvals ?? [];
  const questions = waiting.questions ?? [];
  const waitingCallIds = new Set([
    ...approvals.map((item) => item.request.callId),
    ...questions.map((item) => item.request.callId),
  ]);
  return {
    ...base,
    chips: designChips,
    cache: buildCacheView(base.events, base.record.id === mathId ? '1시간' : undefined),
    thread: buildThread(base.events, waitingCallIds),
    approvals,
    questions,
    isStopping: false,
    error: null,
    steerFailure: null,
  };
}

const sessionView: SessionView = finishView(
  {
    record: createRecord(mathId, 'add 함수 버그 수정', 'awaiting_approval', 'math-demo'),
    events: mathEvents,
    todos: mathTodos,
    repoLabel: 'math-demo · main',
    diff: { add: 1, del: 1 },
    statusLine: ['스텝 12/50', '기본 모델 사용 중', '격리 harness'],
  },
  {
    approvals: [
      {
        requestId: 'req-approval-1',
        request: {
          callId: 'c3',
          tool: 'bash',
          tier: 'exec',
          reason: 't1의 검증 명령입니다. 엔진이 실행하고, 종료 코드와 출력을 증거로 남깁니다.',
          detail: {
            kind: 'shell',
            command: 'node check.js',
            cwd: '~/projects/math-demo',
            risk: 'medium',
          },
          todo: { id: 't1', content: 'math.js의 add를 덧셈으로 고친다' },
        },
      },
    ],
  },
);

const askId = 's-20261028-n0t3s1';
const makeAsk = createEventFactory(askId);
const questionView: SessionView = finishView(
  {
    record: createRecord(askId, '검색 도구 타임아웃 조사', 'awaiting_user', 'notes'),
    events: [
      sessionStart(makeAsk),
      ...createStageEvents(makeAsk, 'understand', stageOrder),
      makeAsk('message', '09:02', 'user', {
        role: 'user',
        content: [
          { type: 'text', text: '검색 도구가 가끔 타임아웃으로 끝나요. 원인을 찾아 주세요.' },
        ],
      }),
      makeAsk('tool_call', '09:03', 'model', {
        callId: 'q1',
        tool: 'read',
        args: { path: 'src/search.ts' },
        tier: 'read',
      }),
      makeAsk('tool_result', '09:03', 'tool', {
        callId: 'q1',
        status: 'ok',
        summary: '88줄',
        durationMs: 9,
      }),
      makeAsk('tool_call', '09:04', 'model', {
        callId: 'q2',
        tool: 'search',
        args: { pattern: 'timeout' },
        tier: 'read',
      }),
      makeAsk('tool_result', '09:04', 'tool', {
        callId: 'q2',
        status: 'ok',
        summary: '5건',
        durationMs: 41,
      }),
      makeAsk('message', '09:05', 'model', {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: '검색 도구 호출이 기대보다 오래 걸려 실패하는 원인을 찾는 작업으로 이해했습니다. 시작하기 전에 두 가지를 정해야 합니다.',
          },
        ],
      }),
      makeAsk('tool_call', '09:06', 'model', {
        callId: 'q3',
        tool: 'ask_user',
        args: {},
      }),
    ],
    todos: [],
    repoLabel: 'notes · main',
    diff: null,
    statusLine: ['스텝 3/50', '기본 모델 사용 중', '격리 harness'],
    placeholder: '질문에 답하거나, 다른 내용을 적어 보냅니다',
    initialSearch: { query: '타임아웃' },
    questionDraft: { current: 1, picks: [[0], [0, 1]] },
  },
  {
    questions: [
      {
        requestId: 'req-question-1',
        request: {
          callId: 'q3',
          questions: [
            {
              header: '타임아웃',
              question: '몇 초 넘게 걸리면 타임아웃으로 볼까요?',
              options: ['30초', '60초', '120초'],
            },
            {
              header: '조사 범위',
              question: '어디까지 조사할까요?',
              options: ['검색 도구 코드', 'MCP 서버 설정', '네트워크 기록'],
              multiSelect: true,
            },
          ],
        },
      },
    ],
  },
);

const crashId = 's-20261028-r3adme';
const makeCrash = createEventFactory(crashId);
const crashedView: SessionView = finishView({
  record: createRecord(crashId, 'README 설치 절차 갱신', 'crashed', 'math-demo'),
  events: [
    sessionStart(makeCrash),
    ...createStageEvents(makeCrash, 'verify', stageOrder),
    makeCrash('message', '10:30', 'user', {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'README 설치 절차를 pnpm 기준으로 갱신하고, 예제가 실제로 도는지 확인해 주세요.',
        },
      ],
    }),
    makeCrash('tool_call', '10:34', 'model', {
      callId: 'r1',
      tool: 'edit',
      args: { path: 'README.md', add: 12, del: 3 },
      tier: 'write',
    }),
    makeCrash('tool_result', '10:34', 'tool', {
      callId: 'r1',
      status: 'ok',
      summary: '12줄 추가, 3줄 삭제',
      durationMs: 40,
    }),
    makeCrash('tool_call', '10:38', 'model', {
      callId: 'r2',
      tool: 'bash',
      args: { command: 'pnpm test -- install', cwd: '~/projects/math-demo' },
      tier: 'exec',
    }),
    makeCrash('tool_result', '10:38', 'tool', {
      callId: 'r2',
      status: 'ok',
      summary: 'exit 0',
      durationMs: 2300,
    }),
    makeCrash('tool_call', '10:40', 'model', {
      callId: 'r3',
      tool: 'bash',
      args: { command: 'pnpm test -- readme', cwd: '~/projects/math-demo' },
      tier: 'exec',
    }),
    makeCrash('tool_result', '10:42', 'engine', {
      callId: 'r3',
      status: 'aborted',
      summary: 'aborted',
      durationMs: 0,
    }),
    makeCrash('recovered', '10:42', 'engine', { droppedLines: 1, droppedBytes: 64, afterSeq: 18 }),
  ],
  todos: [
    {
      id: 't1',
      content: 'README 설치 절차를 pnpm으로 바꾼다',
      status: 'verified',
      attempts: 1,
      writeScope: ['README.md'],
      verify: { command: 'pnpm test -- install', origin: 'repo' },
      evidence: {
        command: 'pnpm test -- install',
        exitCode: 0,
        summary: '통과',
        origin: 'repo',
        ranAt: `${day}T10:38:00+09:00`,
        scopeDigest: 'sha256:cd34',
      },
      updatedAt: `${day}T10:38:00+09:00`,
    },
    {
      id: 't2',
      content: 'README 예제 출력을 확인한다',
      status: 'interrupted',
      attempts: 1,
      writeScope: ['README.md'],
      verify: { command: 'pnpm test -- readme', origin: 'repo' },
      updatedAt: `${day}T10:42:00+09:00`,
    },
    {
      id: 't3',
      content: '변경 요약을 남긴다',
      status: 'pending',
      attempts: 0,
      writeScope: [],
      updatedAt: `${day}T10:30:00+09:00`,
    },
  ],
  repoLabel: 'math-demo · docs/readme-pnpm',
  diff: { add: 12, del: 3 },
  statusLine: ['스텝 9/50', '기본 모델', '격리 harness'],
  placeholder: '재개할 때 함께 보낼 조향 메시지를 적습니다',
});

function createSession(
  record: SessionRecord,
  detail?: string,
  todoTitles: string[] = [],
): SessionNode {
  return { record, detail, todoTitles };
}

function createWorktree(
  name: string,
  add: number,
  del: number,
  sessions: SessionNode[] = [],
  stack: WorktreeNode[] = [],
): WorktreeNode {
  return { name, add, del, sessions, stack };
}

const repos: RepoNode[] = [
  {
    name: 'ora',
    worktrees: [
      { ...createWorktree('main', 4, 0), cwd: '~/Desktop/ora' },
      createWorktree('feat/engine-slice2', 1930, 350, [
        createSession(
          createRecord('s-20261027-0ra001', '엔진 슬라이스 2 구현', 'completed', 'ora'),
          '검증 3/3',
        ),
      ]),
    ],
  },
  {
    name: 'math-demo',
    worktrees: [
      createWorktree('main', 1, 1, [
        createSession(
          sessionView.record,
          undefined,
          sessionView.todos.map((t) => t.content),
        ),
      ]),
      createWorktree(
        'docs/readme-pnpm',
        12,
        3,
        [
          createSession(
            crashedView.record,
            undefined,
            crashedView.todos.map((t) => t.content),
          ),
        ],
        [
          createWorktree('docs/readme-examples', 5, 1, [
            createSession(
              createRecord(
                's-20261028-ex4mpl',
                'README 예제 실행 확인',
                'interrupted',
                'math-demo',
              ),
              '검증 1/2',
            ),
          ]),
        ],
      ),
    ],
  },
  {
    name: 'notes',
    worktrees: [
      createWorktree('main', 0, 0, [
        createSession(questionView.record),
        createSession(
          createRecord('s-20261025-mcp001', 'MCP 연결 끊김 조사', 'completed', 'notes'),
          '3일 전',
          ['MCP 서버 타임아웃 설정을 확인한다'],
        ),
        createSession(
          createRecord('s-20261028-n0t3s2', '검색 도구 타임아웃 재현', 'failed', 'notes'),
          '1시간 전',
        ),
      ]),
    ],
  },
];

function listSessionNodes(worktrees: WorktreeNode[]): SessionNode[] {
  return worktrees.flatMap((worktree) => [
    ...worktree.sessions,
    ...listSessionNodes(worktree.stack),
  ]);
}

const detailedViews = new Map<string, SessionView>(
  [sessionView, questionView, crashedView].map((view) => [view.record.id, view]),
);

// 시안을 주소로 열 수 있도록 개발용 별칭(#/question 등)도 세션 ID처럼 받습니다.
const devAliases = new Map<string, string>([
  ['question', questionView.record.id],
  ['crashed', crashedView.record.id],
]);

/** 이벤트가 없는 세션은 제목과 상태만 있는 빈 화면으로 보여 줍니다. */
function createPlainView(record: SessionRecord): SessionView {
  return finishView({
    record,
    events: [],
    todos: [],
    repoLabel: record.repo ?? '',
    diff: null,
    statusLine: [],
  });
}

const plainViews = new Map<string, SessionView>(
  repos
    .flatMap((repo) => listSessionNodes(repo.worktrees))
    .filter((node) => !detailedViews.has(node.record.id))
    .map((node) => [node.record.id, createPlainView(node.record)]),
);

type AccountActionName =
  | 'refreshAccounts'
  | 'startLogin'
  | 'cancelLogin'
  | 'addApiKey'
  | 'logoutAccount'
  | 'setAccountPriority';

const fixtureActions: Omit<OraActions, AccountActionName> = {
  createSession: () => Promise.resolve(sessionView.record.id),
  sendMessage: () => Promise.resolve(),
  cancelRun: () => Promise.resolve(),
  decideApproval: () => Promise.resolve(),
  answerQuestions: () => Promise.resolve(),
  resumeSession: () => Promise.resolve(),
  dismissError: () => undefined,
};

const iso = (ms: number) => new Date(ms).toISOString();
const fixtureNow = Date.now();

const fixtureAccounts: AccountsData = {
  status: 'ready',
  providers: [
    {
      provider: 'claude',
      accounts: [
        {
          name: 'main',
          kind: 'oauth',
          detail: 'me@example.com',
          priority: 2,
          fiveHour: { remainingPct: 94 },
          sevenDay: { remainingPct: 84 },
          status: 'inUse',
        },
        {
          name: 'second',
          kind: 'oauth',
          detail: 'second@example.com',
          priority: 1,
          fiveHour: { remainingPct: 0, resetsAt: iso(fixtureNow + 3_600_000) },
          sevenDay: { remainingPct: 61 },
          status: 'limited',
          limitedUntil: iso(fixtureNow + 3_600_000),
        },
        {
          name: 'credit',
          kind: 'apiKey',
          detail: 'ANTHROPIC_API_KEY',
          envPresent: true,
          priority: 0,
          status: 'idle',
        },
      ],
    },
    {
      provider: 'codex',
      accounts: [],
      login: {
        status: 'pending',
        prompt: {
          kind: 'url',
          url: 'https://auth.openai.com/oauth/authorize',
          expiresAt: iso(fixtureNow + 300_000),
        },
      },
    },
    {
      provider: 'grok',
      accounts: [],
      login: {
        status: 'pending',
        prompt: {
          kind: 'device',
          url: 'https://auth.x.ai/device',
          code: 'WDJB-MJHT',
          expiresAt: iso(fixtureNow + 861_000),
        },
      },
    },
  ],
};

/** 엔진 연결 없이 고정 예시 데이터로 화면을 확인하는 저장소입니다. 계정 화면의 조작은 이 메모리 안에서만 바뀝니다. */
export function createFixtureStore(): OraStoreSource {
  const listeners = new Set<() => void>();
  let accounts = fixtureAccounts;
  let snapshot: OraStore;

  const commit = (next: ProviderAccounts[]) => {
    accounts = { ...accounts, providers: next };
    snapshot = { ...snapshot, accounts };
    listeners.forEach((listener) => {
      listener();
    });
  };
  const update = (
    provider: AccountProvider,
    change: (entry: ProviderAccounts) => ProviderAccounts,
  ) => {
    commit(
      accounts.providers.map((entry) => (entry.provider === provider ? change(entry) : entry)),
    );
  };

  const actions: OraActions = {
    ...fixtureActions,
    refreshAccounts: () => Promise.resolve(),
    startLogin: (provider) => {
      const expiresAt = iso(Date.now() + 300_000);
      const login: LoginState = {
        status: 'pending',
        prompt:
          provider === 'grok'
            ? { kind: 'device', url: 'https://auth.x.ai/device', code: 'WDJB-MJHT', expiresAt }
            : { kind: 'url', url: 'https://example.com/login', expiresAt },
      };
      update(provider, (entry) => ({ ...entry, login }));
      return Promise.resolve(login);
    },
    cancelLogin: (provider) => {
      update(provider, ({ provider: id, accounts: rows }) => ({ provider: id, accounts: rows }));
      return Promise.resolve();
    },
    addApiKey: (provider, envName) => {
      update(provider, (entry) => ({
        ...entry,
        accounts: [
          ...entry.accounts,
          {
            name: envName,
            kind: 'apiKey',
            detail: envName,
            envPresent: false,
            priority: 0,
            status: 'idle',
          },
        ],
      }));
      return Promise.resolve();
    },
    logoutAccount: (provider, name) => {
      update(provider, (entry) => ({
        ...entry,
        accounts: entry.accounts.filter((account) => account.name !== name),
      }));
      return Promise.resolve();
    },
    setAccountPriority: (provider, name, priority) => {
      update(provider, (entry) => ({
        ...entry,
        accounts: entry.accounts
          .map((account) => (account.name === name ? { ...account, priority } : account))
          .toSorted((a, b) => b.priority - a.priority),
      }));
      return Promise.resolve();
    },
  };

  snapshot = {
    status: 'ready',
    sidebar: { repos, deviceName: 'MacBook-Pro' },
    getNewSessionContext: () => ({
      path: '~/Desktop/ora',
      branch: 'main',
      add: 4,
      del: 0,
      chips: designChips,
    }),
    empty: { repos: ['math-demo', 'ora', 'notes'], branches: ['main'], chips: designChips },
    defaultSessionId: sessionView.record.id,
    getSession: (sessionId) => {
      const id = devAliases.get(sessionId) ?? sessionId;
      return detailedViews.get(id) ?? plainViews.get(id);
    },
    watchSession: () => () => undefined,
    actions,
    accounts,
  };
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
