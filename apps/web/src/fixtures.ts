import type {
  Actor,
  EventOf,
  OraEvent,
  OraEventType,
  SessionRecord,
  SessionStatus,
  Stage,
  Todo,
} from '@ora/protocol';
import type {
  OraActions,
  OraStore,
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
        text: '`add`가 뺄셈 부호를 쓰고 있어서 덧셈으로 고쳤습니다. 이제 저장소에 있는 `check.js`로 검증하겠습니다.',
      },
    ],
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

const sessionView: SessionView = {
  record: createRecord(mathId, 'add 함수 버그 수정', 'awaiting_approval', 'math-demo'),
  events: mathEvents,
  todos: mathTodos,
  repoLabel: 'math-demo · main',
  diff: { add: 1, del: 1 },
  statusLine: ['스텝 12/50', '기본 모델 사용 중', '격리 harness'],
  approval: {
    callId: 'c3',
    risk: '위험도 보통',
    explanation: 't1의 검증 명령입니다. 엔진이 실행하고, 종료 코드와 출력을 증거로 남깁니다.',
  },
};

const askId = 's-20261028-n0t3s1';
const makeAsk = createEventFactory(askId);
const questionView: SessionView = {
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
      args: {
        questions: [
          {
            header: '타임아웃 기준',
            question: '몇 초 넘게 걸리면 타임아웃으로 볼까요?',
            multiSelect: false,
            options: [
              { label: '30초', description: '현재 설정값입니다' },
              { label: '60초', description: '느린 네트워크를 감안합니다' },
              { label: '120초', description: '대용량 검색까지 포함합니다' },
            ],
          },
          {
            header: '조사 범위',
            question: '어디까지 조사할까요?',
            multiSelect: true,
            options: [
              { label: '검색 도구 코드', description: 'src/search.ts와 호출하는 쪽을 읽습니다' },
              { label: 'MCP 서버 설정', description: '서버별 타임아웃과 재시도 값을 확인합니다' },
              {
                label: '네트워크 기록',
                description: '느린 요청이 실제로 있었는지 로그로 확인합니다',
              },
            ],
          },
        ],
      },
    }),
  ],
  todos: [],
  repoLabel: 'notes · main',
  diff: null,
  statusLine: ['스텝 3/50', '기본 모델 사용 중', '격리 harness'],
  placeholder: '질문에 답하거나, 다른 내용을 적어 보냅니다',
  initialSearch: { query: '타임아웃' },
  questionDraft: { current: 1, picks: [[0], [0, 1]] },
};

const crashId = 's-20261028-r3adme';
const makeCrash = createEventFactory(crashId);
const crashedView: SessionView = {
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
};

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
      createWorktree('main', 4, 0),
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
  return {
    record,
    events: [],
    todos: [],
    repoLabel: record.repo ?? '',
    diff: null,
    statusLine: [],
  };
}

const plainViews = new Map<string, SessionView>(
  repos
    .flatMap((repo) => listSessionNodes(repo.worktrees))
    .filter((node) => !detailedViews.has(node.record.id))
    .map((node) => [node.record.id, createPlainView(node.record)]),
);

const fixtureActions: OraActions = {
  sendMessage: () => Promise.resolve(),
  cancelRun: () => Promise.resolve(),
  decideApproval: () => Promise.resolve(),
  answerQuestions: () => Promise.resolve(),
  resumeSession: () => Promise.resolve(),
};

/** 엔진 연결 전 고정 예시 데이터로 화면을 확인하는 저장소입니다. 엔진 요청은 받아도 아무 일도 하지 않습니다. */
export function createFixtureStore(): OraStore {
  return {
    sidebar: { repos, deviceName: 'MacBook-Pro' },
    newSession: { path: '~/Desktop/ora', branch: 'main', add: 4, del: 0 },
    empty: { repos: ['math-demo', 'ora', 'notes'], branches: ['main'] },
    defaultSessionId: sessionView.record.id,
    getSession: (sessionId) => {
      const id = devAliases.get(sessionId) ?? sessionId;
      return detailedViews.get(id) ?? plainViews.get(id);
    },
    actions: fixtureActions,
  };
}
