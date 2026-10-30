import { buildThread } from './events.ts';
import { buildCacheView } from './lib/cache.ts';
import { buildContextView } from './lib/context.ts';
import { listWorktrees } from './lib/worktrees.ts';
import type {
  AccountProvider,
  ChangesResponse,
  LoginState,
  McpServerStatus,
  ProviderAccounts,
} from '@ora/protocol';
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
  Terminal,
  Todo,
  WorktreeTabs,
} from '@ora/protocol';
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
  SessionNode,
  SessionView,
  RoutingData,
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
    models: [
      { model: 'default', provider: 'claude', role: 'default', chainPosition: 0, source: 'config' },
    ],
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
  | 'thread'
  | 'approvals'
  | 'questions'
  | 'isStopping'
  | 'error'
  | 'steerFailure'
  | 'cache'
  | 'context'
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
    context:
      base.record.id === contextId
        ? buildContextView(base.events, {
            contextWindow: 200_000,
            compactAtRatio: 0.8,
            keepRecentTokens: 20_000,
          })
        : null,
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
    record: createRecord(mathId, 'README 예제 출력 갱신', 'awaiting_approval', 'math-demo'),
    events: mathEvents,
    todos: mathTodos,
    repoLabel: 'math-demo · main',
    diff: { add: 1, del: 1 },
    statusLine: ['스텝 12/50', '격리 harness'],
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

const contextId = 's-20261029-c0nt3x';
const makeContext = createEventFactory(contextId);
const contextUsage = (uncached: number, read: number, creation: number) => ({
  model: 'fake/scripted',
  adapter: 'fake',
  chainPosition: 0,
  nativeToolCalls: true,
  usage: {
    outputTokens: 300,
    uncachedInputTokens: uncached,
    cacheReadInputTokens: read,
    cacheCreationInputTokens: creation,
  },
  durationMs: 1500,
});
const prunedReads = [
  'src/index.js',
  'src/math.js',
  'src/format.js',
  'README.md',
  'docs/api.md',
  'examples/sum.js',
  'examples/diff.js',
  'package.json',
  'check.js',
];
/** 시작 준비 이벤트 뒤에서 모델 요청과 도구 호출마다 스텝 번호를 올려 `stepId`를 붙입니다. */
function tagSteps(events: readonly OraEvent[]): OraEvent[] {
  let step = 0;
  return events.map((event) => {
    if (event.type === 'model_request' || event.type === 'tool_call') step += 1;
    return step === 0 || event.type === 'compaction' ? event : { ...event, stepId: `step-${step}` };
  });
}
const contextEvents: OraEvent[] = tagSteps([
  sessionStart(makeContext),
  ...createStageEvents(makeContext, 'verify', stageOrder),
  makeContext('message', '18:00', 'user', {
    role: 'user',
    content: [
      { type: 'text', text: 'math.js의 add가 뺄셈을 하고 있어요. 고치고 테스트까지 돌려 주세요.' },
    ],
  }),
  makeContext('model_request', '18:01', 'engine', contextUsage(30000, 0, 8000)),
  ...prunedReads.flatMap((path, index) => [
    makeContext('tool_call', '18:10', 'model', {
      callId: `p${index}`,
      tool: 'read',
      args: { path },
      tier: 'read',
    }),
    makeContext('tool_result', '18:10', 'tool', {
      callId: `p${index}`,
      status: 'ok',
      summary: '120줄',
      durationMs: 8,
    }),
  ]),
  makeContext('model_request', '18:20', 'engine', contextUsage(300, 55400, 0)),
  makeContext('compaction', '18:31', 'engine', {
    method: 'prune',
    fromSeq: 12,
    toSeq: 28,
    prunedCallIds: prunedReads.map((_, index) => `p${index}`),
    savedTokens: 58200,
  }),
  makeContext('compaction', '18:42', 'engine', {
    method: 'handoff',
    fromSeq: 1,
    toSeq: 24,
    path: 'compactions/1.md',
    prunedCallIds: [],
  }),
  makeContext('compaction', '18:44', 'engine', {
    method: 'summary',
    fromSeq: 25,
    toSeq: 40,
    path: 'compactions/2.md',
    prunedCallIds: [],
    prepared: 'ahead',
  }),
  makeContext('compaction', '18:44', 'engine', {
    method: 'summary',
    fromSeq: 25,
    toSeq: 40,
    path: 'compactions/2.md',
    prunedCallIds: [],
    prepared: 'idle',
  }),
  makeContext('compaction', '18:45', 'engine', {
    method: 'remote',
    fromSeq: 41,
    toSeq: 52,
    path: 'compactions/3.md',
    prunedCallIds: [],
  }),
  makeContext('tool_call', '18:43', 'model', {
    callId: 'h1',
    tool: 'history.read',
    args: { callId: 'p3' },
    tier: 'read',
  }),
  makeContext('tool_result', '18:43', 'tool', {
    callId: 'h1',
    status: 'ok',
    summary: '120줄',
    durationMs: 12,
  }),
  makeContext('tool_call', '18:44', 'model', {
    callId: 'e1',
    tool: 'file_edit',
    args: { path: 'README.md', add: 2, del: 1 },
    tier: 'write',
  }),
  makeContext('tool_result', '18:44', 'tool', {
    callId: 'e1',
    status: 'ok',
    summary: '수정함',
    durationMs: 20,
  }),
  makeContext('model_request', '18:45', 'engine', contextUsage(300, 127000, 1100)),
  makeContext('message', '18:45', 'model', {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: 'README 예제 출력을 실제 값으로 맞췄습니다. 이제 `pnpm test -- readme`로 확인하겠습니다.',
      },
    ],
  }),
]);
const contextView: SessionView = finishView({
  record: createRecord(contextId, 'add 함수 버그 수정', 'running', 'math-demo'),
  events: contextEvents,
  todos: mathTodos,
  repoLabel: 'math-demo · main',
  diff: { add: 3, del: 2 },
  statusLine: ['스텝 31/50', '격리 harness'],
});

const compactionDocument = [
  '# 컨텍스트 압축 요약',
  '이 문서가 압축한 이전 대화를 대신한다. 모델이 쓴 절을 뺀 나머지는 엔진이 기록에서 직접 만들었다.',
  '## 사용자 지시 (원문)\n### 지시 1\nmath.js의 add가 뺄셈을 하고 있어요. 고치고 테스트까지 돌려 주세요.\n\n### 지시 2\nREADME 예제도 실제 출력으로 맞춰 주세요.',
  '## todo 상태\n- t1 [verified] math.js의 add를 덧셈으로 고친다\n  - 증거: `node check.js` 종료 코드 0, 통과\n- t2 [attempted] README 예제 출력을 갱신한다\n  - 증거 없음',
  '## 해결하지 못한 오류\n없음',
  '## 결정 기록과 작업 경과\ncheck.js로 검증했고 t1은 끝났다. README 예제는 node examples/sum.js의 실제 출력으로 맞추는 중이다. 출력 형식은 예제 3개 모두 같다.',
].join('\n\n');

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
    statusLine: ['스텝 3/50', '격리 harness'],
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
  statusLine: ['스텝 9/50', '격리 harness'],
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

const rawRepos: RepoNode[] = [
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

interface PhaseTodoDef {
  id: string;
  content: string;
  phase: string;
  command?: string;
}

/**
 * 할 일 패널의 phase 시안 상태를 이벤트 기록으로 만들어 세션 화면 데이터로 돌려줍니다.
 * `run`이 이벤트를 시간순으로 쌓고, 각 할 일의 마지막 스냅샷이 화면의 할 일 목록이 됩니다.
 */
function createPhaseView(
  id: string,
  title: string,
  status: SessionStatus,
  endReason: SessionRecord['endReason'],
  run: (script: PhaseScript) => void,
  approvals: PendingApproval[] = [],
): SessionView {
  const events: OraEvent[] = [];
  const latest: Record<string, Todo> = {};
  const emit = (step: number | null, actor: Actor, type: OraEventType, payload: unknown): void => {
    events.push({
      seq: events.length + 1,
      ts: `${day}T09:${String(events.length % 60).padStart(2, '0')}:00+09:00`,
      sessionId: id,
      actor,
      ...(step === null ? {} : { stepId: `step-${step}` }),
      type,
      payload,
    } as unknown as OraEvent);
  };
  const evidence = (command: string, exitCode: number): Todo['evidence'] => ({
    command,
    exitCode,
    summary: exitCode === 0 ? '통과' : '실패',
    origin: 'model',
    ranAt: `${day}T09:30:00+09:00`,
    scopeDigest: 'sha256:ab12',
  });
  run({
    objective: (text) => {
      emit(null, 'engine', 'objective', { text });
    },
    phase: (name, criterion) => {
      emit(null, 'engine', 'phase', { name, criterion });
    },
    verify: (step, def, exitCode, gate) => {
      emit(step, 'engine', 'verification', {
        todoId: def.id,
        evidence: evidence(def.command ?? '', exitCode),
        ...(gate === undefined ? {} : { gate }),
      });
    },
    raw: (step, actor, type, payload) => {
      emit(step, actor, type, payload);
    },
    update: (step, def, to, options = {}) => {
      const previous = latest[def.id];
      const exitEvidence =
        options.exitCode === undefined
          ? previous?.evidence
          : evidence(def.command ?? '', options.exitCode);
      const patched =
        exitEvidence === undefined ? undefined : { ...exitEvidence, ...options.evidence };
      const todo: Todo = {
        id: def.id,
        content: def.content,
        status: to,
        attempts: previous === undefined ? 0 : previous.attempts + (to === 'attempted' ? 1 : 0),
        writeScope: [],
        phase: def.phase,
        ...(def.command === undefined ? {} : { verify: { command: def.command, origin: 'model' } }),
        ...(options.reason === undefined ? {} : { blockedReason: options.reason }),
        ...(patched === undefined ? {} : { evidence: patched }),
        updatedAt: `${day}T09:30:00+09:00`,
      };
      latest[def.id] = todo;
      emit(step, options.actor ?? 'engine', 'todo_update', {
        todoId: def.id,
        ...(previous === undefined ? {} : { from: previous.status }),
        to,
        todo,
        ...(options.current === undefined ? {} : { current: options.current }),
      });
    },
  });
  const todos = Object.values(latest);
  return finishView(
    {
      record: {
        ...createRecord(id, title, status, 'math-demo'),
        ...(endReason ? { endReason } : {}),
      },
      events,
      todos,
      repoLabel: 'math-demo · main',
      diff: { add: 1, del: 1 },
      statusLine: ['스텝 12/50', '격리 harness'],
    },
    { approvals },
  );
}

interface PhaseScript {
  objective: (text: string) => void;
  phase: (name: string, criterion: string | null) => void;
  verify: (
    step: number,
    def: PhaseTodoDef,
    exitCode: number,
    gate?: { passed: boolean; findings: string[] },
  ) => void;
  raw: (step: number, actor: Actor, type: OraEventType, payload: unknown) => void;
  update: (
    step: number,
    def: PhaseTodoDef,
    to: Todo['status'],
    options?: {
      actor?: Actor;
      reason?: string;
      current?: string | null;
      exitCode?: number;
      evidence?: Partial<NonNullable<Todo['evidence']>>;
    },
  ) => void;
}

const phaseObjective = 'add 함수가 덧셈을 하도록 고치고, 테스트와 README 예제까지 맞춘다';
const findDef: PhaseTodoDef = {
  id: 't1',
  content: 'add가 뺄셈을 하는 줄을 찾는다',
  phase: '원인 찾기',
};
const fixDef: PhaseTodoDef = {
  id: 't2',
  content: 'math.js의 add를 덧셈으로 고친다',
  phase: '수정',
  command: 'node check.js',
};
const negativeDef: PhaseTodoDef = {
  id: 't3',
  content: '음수 입력 검사를 check.js에 더한다',
  phase: '수정',
  command: 'node check.js --neg',
};
const readmeDef: PhaseTodoDef = { id: 't4', content: 'README 예제 출력을 갱신한다', phase: '문서' };
const summaryDef: PhaseTodoDef = { id: 't5', content: '변경 요약을 남긴다', phase: '문서' };

/** 첫 phase를 3스텝에 끝냅니다. 세 시안 상태가 모두 같은 앞부분을 씁니다. */
function runFindPhase(script: PhaseScript): void {
  script.update(1, findDef, 'pending', { current: 't1' });
  script.update(2, findDef, 'attempted');
  script.verify(3, findDef, 0);
  script.update(3, findDef, 'verified', { exitCode: 0, current: 't2' });
}

// 실행 중: 수정 phase를 펼쳐 작업 중 할 일(t3)을 강조합니다. 주소는 `#/session/phases`입니다.
const phasesView = createPhaseView(
  's-20261029-ph4se1',
  'add 함수 버그 수정',
  'running',
  undefined,
  (s) => {
    s.objective(phaseObjective);
    runFindPhase(s);
    s.phase('수정', 'node check.js가 exit 0으로 끝난다');
    s.update(3, fixDef, 'pending');
    s.update(4, fixDef, 'attempted');
    s.verify(5, fixDef, 1);
    s.update(5, fixDef, 'failed', { exitCode: 1 });
    s.update(6, fixDef, 'attempted');
    s.verify(7, fixDef, 0);
    s.update(7, fixDef, 'verified', { exitCode: 0, current: 't3' });
    s.update(7, negativeDef, 'pending');
    s.update(8, negativeDef, 'attempted');
    s.phase('문서', 'README 예제가 실제 출력과 같다');
    s.update(7, readmeDef, 'pending');
    s.update(7, summaryDef, 'pending');
  },
);

// 엔진이 막힘으로 멈춘 세션: 막힌 할 일 두 개와 "이전 N개 보기"로 접힌 흐름. 주소는 `#/session/phase-blocked`입니다.
const phaseBlockedView = createPhaseView(
  's-20261029-ph4se2',
  'add 함수 버그 수정',
  'stopped',
  'blocked',
  (s) => {
    s.objective(phaseObjective);
    runFindPhase(s);
    const appDef: PhaseTodoDef = {
      id: 't4',
      content: 'claude CLI로 실제 응답을 받는다',
      phase: '실제 앱에서 확인',
    };
    const checkDef: PhaseTodoDef = {
      id: 't5',
      content: 'check.js를 통과시킨다',
      phase: '실제 앱에서 확인',
      command: 'node check.js',
    };
    s.update(8, appDef, 'pending');
    s.update(8, checkDef, 'pending');
    s.update(9, appDef, 'attempted');
    s.update(10, appDef, 'blocked', {
      reason: '격리 정책이 claude 실행을 막습니다',
      current: null,
    });
    s.update(11, checkDef, 'attempted');
    s.update(12, checkDef, 'claimed_verified');
    s.verify(13, checkDef, 1);
    s.update(13, checkDef, 'failed', { exitCode: 1 });
    for (const [first, last] of [
      [14, 16],
      [17, 19],
      [20, 22],
    ] as const) {
      s.update(first, checkDef, 'attempted');
      s.update(first + 1, checkDef, 'claimed_verified');
      s.verify(last, checkDef, 1);
      s.update(last, checkDef, 'failed', { exitCode: 1 });
    }
    s.update(22, checkDef, 'blocked', {
      reason: '3번 고쳤지만 검사를 통과하지 못했습니다',
      current: null,
    });
  },
);

// 포기가 섞인 완료: 포기한 할 일에 "포기 취소" 메뉴가 붙습니다. 주소는 `#/session/phase-done`입니다.
const phaseDoneView = createPhaseView(
  's-20261029-ph4se3',
  'add 함수 버그 수정',
  'completed',
  'passed',
  (s) => {
    s.objective(phaseObjective);
    runFindPhase(s);
    s.update(3, fixDef, 'pending');
    s.update(3, negativeDef, 'pending');
    s.update(2, readmeDef, 'pending');
    s.update(4, fixDef, 'attempted');
    s.verify(5, fixDef, 0);
    s.update(5, fixDef, 'verified', { exitCode: 0 });
    s.update(8, negativeDef, 'attempted');
    s.update(9, negativeDef, 'abandoned', { actor: 'user' });
    s.update(9, readmeDef, 'abandoned', { actor: 'user' });
  },
);

const gateDef: PhaseTodoDef = {
  id: 't2',
  content: 'add에 음수 처리 TODO 주석을 남기고 덧셈으로 고친다',
  phase: '수정',
  command: 'node check.js',
};
const gateFinding = 'math.js:2 TODO';
const waiverReason =
  '사용자가 음수 처리를 나중에 하겠다며 TODO 주석을 남기라고 지시했습니다. 구현을 빼먹은 것이 아닙니다.';
const waiverRequest: PendingApproval = {
  requestId: 'req-waiver-1',
  request: {
    callId: 'c-waive',
    tool: 'verify.waive',
    tier: 'exec',
    reason: '게이트가 찾은 TODO는 사용자가 요청한 주석입니다.',
    detail: {
      kind: 'verify_waiver',
      reason: waiverReason,
      findings: ['math.js:2  // TODO: 음수 입력 처리'],
      command: 'node check.js',
      exitCode: 0,
    },
    todo: { id: gateDef.id, content: gateDef.content },
  },
};

/** 게이트가 막은 할 일에 모델이 예외를 요청한 뒤, 사용자의 답(없음, 승인, 거부)까지의 기록을 만듭니다. */
function runGate(script: PhaseScript, answer: 'none' | 'approved' | 'denied'): void {
  script.objective('사용자 요청대로 음수 처리 TODO 주석을 남기고 add를 고친다');
  runFindPhase(script);
  script.phase('수정', 'node check.js가 exit 0으로 끝난다');
  script.update(5, gateDef, 'pending');
  script.update(6, gateDef, 'attempted', { current: 't2' });
  script.verify(7, gateDef, 0, { passed: false, findings: [gateFinding] });
  script.update(7, gateDef, 'failed', {
    exitCode: 0,
    evidence: { gateFindings: [gateFinding] },
  });
  script.raw(8, 'engine', 'approval_request', waiverRequest.request);
  if (answer === 'none') return;
  script.raw(8, 'engine', 'permission', {
    callId: 'c-waive',
    mode: 'always-ask',
    decision: answer,
    scope: 'once',
  });
  if (answer === 'denied') return;
  script.update(8, gateDef, 'verified', {
    evidence: {
      waiver: { reason: waiverReason, approvedBy: 'user', at: `${day}T09:31:00+09:00` },
    },
    current: null,
  });
}

// 예외 요청에 답을 기다리는 세션입니다. 주소는 `#/session/gate-waiver`입니다.
const gateWaiverView = createPhaseView(
  's-20261029-g4te01',
  'add 함수 버그 수정',
  'awaiting_approval',
  undefined,
  (s) => {
    runGate(s, 'none');
  },
  [waiverRequest],
);
// 예외를 승인한 뒤입니다. 주소는 `#/session/gate-approved`입니다.
const gateApprovedView = createPhaseView(
  's-20261029-g4te02',
  'add 함수 버그 수정',
  'completed',
  'passed',
  (s) => {
    runGate(s, 'approved');
  },
);
// 예외를 거부한 뒤입니다. 주소는 `#/session/gate-denied`입니다.
const gateDeniedView = createPhaseView(
  's-20261029-g4te03',
  'add 함수 버그 수정',
  'running',
  undefined,
  (s) => {
    runGate(s, 'denied');
  },
);
const fixtureAvailableTools = [
  'shell',
  'file_read',
  'file_write',
  'file_edit',
  'history.read',
  'github:create_issue',
];
const fixtureUnreadDirectories = ['.agents', '.claude', '.pi', '.omp', '.codex', '.gemini'];
const fixtureRouting: RoutingData = {
  chain: [
    { provider: 'claude', model: 'claude-haiku-5-5', effort: 'medium', hasAccount: true },
    { provider: 'codex', model: 'gpt-5.6-luna', effort: 'low', hasAccount: true },
  ],
  others: [
    { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', hasAccount: true },
    { provider: 'grok', model: 'grok-5', effort: 'medium', hasAccount: false },
  ],
};

const fallbackId = 's-20261028-f4llb1';
const makeFallback = createEventFactory(fallbackId);
const fallbackUsage = {
  uncachedInputTokens: 300,
  cacheReadInputTokens: 6000,
  cacheCreationInputTokens: 0,
  outputTokens: 200,
};
const fallbackRequest = (time: string, model: string, adapter: string, chainPosition: number) =>
  makeFallback('model_request', time, 'engine', {
    model,
    adapter,
    chainPosition,
    role: 'default',
    nativeToolCalls: true,
    usage: fallbackUsage,
    durationMs: 1200,
  });
const fallbackEvents: OraEvent[] = [
  sessionStart(makeFallback),
  ...createStageEvents(makeFallback, 'execute', stageOrder),
  makeFallback('message', '17:30', 'user', {
    role: 'user',
    content: [
      { type: 'text', text: 'math.js의 add가 뺄셈을 하고 있어요. 고치고 테스트까지 돌려 주세요.' },
    ],
  }),
  fallbackRequest('17:31', 'claude-haiku-5-5', 'claude-fetch', 0),
  makeFallback('tool_call', '17:32', 'model', {
    callId: 'f1',
    tool: 'file_read',
    args: { path: 'math.js' },
    tier: 'read',
  }),
  makeFallback('tool_result', '17:32', 'tool', {
    callId: 'f1',
    status: 'ok',
    summary: '12줄',
    durationMs: 8,
  }),
  makeFallback('tool_call', '17:41', 'model', {
    callId: 'f2',
    tool: 'file_edit',
    args: {
      path: 'math.js',
      diff: [
        ['1', '-', 'exports.add = (a, b) => a - b;'],
        ['1', '+', 'exports.add = (a, b) => a + b;'],
      ],
    },
    tier: 'write',
  }),
  makeFallback('tool_result', '17:41', 'tool', {
    callId: 'f2',
    status: 'ok',
    summary: '수정함',
    durationMs: 20,
  }),
  makeFallback('retry', '17:42', 'engine', {
    layer: 'session',
    attempt: 1,
    reason: 'usage-limit',
    message: '429 usage limit reached. resets at 18:10',
    resetAt: `${day}T18:10:00+09:00`,
    delayMs: 0,
    switchedFrom: 'claude-haiku-5-5',
    switchedTo: 'gpt-5.6-luna',
    chainPosition: 1,
    role: 'default',
  }),
  fallbackRequest('17:43', 'gpt-5.6-luna', 'codex', 1),
  makeFallback('message', '17:43', 'model', {
    role: 'assistant',
    content: [{ type: 'text', text: '이어서 `node check.js`로 검증하겠습니다.' }],
  }),
  makeFallback('retry', '18:11', 'engine', {
    layer: 'session',
    attempt: 1,
    reason: 'revert',
    delayMs: 0,
    switchedFrom: 'gpt-5.6-luna',
    switchedTo: 'claude-haiku-5-5',
    chainPosition: 0,
    role: 'default',
  }),
  fallbackRequest('18:12', 'claude-haiku-5-5', 'claude-fetch', 0),
];
const firstRetry = fallbackEvents.findIndex((event) => event.type === 'retry');
const revertRetry = fallbackEvents.findLastIndex((event) => event.type === 'retry');
const createFallbackView = (events: OraEvent[], model: string, effort: string): SessionView => ({
  ...finishView({
    record: createRecord(fallbackId, 'add 함수 버그 수정 (폴백)', 'running', 'math-demo'),
    events,
    todos: mathTodos,
    repoLabel: 'math-demo · main',
    diff: { add: 1, del: 1 },
    statusLine: ['스텝 14/50', '격리 harness'],
  }),
  chips: { model, effort, permission: '승인 생략' },
});
/** 폴백이 일어나기 전 상태입니다. 화면을 연 뒤 800ms가 지나면 `fallbackView`로 바뀌면서 알림이 뜹니다. */
const fallbackStartView = createFallbackView(
  fallbackEvents.slice(0, firstRetry),
  'claude-haiku-5-5',
  'medium',
);
const fallbackView = createFallbackView(
  fallbackEvents.slice(0, revertRetry),
  'gpt-5.6-luna',
  'low',
);

const costUsage = {
  uncachedInputTokens: 300,
  cacheReadInputTokens: 6000,
  cacheCreationInputTokens: 0,
  outputTokens: 200,
};
const createCostEvents = (
  make: ReturnType<typeof createEventFactory>,
  tail: (time: string) => OraEvent[],
): OraEvent[] => [
  sessionStart(make),
  ...createStageEvents(make, 'verify', stageOrder),
  make('message', '11:00', 'user', {
    role: 'user',
    content: [
      { type: 'text', text: 'math.js의 add가 뺄셈을 하고 있어요. 고치고 테스트까지 돌려 주세요.' },
    ],
  }),
  make('model_request', '11:01', 'engine', {
    model: 'claude-haiku-5-5',
    adapter: 'claude-fetch',
    chainPosition: 0,
    role: 'default',
    nativeToolCalls: true,
    usage: costUsage,
    durationMs: 1200,
    costRatioPct: 60,
  }),
  ...tail('11:20'),
];

// 비용 경고: 상한의 80%에 닿은 실행 중 세션입니다. 주소는 `#/session/cost-warn`입니다.
const costWarnId = 's-20261029-c05tw1';
const makeCostWarn = createEventFactory(costWarnId);
const costWarnView: SessionView = finishView({
  record: createRecord(costWarnId, 'add 함수 버그 수정 (비용 경고)', 'running', 'math-demo'),
  events: createCostEvents(makeCostWarn, (time) => [
    makeCostWarn('cost_guard', time, 'engine', { outcome: 'warn', ratioPct: 80 }),
    makeCostWarn('model_request', time, 'engine', {
      model: 'claude-haiku-5-5',
      adapter: 'claude-fetch',
      chainPosition: 0,
      role: 'default',
      nativeToolCalls: true,
      usage: costUsage,
      durationMs: 1200,
      costRatioPct: 80,
    }),
  ]),
  todos: mathTodos,
  repoLabel: 'math-demo · main',
  diff: { add: 1, del: 1 },
  statusLine: ['스텝 18/50', '격리 harness'],
});

// 비용 상한으로 멈춤: 멈춤 카드와 이어 가기 안내가 보입니다. 주소는 `#/session/cost-stop`입니다.
const costStopId = 's-20261029-c05ts1';
const makeCostStop = createEventFactory(costStopId);
const costStopView: SessionView = finishView({
  record: createRecord(costStopId, 'add 함수 버그 수정 (비용 상한)', 'stopped', 'math-demo'),
  events: createCostEvents(makeCostStop, (time) => [
    makeCostStop('cost_guard', time, 'engine', { outcome: 'warn', ratioPct: 80 }),
    makeCostStop('model_request', time, 'engine', {
      model: 'claude-haiku-5-5',
      adapter: 'claude-fetch',
      chainPosition: 0,
      role: 'default',
      nativeToolCalls: true,
      usage: costUsage,
      durationMs: 1200,
      costRatioPct: 100,
    }),
    makeCostStop('cost_guard', time, 'engine', { outcome: 'limit', ratioPct: 100 }),
    makeCostStop('memory', time, 'engine', { learnSkipped: true, reason: 'cost_limit' }),
    makeCostStop('session_end', time, 'engine', {
      status: 'stopped',
      endReason: 'cost_limit',
      summary: '비용 상한의 100%에 닿아 다음 요청을 보내지 않고 멈춥니다.',
    }),
  ]),
  todos: mathTodos,
  repoLabel: 'math-demo · main',
  diff: { add: 1, del: 1 },
  statusLine: ['스텝 22/50', '격리 harness'],
});

/** 시안의 워크트리 탭 상태에 맞춰, 같은 폴더에서 도는 실행 중 세션 하나를 math-demo main에 더하고 워크트리마다 작업 폴더를 정합니다. */
function withCwd(repoName: string, nodes: WorktreeNode[]): WorktreeNode[] {
  return nodes.map((node) => ({
    ...node,
    cwd:
      node.cwd ??
      (node.name === 'main' ? `~/projects/${repoName}` : `~/projects/${repoName}/${node.name}`),
    stack: withCwd(repoName, node.stack),
  }));
}

const repos: RepoNode[] = rawRepos.map((repo) => {
  const [first, ...others] = repo.worktrees;
  const worktrees =
    repo.name === 'math-demo' && first
      ? [
          {
            ...first,
            sessions: [
              ...first.sessions,
              createSession(phasesView.record),
              createSession(fallbackView.record),
              createSession(costWarnView.record),
              createSession(costStopView.record),
            ],
          },
          ...others,
        ]
      : repo.worktrees;
  return { ...repo, worktrees: withCwd(repo.name, worktrees) };
});

const fixtureTerminal: Terminal = {
  id: 't-fixtur1',
  cwd: '~/projects/math-demo',
  status: 'running',
  cols: 100,
  rows: 30,
  createdAt: `${day}T09:30:00+09:00`,
};

const fixtureTabs: Record<string, WorktreeTabs> = {
  '~/projects/math-demo': {
    tabs: [
      { id: 'run1', kind: 'session', sessionId: phasesView.record.id },
      { id: 'fb1', kind: 'session', sessionId: fallbackView.record.id },
      { id: 'appr1', kind: 'session', sessionId: sessionView.record.id },
      { id: 'term1', kind: 'terminal', terminalId: fixtureTerminal.id },
      { id: 'new1', kind: 'new' },
    ],
    activeTabId: 'run1',
  },
};

const fixtureTerminalScript =
  '~/projects/math-demo (main) $ node check.js\r\nok\r\n~/projects/math-demo (main) $ git status --short\r\n \u001b[31mM\u001b[0m \u001b[31mmath.js\u001b[0m\r\n~/projects/math-demo (main) $ ';

// MCP 도구 호출: `MCP 서버:도구 인자` 줄과 서버 장애 기록입니다. 주소는 `#/session/mcp`입니다.
const mcpSessionId = 's-20261030-mcp0e1';
const makeMcp = createEventFactory(mcpSessionId);
const mcpView: SessionView = finishView({
  record: createRecord(mcpSessionId, 'github 이슈 #12 확인 (MCP)', 'running', 'math-demo'),
  events: [
    sessionStart(makeMcp),
    ...createStageEvents(makeMcp, 'research', stageOrder),
    makeMcp('message', '14:00', 'user', {
      role: 'user',
      content: [{ type: 'text', text: 'github 이슈 #12를 읽고 linear 이슈와 비교해 주세요.' }],
    }),
    makeMcp('tool_call', '14:01', 'model', {
      callId: 'm1',
      tool: 'github:get_issue',
      args: { owner: 'ora', number: 12 },
      tier: 'exec',
    }),
    makeMcp('tool_result', '14:01', 'tool', {
      callId: 'm1',
      status: 'ok',
      summary: '#12 add가 뺄셈을 한다',
      durationMs: 320,
    }),
    makeMcp('mcp_server', '14:02', 'engine', {
      server: 'linear',
      outcome: 'failed',
      reason: '연결 시간 초과(10초).',
    }),
  ],
  todos: mathTodos,
  repoLabel: 'math-demo · main',
  diff: null,
  statusLine: ['스텝 4/50', '격리 harness'],
});

// 스킬 본문을 회상 팩에 넣은 대화와 설정 › 스킬 시안입니다. 주소는 `#/session/skills`, `#/settings/skills`입니다.
const skillsSessionId = 's-20261030-skl0e1';
const makeSkills = createEventFactory(skillsSessionId);
const skillsView: SessionView = finishView({
  record: createRecord(skillsSessionId, 'add 함수 버그 수정', 'running', 'math-demo'),
  events: [
    sessionStart(makeSkills),
    ...createStageEvents(makeSkills, 'research', stageOrder),
    makeSkills('message', '14:00', 'user', {
      role: 'user',
      content: [{ type: 'text', text: 'math.js의 add가 뺄셈을 하고 있어요. 고쳐 주세요.' }],
    }),
    makeSkills('recall', '14:00', 'engine', {
      lessonIds: [],
      skills: [{ name: 'bugfix-checklist', scope: 'project' }],
      candidateSkills: [{ name: 'readme-examples', scope: 'project' }],
      tokenCount: 180,
    }),
  ],
  todos: mathTodos,
  repoLabel: 'math-demo · main',
  diff: null,
  statusLine: ['스텝 1/50', '격리 harness'],
});

// 다른 모델의 검토 카드와 할 일 패널의 "검토 지적 2"입니다. 주소는 `#/session/review`입니다.
const reviewSessionId = 's-20261030-rev0e1';
const makeReview = createEventFactory(reviewSessionId);
const reviewTodos: Todo[] = [
  {
    id: 't2',
    content: 'math.js의 add를 덧셈으로 고친다',
    status: 'attempted',
    attempts: 2,
    writeScope: ['math.js'],
    phase: '수정',
    verify: { command: 'node check.js', origin: 'repo' },
    evidence: {
      command: 'node check.js',
      exitCode: 0,
      summary: 'ok',
      origin: 'repo',
      ranAt: `${day}T09:05:00+09:00`,
      scopeDigest: 'sha256:ab12',
      review: {
        model: 'gpt-5.6-luna',
        verdict: 'changes',
        findings: [
          {
            severity: 'major',
            text: 'check.js가 음수 입력을 검사하지 않아 a - b로 되돌려도 통과할 수 있습니다.',
            location: 'check.js:4',
          },
          {
            severity: 'minor',
            text: 'README 예제의 출력이 바뀐 동작과 다릅니다.',
            location: 'README.md:18',
          },
        ],
      },
    },
    updatedAt: `${day}T09:05:00+09:00`,
  },
  {
    id: 't3',
    content: '음수 입력 검사를 check.js에 더한다',
    status: 'pending',
    attempts: 0,
    writeScope: ['check.js'],
    phase: '수정',
    updatedAt: `${day}T09:00:00+09:00`,
  },
];
const reviewView: SessionView = finishView({
  record: createRecord(
    reviewSessionId,
    'add 함수 버그 수정 (다른 모델 검토)',
    'running',
    'math-demo',
  ),
  events: [
    sessionStart(makeReview),
    ...createStageEvents(makeReview, 'verify', stageOrder),
    makeReview('message', '14:00', 'user', {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'math.js의 add가 뺄셈을 하고 있어요. 고치고, 다른 모델 검토까지 받아 주세요.',
        },
      ],
    }),
    makeReview('todo_update', '14:01', 'engine', {
      todoId: 't2',
      from: 'pending',
      to: 'attempted',
      todo: {
        id: 't2',
        content: 'math.js의 add를 덧셈으로 고친다',
        status: 'attempted',
        attempts: 1,
        writeScope: ['math.js'],
        phase: '수정',
        verify: { command: 'node check.js', origin: 'repo' },
        updatedAt: `${day}T09:05:00+09:00`,
      },
    }),
    makeReview('tool_call', '14:01', 'model', {
      callId: 'r1',
      tool: 'file_edit',
      args: { path: 'math.js', oldText: 'return a - b;', newText: 'return a + b;' },
      tier: 'write',
    }),
    makeReview('tool_result', '14:01', 'tool', {
      callId: 'r1',
      status: 'ok',
      summary: '+1 −1',
      durationMs: 12,
    }),
    makeReview('tool_call', '14:02', 'model', {
      callId: 'r2',
      tool: 'verify.run',
      args: { todoId: 't2' },
      tier: 'exec',
    }),
    makeReview('tool_result', '14:02', 'tool', {
      callId: 'r2',
      status: 'ok',
      summary: 'exit 0',
      durationMs: 480,
    }),
    makeReview('review', '14:02', 'engine', {
      outcome: 'completed',
      todoId: 't2',
      model: 'gpt-5.6-luna',
      verdict: 'changes',
      findings: [
        {
          severity: 'major',
          text: 'check.js가 음수 입력을 검사하지 않아 a - b로 되돌려도 통과할 수 있습니다.',
          location: 'check.js:4',
        },
        {
          severity: 'minor',
          text: 'README 예제의 출력이 바뀐 동작과 다릅니다.',
          location: 'README.md:18',
        },
      ],
    }),
    makeReview('message', '14:03', 'model', {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: '검토가 짚은 대로 `check.js`에 음수 입력 검사를 더하고, README 예제도 맞추겠습니다.',
        },
      ],
    }),
  ],
  todos: reviewTodos,
  repoLabel: 'math-demo · main',
  diff: null,
  statusLine: ['스텝 18/50', '격리 harness'],
});

// 검토할 다른 모델이 없어 건너뛴 대화입니다. 주소는 `#/session/review-skipped`입니다.
const reviewSkippedId = 's-20261030-rev0e2';
const makeReviewSkipped = createEventFactory(reviewSkippedId);
const reviewSkippedView: SessionView = finishView({
  record: createRecord(reviewSkippedId, 'add 함수 버그 수정 (검토 건너뜀)', 'running', 'math-demo'),
  events: [
    sessionStart(makeReviewSkipped),
    ...createStageEvents(makeReviewSkipped, 'verify', stageOrder),
    makeReviewSkipped('message', '14:00', 'user', {
      role: 'user',
      content: [{ type: 'text', text: 'math.js의 add가 뺄셈을 하고 있어요. 고쳐 주세요.' }],
    }),
    makeReviewSkipped('review', '14:02', 'engine', {
      outcome: 'skipped',
      todoId: 't1',
      reason: '실행 모델과 다른 검토 모델이 없어 검토를 건너뛰었습니다.',
    }),
  ],
  todos: mathTodos,
  repoLabel: 'math-demo · main',
  diff: null,
  statusLine: ['스텝 6/50', '격리 harness'],
});

const fixtureSkills: SkillsData = {
  status: 'ready',
  list: {
    projectName: 'math-demo',
    project: [
      {
        name: 'bugfix-checklist',
        description: '버그를 고치기 전에 재현 명령을 먼저 만들고, 고친 뒤 같은 명령으로 확인한다.',
        scope: 'project',
        isShadowed: false,
        useCount: 3,
        lastUsedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      },
      {
        name: 'readme-examples',
        description: 'README 예제를 바꾸면 실제 실행 출력과 대조한다.',
        scope: 'project',
        isShadowed: false,
        useCount: 0,
      },
    ],
    global: [
      {
        name: 'korean-commit',
        description: '커밋 메시지를 한국어 한 줄 제목과 본문으로 쓴다.',
        scope: 'global',
        isShadowed: false,
        useCount: 12,
        lastUsedAt: new Date(Date.now() - 26 * 3_600_000).toISOString(),
      },
      {
        name: 'bugfix-checklist',
        description: '버그 수정 절차의 전역 판입니다.',
        scope: 'global',
        isShadowed: true,
        useCount: 0,
      },
    ],
    recent: [
      {
        sessionId: skillsSessionId,
        title: 'add 함수 버그 수정',
        at: new Date(Date.now() - 2 * 60_000).toISOString(),
        injected: [{ name: 'bugfix-checklist', scope: 'project' }],
        candidates: [],
      },
      {
        sessionId: 's-20261030-rdm0e1',
        title: 'README 예제 출력 갱신',
        at: new Date(Date.now() - 5 * 60_000).toISOString(),
        injected: [],
        candidates: [{ name: 'readme-examples', scope: 'project' }],
      },
    ],
  },
};
// 대화 끝에 메모리를 저장한 시안입니다. 주소는 `#/session/memory-saved`입니다. 설정 › 메모리 시안은 `#/settings/memory`입니다.
const memorySessionId = 's-20261030-mem0e1';
const makeMemory = createEventFactory(memorySessionId);
const memorySavedView: SessionView = finishView({
  record: createRecord(memorySessionId, 'add 함수 버그 수정', 'running', 'math-demo'),
  events: [
    sessionStart(makeMemory),
    ...createStageEvents(makeMemory, 'learn', stageOrder),
    makeMemory('message', '14:00', 'user', {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'math.js의 add가 뺄셈을 하고 있어요. 고치고 테스트까지 돌려 주세요.',
        },
      ],
    }),
    makeMemory('message', '14:06', 'model', {
      role: 'assistant',
      content: [{ type: 'text', text: '`add`를 덧셈으로 고쳤고, `node check.js`가 통과했습니다.' }],
    }),
    makeMemory('memory_saved', '14:07', 'engine', {
      lessonId: 'L-20261030-001',
      text: 'math-demo의 검증 명령은 node check.js이고, 음수 입력도 확인한다.',
      isUnsourced: false,
    }),
    makeMemory('memory_saved', '14:07', 'engine', {
      lessonId: 'L-20261029-002',
      text: '이 저장소의 테스트는 pnpm check 한 번으로 모두 돈다.',
      isUnsourced: true,
    }),
  ],
  todos: mathTodos,
  repoLabel: 'math-demo · main',
  diff: null,
  statusLine: ['스텝 9/50', '격리 harness'],
});

const fixtureMemory: MemoryData = {
  status: 'ready',
  list: {
    projectName: 'math-demo',
    project: [
      {
        id: 'L-20261030-001',
        text: 'math-demo의 검증 명령은 node check.js이고, 음수 입력도 확인한다.',
        scope: 'project',
        savedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        sessionId: memorySessionId,
        sessionTitle: 'add 함수 버그 수정',
        useCount: 3,
        isUnsourced: false,
        isStale: false,
      },
      {
        id: 'L-20261029-002',
        text: '이 저장소의 테스트는 pnpm check 한 번으로 모두 돈다.',
        scope: 'project',
        savedAt: new Date(Date.now() - 26 * 3_600_000).toISOString(),
        sessionTitle: 'README 예제 출력 갱신',
        useCount: 0,
        isUnsourced: true,
        isStale: false,
      },
      {
        id: 'L-20261027-003',
        text: 'README 예제는 실제 실행 출력과 대조한 뒤에 고친다.',
        scope: 'project',
        savedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        sessionTitle: '문서 갱신',
        useCount: 5,
        isUnsourced: false,
        isStale: false,
      },
    ],
    global: [
      {
        id: 'L-20261029-004',
        text: '사용자는 커밋 메시지를 한국어로 쓰기를 원한다.',
        scope: 'global',
        savedAt: new Date(Date.now() - 26 * 3_600_000).toISOString(),
        sessionTitle: 'ora 엔진 작업',
        useCount: 12,
        isUnsourced: false,
        isStale: false,
      },
      {
        id: 'L-20260728-005',
        text: 'node 18에서는 fetch 실험 경고가 나오므로 출력 비교에서 뺀다.',
        scope: 'global',
        savedAt: new Date(Date.now() - 94 * 86_400_000).toISOString(),
        sessionTitle: 'notes 작업',
        useCount: 0,
        isUnsourced: false,
        isStale: true,
      },
    ],
    deletedIds: [],
    archivedIds: [],
    lastPass: {
      at: new Date(new Date().setHours(3, 12, 0, 0)).toISOString(),
      outcome: 'ok',
      merged: 2,
      rewritten: 1,
      archived: 1,
      flagged: 1,
      skippedBatches: 0,
    },
    isTidying: false,
  },
};

const detailedViews = new Map<string, SessionView>(
  [
    sessionView,
    questionView,
    crashedView,
    contextView,
    phasesView,
    phaseBlockedView,
    phaseDoneView,
    gateWaiverView,
    gateApprovedView,
    gateDeniedView,
    fallbackView,
    costWarnView,
    costStopView,
    mcpView,
    skillsView,
    memorySavedView,
    reviewView,
    reviewSkippedView,
  ].map((view) => [view.record.id, view]),
);

// 시안을 주소로 열 수 있도록 개발용 별칭(#/question 등)도 세션 ID처럼 받습니다.
const devAliases = new Map<string, string>([
  ['question', questionView.record.id],
  ['crashed', crashedView.record.id],
  ['context', contextView.record.id],
  ['phases', phasesView.record.id],
  ['phase-blocked', phaseBlockedView.record.id],
  ['phase-done', phaseDoneView.record.id],
  ['gate-waiver', gateWaiverView.record.id],
  ['gate-approved', gateApprovedView.record.id],
  ['gate-denied', gateDeniedView.record.id],
  ['fallback', fallbackView.record.id],
  ['cost-warn', costWarnView.record.id],
  ['cost-stop', costStopView.record.id],
  ['mcp', mcpView.record.id],
  ['skills', skillsView.record.id],
  ['memory-saved', memorySavedView.record.id],
  ['review', reviewView.record.id],
  ['review-skipped', reviewSkippedView.record.id],
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

type StatefulActionName =
  | 'refreshAccounts'
  | 'startLogin'
  | 'cancelLogin'
  | 'addApiKey'
  | 'logoutAccount'
  | 'setAccountPriority'
  | 'refreshCostSettings'
  | 'saveCostSettings'
  | 'refreshEngineSettings'
  | 'saveGeneralSettings'
  | 'saveModelSettings'
  | 'savePermissionSettings'
  | 'saveIsolationSettings'
  | 'deleteApprovalRule'
  | 'refreshMemory'
  | 'deleteMemory'
  | 'tidyMemory'
  | 'refreshMcpServers'
  | 'addMcpServer'
  | 'setMcpServerEnabled'
  | 'removeMcpServer'
  | 'reconnectMcpServer'
  | 'loadTabs'
  | 'loadChanges'
  | 'saveTabs'
  | 'createTerminal'
  | 'killTerminal'
  | 'sendTerminalInput'
  | 'resizeTerminal'
  | 'watchTerminal';

const fixtureActions: Omit<OraActions, StatefulActionName> = {
  createSession: () => Promise.resolve(sessionView.record.id),
  sendMessage: () => Promise.resolve(),
  cancelRun: () => Promise.resolve(),
  decideApproval: () => Promise.resolve(),
  answerQuestions: () => Promise.resolve(),
  resumeSession: () => Promise.resolve(),
  abandonTodo: () => Promise.resolve(true),
  restoreTodo: () => Promise.resolve(true),
  readCompaction: () => Promise.resolve(compactionDocument),
  dismissError: () => undefined,
  refreshSkills: () => Promise.resolve(),
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
  const worktreeNames = new Map(listWorktrees(repos).map(({ cwd, node }) => [cwd, node.name]));
  const liveViews = new Map<string, SessionView>([[fallbackId, fallbackStartView]]);
  const noChanges: ChangesResponse = { isRepo: true, files: [] };
  const fixtureChanges: Record<string, ChangesResponse> = {
    '~/projects/math-demo': {
      isRepo: true,
      files: [
        { path: 'math.js', add: 1, del: 1 },
        { path: 'check.js', add: 4, del: 0 },
      ],
    },
  };

  const listeners = new Set<() => void>();
  let accounts = fixtureAccounts;
  let costSettings: CostSettingsData = {
    status: 'ready',
    settings: {
      maxCost: 5,
      warnCost: 4,
      pricing: { 'claude/claude-haiku-5-5': { inputPerMTok: 1, outputPerMTok: 5 } },
    },
  };
  // 설정 › 일반, 모델, 권한, 격리 시안입니다. 주소는 `#/settings/general`, `#/settings/keys`, `#/settings/models`, `#/settings/permissions`, `#/settings/isolation`입니다.
  const ready = <T>(value: T): { status: 'ready'; value: T } => ({ status: 'ready', value });
  let engineSettings: EngineSettingsData = {
    general: ready({
      maxSteps: 50,
      maxRepairsPerTodo: 3,
      noProgressSteps: 5,
      maxConcurrentSessions: 4,
      isReviewEnabled: false,
      compactAtRatio: 0.8,
      isIdleSummaryEnabled: false,
    }),
    models: ready({
      roles: {
        default: ['claude/claude-haiku-5-5:medium', 'codex/gpt-5.6-luna:low'],
        review: ['codex/gpt-5.6-luna:low', 'claude/claude-haiku-5-5:low'],
      },
      revertPolicy: 'cooldown-expiry',
    }),
    permissions: ready({
      mode: 'bypass-permissions',
      tools: { shell: 'prompt', 'github:create_issue': 'deny' },
      restrictedFolders: ['/Users/me/projects/math-demo/secrets'],
      availableTools: fixtureAvailableTools,
    }),
    isolation: ready({
      isolation: 'harness',
      runningSessionCount: 2,
      unreadDirectories: fixtureUnreadDirectories,
    }),
    approvalRules: ready({
      rules: [
        {
          key: 'rule-1',
          rule: { tool: 'shell', command: 'node check.js', cwd: '~/projects/math-demo' },
        },
        {
          key: 'rule-2',
          rule: {
            tool: 'verify.run',
            command: 'pnpm test -- readme',
            cwd: '~/projects/math-demo',
          },
        },
      ],
    }),
  };
  const changeEngineSettings = (change: Partial<EngineSettingsData>): Promise<void> => {
    engineSettings = { ...engineSettings, ...change };
    snapshot = { ...snapshot, engineSettings };
    listeners.forEach((listener) => {
      listener();
    });
    return Promise.resolve();
  };
  // 설정 › MCP 시안의 세 서버입니다. 주소는 `#/settings/mcp`입니다.
  let mcpServers: McpServersData = {
    status: 'ready',
    servers: [
      {
        name: 'github',
        transport: 'stdio',
        target: 'npx -y @modelcontextprotocol/server-github',
        envRefs: ['GITHUB_TOKEN'],
        enabled: true,
        state: 'connected',
        toolCount: 26,
        enabledToolCount: 26,
      },
      {
        name: 'linear',
        transport: 'http',
        target: 'https://mcp.linear.app/mcp',
        envRefs: [],
        enabled: true,
        state: 'unreachable',
        toolCount: 18,
        enabledToolCount: 0,
        lastFailure: { at: '2026-10-30T14:02:00+09:00', reason: '연결 시간 초과(10초).' },
      },
      {
        name: 'notes',
        transport: 'stdio',
        target: 'node ~/tools/notes-mcp.js',
        envRefs: [],
        enabled: false,
        state: 'disabled',
        enabledToolCount: 0,
      },
    ],
  };
  const changeMcpServers = (
    change: (servers: McpServerStatus[]) => McpServerStatus[],
  ): Promise<void> => {
    mcpServers = { status: 'ready', servers: change(mcpServers.servers) };
    snapshot = { ...snapshot, mcpServers };
    listeners.forEach((listener) => {
      listener();
    });
    return Promise.resolve();
  };
  let memory: MemoryData = fixtureMemory;
  const changeMemory = (list: NonNullable<MemoryData['list']>) => {
    memory = { status: 'ready', list };
    snapshot = { ...snapshot, memory };
    listeners.forEach((listener) => {
      listener();
    });
  };
  let snapshot: OraStore;

  const tabsByCwd = new Map(Object.entries(fixtureTabs));
  const terminalsById = new Map([[fixtureTerminal.id, fixtureTerminal]]);
  let terminalCount = 0;

  const commit = (next: ProviderAccounts[]) => {
    accounts = { ...accounts, providers: next };
    snapshot = { ...snapshot, accounts };
    listeners.forEach((listener) => {
      listener();
    });
  };
  const refresh = () => {
    snapshot = { ...snapshot };
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
    loadTabs: (cwd) => {
      if (!tabsByCwd.has(cwd)) tabsByCwd.set(cwd, { tabs: [] });
      refresh();
      return Promise.resolve();
    },
    loadChanges: () => Promise.resolve(),
    saveTabs: (cwd, next) => {
      tabsByCwd.set(cwd, next);
      refresh();
      return Promise.resolve();
    },
    createTerminal: (cwd, size) => {
      terminalCount += 1;
      const id = `t-new${String(terminalCount).padStart(5, '0')}`;
      terminalsById.set(id, {
        id,
        cwd,
        status: 'running',
        ...size,
        createdAt: new Date().toISOString(),
      });
      refresh();
      return Promise.resolve(id);
    },
    killTerminal: (id) => {
      terminalsById.delete(id);
      refresh();
      return Promise.resolve();
    },
    sendTerminalInput: () => Promise.resolve(),
    resizeTerminal: () => Promise.resolve(),
    watchTerminal: (_id, handlers) => {
      const timer = setTimeout(() => {
        handlers.onOutput(new TextEncoder().encode(fixtureTerminalScript));
      }, 0);
      return () => {
        clearTimeout(timer);
      };
    },
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
    refreshCostSettings: () => Promise.resolve(),
    refreshMemory: () => Promise.resolve(),
    deleteMemory: (id) => {
      const list = memory.list;
      if (list === undefined) return Promise.resolve();
      changeMemory({
        ...list,
        project: list.project.filter((item) => item.id !== id),
        global: list.global.filter((item) => item.id !== id),
        deletedIds: [...list.deletedIds, id],
      });
      return Promise.resolve();
    },
    tidyMemory: () => {
      const list = memory.list;
      if (list === undefined) return Promise.resolve();
      changeMemory({
        ...list,
        lastPass: {
          at: new Date().toISOString(),
          outcome: 'ok',
          merged: 0,
          rewritten: 0,
          archived: 0,
          flagged: 0,
          skippedBatches: 0,
        },
      });
      return Promise.resolve();
    },
    refreshMcpServers: () => Promise.resolve(),
    addMcpServer: (body) =>
      changeMcpServers((servers) => [
        ...servers,
        {
          name: body.name,
          transport: body.transport,
          target: body.command ?? body.url ?? '',
          envRefs: body.envRefs,
          enabled: true,
          state: 'connected',
          toolCount: 0,
          enabledToolCount: 0,
        },
      ]),
    setMcpServerEnabled: (name, enabled) =>
      changeMcpServers((servers) =>
        servers.map((server) =>
          server.name === name
            ? { ...server, enabled, state: enabled ? 'connected' : 'disabled' }
            : server,
        ),
      ),
    removeMcpServer: (name) =>
      changeMcpServers((servers) => servers.filter((server) => server.name !== name)),
    reconnectMcpServer: (name) =>
      changeMcpServers((servers) =>
        servers.map((server) =>
          server.name === name
            ? {
                ...server,
                state: 'connected',
                enabledToolCount: server.toolCount ?? 0,
                lastFailure: undefined,
              }
            : server,
        ),
      ),
    saveCostSettings: (next) => {
      costSettings = { status: 'ready', settings: next };
      snapshot = { ...snapshot, costSettings };
      listeners.forEach((listener) => {
        listener();
      });
      return Promise.resolve();
    },
    refreshEngineSettings: () => Promise.resolve(),
    saveGeneralSettings: (next) => changeEngineSettings({ general: ready(next) }),
    saveModelSettings: (next) => changeEngineSettings({ models: ready(next) }),
    savePermissionSettings: (next) =>
      changeEngineSettings({
        permissions: ready({ ...next, availableTools: fixtureAvailableTools }),
      }),
    saveIsolationSettings: (next) =>
      changeEngineSettings({
        isolation: ready({
          ...next,
          runningSessionCount: 2,
          unreadDirectories: fixtureUnreadDirectories,
        }),
      }),
    deleteApprovalRule: (key) =>
      changeEngineSettings({
        approvalRules: ready({
          rules: (engineSettings.approvalRules.value?.rules ?? []).filter(
            (entry) => entry.key !== key,
          ),
        }),
      }),
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
    sessionsWithoutFolder: [],
    getBranch: (cwd) => worktreeNames.get(cwd),
    getDefaultBranch: (cwd) => (worktreeNames.has(cwd) ? 'main' : undefined),
    getChanges: (cwd) => fixtureChanges[cwd] ?? (worktreeNames.has(cwd) ? noChanges : undefined),
    getNewSessionContext: (cwd = '~/Desktop/ora') => ({
      path: cwd,
      branch: worktreeNames.get(cwd),
      chips: designChips,
    }),
    empty: { repos: ['math-demo', 'ora', 'notes'], branches: ['main'], chips: designChips },
    routing: fixtureRouting,
    defaultSessionId: sessionView.record.id,
    getTabs: (cwd) => tabsByCwd.get(cwd),
    getTerminal: (id) => terminalsById.get(id),
    getSession: (sessionId) => {
      const id = devAliases.get(sessionId) ?? sessionId;
      return liveViews.get(id) ?? detailedViews.get(id) ?? plainViews.get(id);
    },
    watchSession: (id) => {
      if (id !== fallbackId || liveViews.get(id) === fallbackView) return () => undefined;
      const timer = setTimeout(() => {
        liveViews.set(id, fallbackView);
        refresh();
      }, 800);
      return () => {
        clearTimeout(timer);
      };
    },
    actions,
    accounts,
    costSettings,
    engineSettings,
    mcpServers,
    skills: fixtureSkills,
    memory,
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
