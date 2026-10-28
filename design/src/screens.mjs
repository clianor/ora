// M1 화면 시안의 목록. 프레임 하나가 화면 하나이고, 이름 앞 번호는 design/ora.fig의 순서다.
// render 도구에 jsx()의 결과를 넘기고, export_image 결과를 design/previews/<file>.png로 저장한다.
import { componentBoard } from './components.mjs';
import {
  I,
  SP,
  T,
  approvalCard,
  button,
  code,
  composer,
  diffBlock,
  evidence,
  header,
  mono,
  palette,
  reply,
  sidebar,
  thread,
  toolLine,
  userBubble,
  windowFrame,
} from './kit.mjs';

const REPOS = [
  {
    repo: 'ora',
    worktrees: [
      { name: 'main', add: 4, del: 0 },
      {
        name: 'feat/engine-slice2',
        add: 1930,
        del: 350,
        sessions: [{ title: '엔진 슬라이스 2 구현', meta: '검증 3/3, 완료', dot: 'ok' }],
      },
    ],
  },
  {
    repo: 'math-demo',
    worktrees: [
      {
        name: 'main',
        add: 1,
        del: 1,
        sessions: [{ title: 'add 함수 버그 수정', meta: '승인 대기', dot: 'warn' }],
      },
      {
        name: 'docs/readme-pnpm',
        add: 12,
        del: 3,
        sessions: [{ title: 'README 설치 절차 갱신', meta: '검증 2/2, 완료', dot: 'ok' }],
        stack: [
          {
            name: 'docs/readme-examples',
            add: 5,
            del: 1,
            sessions: [{ title: 'README 예제 실행 확인', meta: '검증 1/2', dot: 'warn' }],
          },
        ],
      },
    ],
  },
  {
    repo: 'notes',
    worktrees: [
      {
        name: 'main',
        add: 0,
        del: 0,
        sessions: [{ title: '검색 도구 타임아웃 조사', meta: '실패, 1시간 전', dot: 'del' }],
      },
    ],
  },
];

/** 사이드바 예시 데이터에 선택 상태를 입힌다. worktree는 'repo/이름', patch는 세션 제목별로 덮어쓸 값이다. */
function repos({ worktree = null, session = null, patch = {} } = {}) {
  const mark = (repo) => (w) => ({
    ...w,
    selected: `${repo}/${w.name}` === worktree,
    sessions: (w.sessions ?? []).map((s) => ({
      ...s,
      ...patch[s.title],
      selected: s.title === session,
    })),
    stack: (w.stack ?? []).map(mark(repo)),
  });
  return REPOS.map((g) => ({ ...g, worktrees: g.worktrees.map(mark(g.repo)) }));
}
const STATUS = [['스텝 12/50'], ['기본 모델 사용 중'], ['격리 harness']];

function sessionMain(c) {
  return (
    header(c, { title: 'add 함수 버그 수정', repo: 'math-demo · main', stage: 4, diff: [1, 1] }) +
    thread(
      c,
      [
        userBubble(c, 'math.js의 add가 뺄셈을 하고 있어요. 고치고 테스트까지 돌려 주세요.'),
        `<Frame w="fill" h="hug" flex="col" gap={4}>${toolLine(c, { icon: 'file-text', verb: '읽기', target: 'math.js' })}${toolLine(c, { icon: 'file-pen', verb: '수정', target: 'math.js', add: 1, del: 1 })}${diffBlock(
          c,
          [
            ['1', '-', 'exports.add = (a, b) => a - b;'],
            ['1', '+', 'exports.add = (a, b) => a + b;'],
          ],
        )}</Frame>`,
        reply(
          c,
          `${code(c, 'add')}가 뺄셈 부호를 쓰고 있어서 덧셈으로 고쳤습니다. 이제 저장소에 있는 ${code(c, 'check.js')}로 검증하겠습니다.`,
        ),
        approvalCard(c),
      ],
      { composerOptions: { running: true }, status: STATUS },
    )
  );
}
const SESSION_TODOS = [
  {
    id: 't1',
    title: 'math.js의 add를 덧셈으로 고친다',
    status: 'attempted',
    origin: 'model',
    cmd: '$ node check.js',
    result: '승인 대기',
  },
  {
    id: 't2',
    title: 'README 예제 출력을 갱신한다',
    status: 'verified',
    origin: 'repo',
    cmd: '$ pnpm test -- readme',
    result: 'exit 0',
    resultColor: 'ok',
  },
  { id: 't3', title: '변경 요약을 남긴다', status: 'pending' },
];

function sessionScreen() {
  const c = palette('Dark');
  return windowFrame(c, '02 Session · Dark', {
    side: sidebar(c, { groups: repos({ session: 'add 함수 버그 수정' }) }),
    main: sessionMain(c),
    panel: evidence(c, { todos: SESSION_TODOS, current: 't1' }),
  });
}

/** 질문 카드. 질문이 여러 개면 위쪽 탭으로 오가고, 선택지는 하나만 고르거나 여러 개를 고르는 두 가지다. */
function questionCard(c) {
  const tab = (label, state) => {
    if (state === 'done')
      return `<Frame w="hug" h={26} flex="row" items="center" gap={6} px={10} rounded={6}>${I(c, 'circle-check', 'ok', 13)}${T(c, 12, 16, 500, 'ink2', label)}</Frame>`;
    return `<Frame w="hug" h={26} flex="row" items="center" gap={6} px={10} rounded={6} bg="${c.window}">${T(c, 12, 16, 600, 'ink3', '2', '', mono)}${T(c, 12, 16, 600, 'ink', label)}</Frame>`;
  };
  const option = (
    n,
    title,
    desc,
    { checked, focused },
  ) => `<Frame w="fill" h="hug" flex="row" items="center" gap={12} px={12} py={10} rounded={10} bg="${focused ? c.hover : c.raised}" ${focused ? `stroke="${c.ring}" strokeWidth={2} strokeAlign="inside"` : ''}>
${I(c, checked ? 'square-check' : 'square', checked ? 'ink' : 'ink3', 18)}
<Frame w="fill" h="hug" flex="col" gap={2}>${T(c, 14, 20, 500, 'ink', title)}${T(c, 12, 16, 400, 'ink3', desc)}</Frame>
${T(c, 12, 16, 500, 'ink3', String(n), '', mono)}</Frame>`;
  return `<Frame name="Question" w="fill" h="hug" flex="col" gap={12} p={16} rounded={14} bg="${c.raised}">
<Frame w="fill" h="hug" flex="row" items="center" gap={4}>${I(c, 'message-circle-question', 'ink2', 16)}<Frame w={4} h={1} />${tab('타임아웃 기준', 'done')}${tab('조사 범위', 'current')}${SP}${T(c, 12, 16, 500, 'warn', '답변 대기')}</Frame>
<Frame w="fill" h="hug" flex="col" gap={2}>${T(c, 14, 20, 600, 'ink', '어디까지 조사할까요?')}${T(c, 12, 18, 400, 'ink3', '여러 개를 고를 수 있습니다. 첫 질문의 답은 30초입니다.')}</Frame>
<Frame w="fill" h="hug" flex="col" gap={6}>
${option(1, '검색 도구 코드', 'src/search.ts와 호출하는 쪽을 읽습니다', { checked: true, focused: false })}
${option(2, 'MCP 서버 설정', '서버별 타임아웃과 재시도 값을 확인합니다', { checked: true, focused: true })}
${option(3, '네트워크 기록', '느린 요청이 실제로 있었는지 로그로 확인합니다', { checked: false, focused: false })}
<Frame w="fill" h={40} flex="row" items="center" gap={10} px={12} rounded={10} bg="${c.window}">${I(c, 'pencil', 'ink3', 14)}${T(c, 13, 18, 400, 'ink3', '직접 입력합니다')}</Frame>
</Frame>
<Frame w="fill" h="hug" flex="row" items="center" gap={8}>${T(c, 12, 16, 400, 'ink3', '2개 골랐습니다. Space로 고르고 Enter로 보냅니다')}${SP}${button(c, 'ghost', '이전 질문')}${button(c, 'primary', '답 보내기', { keyHint: '↵' })}</Frame>
</Frame>`;
}

function questionScreen() {
  const c = palette('Dark');
  const search = {
    query: '타임아웃',
    filters: ['전체', '실행 중', '답변 대기', '승인 대기', '실패', '완료'],
    filter: '전체',
    summary: '세션 2개에서 찾았습니다',
  };
  const groups = [
    {
      repo: 'notes',
      worktrees: [
        {
          name: 'main',
          add: 0,
          del: 0,
          sessions: [
            {
              title: '검색 도구 타임아웃 조사',
              meta: '답변 대기, 제목 일치',
              selected: true,
              dot: 'warn',
            },
            { title: 'MCP 연결 끊김 조사', meta: '완료, 3일 전, 할 일 일치', dot: 'ok' },
          ],
        },
      ],
    },
  ];
  const main =
    header(c, { title: '검색 도구 타임아웃 조사', repo: 'notes · main', stage: 0 }) +
    thread(
      c,
      [
        userBubble(c, '검색 도구가 가끔 타임아웃으로 끝나요. 원인을 찾아 주세요.'),
        `<Frame w="fill" h="hug" flex="col" gap={4}>${toolLine(c, { icon: 'file-text', verb: '읽기', target: 'src/search.ts' })}${toolLine(c, { icon: 'search', verb: '검색', target: 'timeout' })}</Frame>`,
        reply(
          c,
          '검색 도구 호출이 기대보다 오래 걸려 실패하는 원인을 찾는 작업으로 이해했습니다. 시작하기 전에 두 가지를 정해야 합니다.',
        ),
        questionCard(c),
      ],
      {
        composerOptions: { placeholder: '질문에 답하거나, 다른 내용을 적어 보냅니다' },
        status: [['스텝 3/50'], ['기본 모델 사용 중'], ['격리 harness']],
      },
    );
  return windowFrame(c, '03 Question · Dark', {
    side: sidebar(c, { groups, search }),
    main,
    panel: evidence(c),
  });
}

/** 첫 화면과 워크트리별 새 세션 화면이 함께 쓰는 가운데 영역이다. context는 입력창 위에 놓을 칩 줄이다. */
function welcome(c, context) {
  const key = (k, label) =>
    `<Frame w="hug" h="hug" flex="row" items="center" gap={6}>${T(c, 12, 16, 500, 'ink2', k, '', mono)}${T(c, 12, 16, 400, 'ink3', label)}</Frame>`;
  return `<Frame name="Welcome" w="fill" h="fill" flex="col" items="center" justify="center" gap={20} pb={80}>
<Frame w={720} h="hug" flex="col" gap={6}>${T(c, 24, 32, 600, 'ink', '무엇을 할까요?')}${T(c, 14, 22, 400, 'ink3', 'Ora는 계획을 세우고, 검증 명령으로 결과를 확인한 뒤 완료를 보고합니다.')}</Frame>
<Frame w={720} h="hug" flex="col" gap={8}>
<Frame w="fill" h="hug" flex="row" items="center" gap={6}>${context}</Frame>
${composer(c)}
</Frame>
<Frame w={720} h="hug" flex="row" gap={20} px={14}>${key('⌘K', '명령 팔레트')}${key('⌘N', '새 세션')}${key('⌘,', '설정')}</Frame>
</Frame>`;
}

function newSessionScreen() {
  const c = palette('Dark');
  const chip = (icon, label, extra = '') =>
    `<Frame w="hug" h={28} flex="row" items="center" gap={6} px={10} rounded={8} bg="${c.raised}">${I(c, icon, 'ink2', 14)}${T(c, 13, 18, 500, 'ink2', label, '', mono)}${extra}</Frame>`;
  const context = `${chip('folder', '~/Desktop/ora')}${chip('git-branch', 'main', T(c, 12, 16, 500, 'add', '+4', '', mono) + T(c, 12, 16, 500, 'del', '−0', '', mono))}${T(c, 12, 16, 400, 'ink3', '이 워크트리에서 시작합니다', 'pl={6}')}`;
  return windowFrame(c, '04 New Session · Dark', {
    side: sidebar(c, { groups: repos({ worktree: 'ora/main' }) }),
    main: header(c, { title: '새 세션', repo: 'ora · main' }) + welcome(c, context),
  });
}

function emptyScreen() {
  const c = palette('Dark');
  const chip = (icon, label) =>
    `<Frame w="hug" h={28} flex="row" items="center" gap={6} px={10} rounded={8} bg="${c.raised}">${I(c, icon, 'ink2', 14)}${T(c, 13, 18, 500, 'ink2', label)}${I(c, 'chevron-down', 'ink3', 12)}</Frame>`;
  return windowFrame(c, '05 Empty · Dark', {
    side: sidebar(c, { empty: true }),
    main: header(c) + welcome(c, chip('folder', 'math-demo') + chip('git-branch', 'main')),
  });
}

function crashedScreen() {
  const c = palette('Dark');
  const title = 'README 설치 절차 갱신';
  const groups = repos({
    session: title,
    patch: { [title]: { meta: '중간에 멈춤, 재개 가능', dot: 'warn' } },
  });
  const badge = `<Frame w="hug" h={24} flex="row" items="center" gap={4} px={8} rounded={6} bg="${c.raised}">${I(c, 'circle-pause', 'ink2', 12)}${T(c, 12, 16, 500, 'ink2', '멈춤')}</Frame>`;
  const aborted = `${I(c, 'circle-pause', 'ink3', 14)}${T(c, 12, 16, 500, 'ink3', 'aborted', '', mono)}`;
  const notice = `<Frame name="ResumeNotice" w="fill" h="hug" flex="col" gap={12} p={16} rounded={14} bg="${c.raised}">
<Frame w="fill" h="hug" flex="row" items="center" gap={8}>${I(c, 'triangle-alert', 'warn', 16)}${T(c, 14, 20, 600, 'ink', '작업이 중간에 멈췄습니다')}${SP}${T(c, 12, 16, 400, 'ink3', '10:42')}</Frame>
${T(c, 13, 20, 400, 'ink2', '실행 중이던 도구 호출 1개를 aborted로 기록했습니다. 작업 폴더의 변경은 그대로 있습니다.', 'w="fill" textAutoResize="height"')}
<Frame w="fill" h="hug" flex="col" gap={4} px={12} py={10} rounded={10} bg="${c.window}">
<Frame w="fill" h="hug" flex="row" items="center" gap={8}>${T(c, 12, 16, 500, 'ink3', '재개 지점')}${T(c, 13, 18, 500, 'ink', 't2 README 예제 출력을 확인한다')}</Frame>
${T(c, 12, 16, 400, 'ink3', '마지막 검증 증거가 있는 t1 다음부터 다시 실행합니다.')}
</Frame>
<Frame w="fill" h="hug" flex="row" items="center" gap={8}>${SP}${button(c, 'ghost', '기록만 보기')}${button(c, 'primary', 't2부터 재개', { icon: 'rotate-ccw' })}</Frame>
</Frame>`;
  const main =
    header(c, { title, repo: 'math-demo · docs/readme-pnpm', stage: 5, diff: [12, 3], badge }) +
    thread(
      c,
      [
        userBubble(
          c,
          'README 설치 절차를 pnpm 기준으로 갱신하고, 예제가 실제로 도는지 확인해 주세요.',
        ),
        `<Frame w="fill" h="hug" flex="col" gap={4}>${toolLine(c, { icon: 'file-pen', verb: '수정', target: 'README.md', add: 12, del: 3 })}${toolLine(c, { icon: 'terminal', verb: '실행', target: 'pnpm test -- install', status: T(c, 12, 16, 500, 'ok', 'exit 0', '', mono) })}${toolLine(c, { icon: 'terminal', verb: '실행', target: 'pnpm test -- readme', status: aborted })}</Frame>`,
        notice,
      ],
      {
        composerOptions: { placeholder: '재개할 때 함께 보낼 조향 메시지를 적습니다' },
        status: [['스텝 9/50'], ['기본 모델'], ['격리 harness']],
      },
    );
  const todos = [
    {
      id: 't1',
      title: 'README 설치 절차를 pnpm으로 바꾼다',
      status: 'verified',
      origin: 'repo',
      cmd: '$ pnpm test -- install',
      result: 'exit 0',
      resultColor: 'ok',
    },
    {
      id: 't2',
      title: 'README 예제 출력을 확인한다',
      status: 'interrupted',
      origin: 'repo',
      cmd: '$ pnpm test -- readme',
      result: 'aborted',
    },
    { id: 't3', title: '변경 요약을 남긴다', status: 'pending' },
  ];
  return windowFrame(c, '06 Crashed · Dark', {
    side: sidebar(c, { groups }),
    main,
    panel: evidence(c, { todos, current: 't2' }),
  });
}

/** 모드 미리보기. 창 하나를 줄여 그린다. 시스템은 왼쪽 절반을 라이트, 오른쪽 절반을 다크로 그린다. */
function modeThumb(c, mode, selected) {
  const half = (p, w, withSidebar) =>
    `<Frame w={${w}} h="fill" flex="row" bg="${p.window}">${withSidebar ? `<Frame w={20} h="fill" bg="${p.sidebar}" />` : ''}<Frame w="fill" h="fill" flex="col" gap={5} p={8}><Frame w={40} h={4} rounded={2} bg="${p.ink3}" /><Frame w={28} h={4} rounded={2} bg="${p.line}" /><Frame w="fill" h="fill" /><Frame w="fill" h={10} rounded={4} bg="${p.raised}" /></Frame></Frame>`;
  const L = palette('Light');
  const D = palette('Dark');
  const body = {
    system: half(L, 48, true) + half(D, 48, false),
    light: half(L, 96, true),
    dark: half(D, 96, true),
  }[mode];
  const label = { system: '시스템', light: '라이트', dark: '다크' }[mode];
  return `<Frame w="hug" h="hug" flex="col" items="center" gap={8}>
<Frame w={96} h={60} flex="row" rounded={8} overflow="hidden" ${selected ? `stroke="${c.ink}" strokeWidth={2} strokeAlign="outside"` : `stroke="${c.line}" strokeWidth={1} strokeAlign="inside"`}>${body}</Frame>
${T(c, 12, 16, selected ? 600 : 500, selected ? 'ink' : 'ink3', label)}</Frame>`;
}

function settingsNav(c, current) {
  const lights = ['#FF5F57', '#FEBC2E', '#28C840']
    .map((x) => `<Ellipse w={12} h={12} bg="${x}" />`)
    .join('');
  const item = ([icon, label]) => {
    const on = label === current;
    return `<Frame w="fill" h={32} flex="row" items="center" gap={10} px={10} rounded={8} bg="${on ? c.hover : c.sidebar}">${I(c, icon, on ? 'ink' : 'ink2', 15)}${T(c, 13, 18, on ? 500 : 400, on ? 'ink' : 'ink2', label)}</Frame>`;
  };
  const section = (title, items) =>
    `<Frame w="fill" h="hug" flex="col" gap={1}><Frame w="fill" h={28} flex="row" items="center" px={10}>${T(c, 12, 16, 500, 'ink3', title)}</Frame>${items.map(item).join('')}</Frame>`;
  return `<Frame name="SettingsNav" w={264} h="fill" flex="col" gap={16} pt={16} pb={12} px={8} bg="${c.sidebar}">
<Frame w="fill" h={20} flex="row" items="center" gap={8} px={10}>${lights}${SP}</Frame>
<Frame w="fill" h="hug" flex="row" items="center" gap={8} px={6} pt={6}>${I(c, 'arrow-left', 'ink2', 16)}${T(c, 18, 26, 600, 'ink', '설정')}</Frame>
<Frame w="fill" h={32} flex="row" items="center" gap={8} px={10} rounded={8} bg="${c.raised}">${I(c, 'search', 'ink3', 14)}${T(c, 13, 18, 400, 'ink3', '검색')}</Frame>
${section('앱', [
  ['settings', '일반'],
  ['palette', '모양'],
  ['keyboard', '키보드 단축키'],
  ['bell', '알림'],
])}
${section('엔진', [
  ['cpu', '모델'],
  ['shield', '권한'],
  ['box', '격리'],
  ['gauge', '비용 상한'],
  ['plug', 'MCP'],
  ['sparkles', '스킬'],
  ['brain', '기억'],
])}
</Frame>`;
}

function settingsScreen() {
  const c = palette('Light');
  const content = `<Frame name="Appearance" w="fill" h="fill" flex="col" items="center" pt={72}>
<Frame w={640} h="hug" flex="col" gap={24}>
${T(c, 24, 32, 600, 'ink', '모양')}
<Frame w="fill" h="hug" flex="col" gap={10}>${T(c, 13, 18, 500, 'ink2', '화면 스타일')}
<Frame w="fill" h="hug" flex="row" items="center" gap={16} px={16} py={14} rounded={14} bg="${c.raised}">
<Frame w="fill" h="hug" flex="col" gap={2}>${T(c, 14, 20, 500, 'ink', '모드')}${T(c, 12, 16, 400, 'ink3', '시스템은 OS 설정을 따르고, OS 설정이 바뀌면 바로 반영합니다.', 'w={260} textAutoResize="height"')}</Frame>
${modeThumb(c, 'system', true)}${modeThumb(c, 'light', false)}${modeThumb(c, 'dark', false)}
</Frame></Frame>
</Frame>
</Frame>`;
  return windowFrame(c, '07 Settings · Light', { side: settingsNav(c, '모양'), main: content });
}

export const SCREENS = [
  { file: 'components-dark', jsx: componentBoard },
  { file: 'session-dark', jsx: sessionScreen },
  { file: 'question-dark', jsx: questionScreen },
  { file: 'new-session-dark', jsx: newSessionScreen },
  { file: 'empty-dark', jsx: emptyScreen },
  { file: 'crashed-dark', jsx: crashedScreen },
  { file: 'settings-light', jsx: settingsScreen },
];
