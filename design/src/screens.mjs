// M1 화면 시안의 목록. 프레임 하나가 화면 하나이고, 이름 앞 번호는 design/ora.fig의 순서다.
// render 도구에 jsx()의 결과를 넘기고, export_image 결과를 design/previews/<file>.png로 저장한다.
import { componentBoard } from './components.mjs';
import {
  approvalV2,
  chooserV2,
  codeCardV2,
  composerV2,
  icode,
  panelHeadV2,
  paraV2,
  sidebarV2,
  tabsHeaderV2,
  threadV2,
  toolRowV2,
  userBoxV2,
  sidebarV3,
  titleTabsV3,
  titleButtonV3,
  statusBarV3,
  toastV3,
  windowV3,
  panelOpenButtonV3,
  changesPanelV3,
} from './v2.mjs';
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
  phasePanel,
  waiverCard,
  routingPreview,
  modelPicker,
  modelSwitchMark,
  workspaceSidebar,
  tabBar,
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
const STATUS = [['스텝 12/50'], ['기본 모델 사용 중'], ['격리 harness'], ['캐시 적중 82%']];
const CONTEXT_STATUS = (pct) => [
  ['스텝 31/50'],
  ['기본 모델 사용 중'],
  ['격리 harness'],
  [`컨텍스트 ${pct}`],
  ['캐시 적중 82%'],
];
// "컨텍스트 NN%" 글자의 왼쪽 끝 x다. 11 Context 시안을 내보낸 이미지에서 쟀다(1280px 이미지의 533px → 1440px 프레임의 600px).
const CONTEXT_CARD_X = 600;

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

/** 상태 표시줄의 캐시 적중률에 마우스를 올렸을 때 뜨는 세부 카드다. 적중률은 캐시에서 읽은 입력 토큰을 전체 입력 토큰으로 나눈 값이다. */
function cacheScreen() {
  const c = palette('Dark');
  // 밝은 면 위에서 foreground-subtle은 다크 4.11:1로 AA에 못 미쳐, 카드 안 이름은 foreground-muted로 쓴다.
  const row = (label, value) =>
    `<Frame w="fill" h="hug" flex="row" items="center" gap={8}>${T(c, 12, 16, 400, 'ink2', label, 'w={72}')}${T(c, 12, 16, 400, 'ink', value, 'grow={1}', mono)}</Frame>`;
  // 카드 아래 끝을 상태 표시줄(y=860) 4px 위에, 왼쪽 끝을 "캐시 적중" 글자(x=600)에 맞춘다. 카드 높이는 174px이다.
  const card = `<Frame name="CacheCard" position="absolute" x={600} y={682} w={340} h="hug" flex="col" gap={10} p={12} rounded={10} bg="${c.popover}" stroke="${c.borderStrong}" strokeWidth={1} strokeAlign="inside">
<Frame w="fill" h="hug" flex="row" items="center">${T(c, 12, 16, 600, 'ink', '프롬프트 캐시')}${SP}${T(c, 12, 16, 600, 'ink', '82%', '', mono)}</Frame>
<Frame w="fill" h={4} flex="row" rounded={2} bg="${c.borderStrong}"><Frame w={259} h={4} rounded={2} bg="${c.ink2}" /></Frame>
${row('세션 누적', '읽기 182.4k / 입력 222.1k')}
${row('마지막 요청', '읽기 41.2k · 쓰기 1.1k · 새 0.3k')}
${row('유지 시간', '1시간')}
${T(c, 12, 16, 400, 'ink2', '적중한 토큰은 모델이 다시 처리하지 않습니다. 응답이 빨라지고 구독 사용량이 줄어듭니다.', 'w={316} textAutoResize="height"')}
</Frame>`;
  return windowFrame(c, '09 Cache · Dark', {
    side: sidebar(c, { groups: repos({ session: 'add 함수 버그 수정' }) }),
    main: sessionMain(c),
    panel: evidence(c, { todos: SESSION_TODOS, current: 't1' }),
    overlay: card,
  });
}

/** 대화에서 컨텍스트를 줄인 자리. 도구 출력 생략은 목록만, 압축(인계 문서나 요약)은 펼치면 엔진이 붙인 필수 항목과 모델이 쓴 부분을 보여 준다(SPEC 4.3절). */
function compactionMark(c, { label, time, open = null }) {
  const rule = `<Frame w="fill" h={1} bg="${c.line}" />`;
  const toggle =
    open === null
      ? button(c, 'ghost', '목록 보기', { icon: 'chevron-down' })
      : button(c, 'ghost', open ? '접기' : '펼치기', {
          icon: open ? 'chevron-up' : 'chevron-down',
        });
  const head = `<Frame w="fill" h="hug" flex="row" items="center" gap={10}>${rule}<Frame w="hug" h="hug" flex="row" items="center" gap={6}>${I(c, 'fold-vertical', 'ink3', 14)}${T(c, 12, 16, 500, 'ink2', label)}${T(c, 12, 16, 400, 'ink3', `· ${time}`)}</Frame>${toggle}${rule}</Frame>`;
  if (open !== true) return head;
  const line = (s) => T(c, 12, 18, 400, 'ink2', s, 'w="fill" textAutoResize="height"');
  const cd = (s) => `<Span font="${mono}" size={12} color="${c.ink}">${s}</Span>`;
  const section = (title, lines) =>
    `<Frame w="fill" h="hug" flex="col" gap={4}>${T(c, 12, 16, 600, 'ink', title)}${lines.join('')}</Frame>`;
  const body = `<Frame w="fill" h="hug" flex="col" gap={12} p={14} rounded={10} bg="${c.sunken}">
${section('할 일', [line(`${cd('t1 verified')} math.js의 add를 덧셈으로 고친다 · ${cd('node check.js → exit 0')}`), line(`${cd('t2 attempted')} README 예제 출력을 갱신한다`)])}
${section('사용자 지시', [line('“math.js의 add가 뺄셈을 하고 있어요. 고치고 테스트까지 돌려 주세요.”'), line('“README 예제도 실제 출력으로 맞춰 주세요.”')])}
${section('남은 오류', [line('없음')])}
${section('인계 문서', [line('check.js로 검증했고 t1은 끝났다. README 예제는 node examples/sum.js의 실제 출력으로 맞추는 중이다. 출력 형식은 예제 3개 모두 같다.')])}
</Frame>`;
  return `<Frame w="fill" h="hug" flex="col" gap={8}>${head}${body}</Frame>`;
}

function contextMain(c, { blocks, status }) {
  return (
    header(c, { title: 'add 함수 버그 수정', repo: 'math-demo · main', stage: 5, diff: [3, 2] }) +
    thread(c, blocks, { composerOptions: { running: true }, status })
  );
}

/** 컨텍스트 사용 비율 카드와 요약 표시. 상태 표시줄의 "컨텍스트 NN%"에 마우스를 올리거나 포커스를 주면 카드를 띄운다. */
function contextScreen() {
  const c = palette('Dark');
  const row = (label, value) =>
    `<Frame w="fill" h="hug" flex="row" items="center" gap={8}>${T(c, 12, 16, 400, 'ink2', label, 'w={72}')}${T(c, 12, 16, 400, 'ink', value, 'grow={1}', mono)}</Frame>`;
  const card = `<Frame name="ContextCard" position="absolute" x={${CONTEXT_CARD_X}} y={682} w={340} h="hug" flex="col" gap={10} p={12} rounded={10} bg="${c.popover}" stroke="${c.borderStrong}" strokeWidth={1} strokeAlign="inside">
<Frame w="fill" h="hug" flex="row" items="center">${T(c, 12, 16, 600, 'ink', '컨텍스트')}${SP}${T(c, 12, 16, 600, 'ink', '64%', '', mono)}</Frame>
<Frame w="fill" h={4} flex="row" rounded={2} bg="${c.borderStrong}"><Frame w={203} h={4} rounded={2} bg="${c.ink2}" /></Frame>
${row('사용', '128.4k / 200k 토큰')}
${row('압축 기준', '80% · 160k')}
${row('생략', '도구 출력 9개 · 58.2k 줄임')}
${row('압축', '1회 · 인계 문서 · 스텝 1~24')}
${T(c, 12, 16, 400, 'ink2', '80%에 닿으면 오래된 도구 출력부터 생략하고, 그래도 넘치면 앞부분을 인계 문서로 바꿉니다. 최근 20k 토큰과 할 일·검증 증거는 그대로 둡니다. 모델은 생략한 원문을 다시 읽을 수 있습니다.', 'w={316} textAutoResize="height"')}
</Frame>`;
  const blocks = [
    compactionMark(c, { label: '도구 출력 9개를 생략했습니다', time: '18:31' }),
    compactionMark(c, { label: '스텝 1~24를 인계 문서로 바꿨습니다', time: '18:42', open: true }),
    `<Frame w="fill" h="hug" flex="col" gap={4}>${toolLine(c, { icon: 'history', verb: '원문 보기', target: 'README.md 읽기 결과' })}${toolLine(c, { icon: 'file-pen', verb: '수정', target: 'README.md', add: 2, del: 1 })}</Frame>`,
    reply(
      c,
      `README 예제 출력을 실제 값으로 맞췄습니다. 이제 ${code(c, 'pnpm test -- readme')}로 확인하겠습니다.`,
    ),
  ];
  return windowFrame(c, '11 Context · Dark', {
    side: sidebar(c, { groups: repos({ session: 'add 함수 버그 수정' }) }),
    main: contextMain(c, { blocks, status: CONTEXT_STATUS('64%') }),
    panel: evidence(c, { todos: SESSION_TODOS, current: 't2' }),
    overlay: card,
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
function welcome(c, context, { composerOptions = {}, below = '', overlay = '' } = {}) {
  const key = (k, label) =>
    `<Frame w="hug" h="hug" flex="row" items="center" gap={6}>${T(c, 12, 16, 500, 'ink2', k, '', mono)}${T(c, 12, 16, 400, 'ink3', label)}</Frame>`;
  return `<Frame name="Welcome" w="fill" h="fill" flex="col" items="center" justify="center" gap={20} pb={80}>
<Frame w={720} h="hug" flex="col" gap={6}>${T(c, 24, 32, 600, 'ink', '무엇을 할까요?')}${T(c, 14, 22, 400, 'ink3', 'Ora는 계획을 세우고, 검증 명령으로 결과를 확인한 뒤 완료를 보고합니다.')}</Frame>
<Frame w={720} h="hug" flex="col" gap={8}>
<Frame w="fill" h="hug" flex="row" items="center" gap={6}>${context}</Frame>
${composer(c, composerOptions)}
${below}
</Frame>
<Frame w={720} h="hug" flex="row" gap={20} px={14}>${key('⌘K', '명령 팔레트')}${key('⌘N', '새 세션')}${key('⌘,', '설정')}</Frame>
${overlay}</Frame>`;
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
  ['key-round', '계정'],
  ['cpu', '모델'],
  ['shield', '권한'],
  ['box', '격리'],
  ['gauge', '비용 상한'],
  ['plug', 'MCP'],
  ['sparkles', '스킬'],
  ['brain', '메모리'],
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

/** 설정 › 계정. 프로바이더별 로그인 계정, 남은 한도, 순위를 보고 로그인과 로그아웃을 한다(SPEC 2.8절). */
function accountsScreen() {
  const c = palette('Dark');
  const chip = (label) =>
    `<Frame w="hug" h={20} flex="row" items="center" px={6} rounded={6} bg="${c.hover}">${T(c, 11, 14, 500, 'ink2', label)}</Frame>`;
  const more = `<Frame w={28} h={28} flex="row" items="center" justify="center" rounded={8}>${I(c, 'ellipsis', 'ink3', 16)}</Frame>`;
  const divider = `<Frame w="fill" h={1} bg="${c.line}" />`;
  const account = ({
    name,
    detail,
    kind,
    usage,
    state,
    stateColor = 'ink2',
    stateIcon = null,
    rank,
  }) =>
    `<Frame w="fill" h="hug" flex="row" items="center" gap={12} px={16} py={12}>
<Frame w="fill" h="hug" flex="col" gap={2}>
<Frame w="hug" h="hug" flex="row" items="center" gap={8}>${T(c, 14, 20, 500, 'ink', name)}${chip(kind)}</Frame>
${T(c, 12, 16, 400, 'ink3', detail, '', mono)}
</Frame>
<Frame w={150} h="hug" flex="col" gap={2}>${T(c, 12, 16, 400, 'ink3', '남은 한도')}${T(c, 12, 16, 500, 'ink2', usage, '', /\d/.test(usage) ? mono : undefined)}</Frame>
<Frame w={150} h="hug" flex="row" items="center" gap={6}>${stateIcon ? I(c, stateIcon, stateColor, 14) : ''}${T(c, 12, 16, 500, stateColor, state)}</Frame>
<Frame w={52} h="hug" flex="col" gap={2}>${T(c, 12, 16, 400, 'ink3', '우선순위')}${T(c, 12, 16, 500, 'ink2', rank, '', mono)}</Frame>
${more}
</Frame>`;
  const footer = (extra = '') =>
    `<Frame w="fill" h="hug" flex="row" items="center" gap={8} px={16} py={12}>${button(c, 'secondary', '구독으로 로그인', { icon: 'log-in' })}${button(c, 'ghost', 'API 키 추가', { icon: 'key-round' })}${extra}</Frame>`;
  const card = (rows) =>
    `<Frame w="fill" h="hug" flex="col" rounded={14} bg="${c.raised}" overflow="hidden">${rows.join(divider)}</Frame>`;
  const group = (title, note, rows) =>
    `<Frame w="fill" h="hug" flex="col" gap={10}><Frame w="fill" h="hug" flex="row" items="center" gap={8}>${T(c, 13, 18, 500, 'ink2', title)}${SP}${T(c, 12, 16, 400, 'ink3', note)}</Frame>${card(rows)}</Frame>`;
  const waiting = (lines, actions) =>
    `<Frame w="fill" h="hug" flex="row" items="center" gap={12} px={16} py={14}>${I(c, 'loader-circle', 'ink2', 16)}<Frame w="fill" h="hug" flex="col" gap={4}>${lines}</Frame>${actions}</Frame>`;
  const content = `<Frame name="Accounts" w="fill" h="fill" flex="col" items="center" pt={72}>
<Frame w={640} h="hug" flex="col" gap={24}>
<Frame w="fill" h="hug" flex="col" gap={6}>${T(c, 24, 32, 600, 'ink', '계정')}${T(c, 13, 18, 400, 'ink3', '새 세션은 순위가 높은 계정부터 씁니다. 한도에 걸리거나 남은 한도가 예비분 아래로 내려가면 다음 계정으로 넘어갑니다.', 'w={640} textAutoResize="height"')}</Frame>
${group('Claude', '계정 3개', [
  account({
    name: 'main',
    detail: 'ejrgus94160@gmail.com',
    kind: '구독',
    usage: '5시간 94% · 7일 84%',
    state: '사용 중',
    stateColor: 'ok',
    stateIcon: 'circle-check',
    rank: '2',
  }),
  account({
    name: 'second',
    detail: 'second@example.com',
    kind: '구독',
    usage: '5시간 0% · 7일 61%',
    state: '한도 · 15:00에 풀림',
    stateColor: 'warn',
    stateIcon: 'clock',
    rank: '1',
  }),
  account({
    name: 'credit',
    detail: 'ANTHROPIC_API_KEY',
    kind: 'API 키',
    usage: '측정 안 함',
    state: '대기',
    stateIcon: 'circle-dashed',
    rank: '0',
  }),
  footer(),
])}
${group('Codex', '로그인 중', [
  waiting(
    `${T(c, 14, 20, 500, 'ink', '브라우저에서 승인을 기다립니다')}${T(c, 12, 16, 400, 'ink3', '승인하면 이 화면에 계정이 나타납니다. 5분 안에 끝내야 합니다.', 'w={420} textAutoResize="height"')}`,
    `${button(c, 'ghost', '주소 다시 열기', { icon: 'external-link' })}${button(c, 'ghost', '취소')}`,
  ),
])}
${group('Grok', '코드 입력 대기', [
  waiting(
    `${T(c, 14, 20, 500, 'ink', 'x.ai에서 아래 코드를 입력합니다')}<Frame w="hug" h="hug" flex="row" items="center" gap={12}>${T(c, 22, 30, 600, 'ink', 'WDJB-MJHT', 'letterSpacing={2}', mono)}${T(c, 12, 16, 400, 'ink3', '14:21 남음', '', mono)}</Frame>`,
    `${button(c, 'secondary', '주소 열기', { icon: 'external-link' })}${button(c, 'ghost', '취소')}`,
  ),
])}
</Frame>
</Frame>`;
  return windowFrame(c, '10 Settings Accounts · Dark', {
    side: settingsNav(c, '계정'),
    main: content,
  });
}

/** 명령 팔레트. 세션 전환, 명령 실행, 화면 이동을 키보드만으로 한다(SPEC 8.2절). 세션 화면 위에 막을 덮고 띄운다. */
function commandPaletteScreen() {
  const c = palette('Dark');
  const hit = (before, match, after) =>
    `${before}<Span weight={600} color="${c.ink}">${match}</Span>${after}`;
  const row = ({ icon, label, detail = '', key = '', active = false }) =>
    `<Frame w="fill" h={36} flex="row" items="center" gap={10} px={12} rounded={8} ${active ? `bg="${c.hover}"` : ''}>${I(c, icon, active ? 'ink' : 'ink3', 15)}<Text size={13} lineHeight={18} weight={400} font="Pretendard" color="${c.ink2}">${label}</Text>${detail ? T(c, 12, 16, 400, 'ink3', detail, '', mono) : ''}${SP}${key ? T(c, 12, 16, 500, 'ink3', key, '', mono) : ''}</Frame>`;
  const group = (title, rows) =>
    `<Frame w="fill" h="hug" flex="col" gap={2}><Frame w="fill" h={24} flex="row" items="center" px={12}>${T(c, 12, 16, 500, 'ink3', title)}</Frame>${rows.map(row).join('')}</Frame>`;
  const palettePanel = `<Frame name="CommandPalette" position="absolute" x={400} y={120} w={640} h="hug" flex="col" rounded={14} bg="${c.raised}" overflow="hidden">
<Frame w="fill" h={52} flex="row" items="center" gap={10} px={16}>${I(c, 'search', 'ink3', 16)}${T(c, 15, 22, 400, 'ink', 'readme', 'grow={1}')}<Frame w="hug" h={22} flex="row" items="center" px={6} rounded={6} bg="${c.window}">${T(c, 11, 14, 500, 'ink3', 'Esc', '', mono)}</Frame></Frame>
<Frame w="fill" h={1} bg="${c.window}" />
<Frame w="fill" h="hug" flex="col" gap={8} p={8}>
${group('세션', [
  {
    icon: 'message-square',
    label: hit('', 'README', ' 설치 절차 갱신'),
    detail: 'math-demo · docs/readme-pnpm',
    active: true,
  },
  {
    icon: 'message-square',
    label: hit('', 'README', ' 예제 실행 확인'),
    detail: 'math-demo · docs/readme-examples',
  },
])}
${group('명령', [
  { icon: 'square-pen', label: hit('', 'README', '를 갱신하는 새 세션 시작'), key: '⌘N' },
  { icon: 'rotate-ccw', label: hit('', 'README', ' 설치 절차 갱신 재개') },
])}
${group('이동', [
  { icon: 'list-checks', label: '할 일 패널', key: '⌘1' },
  { icon: 'settings', label: '설정', key: '⌘,' },
])}
</Frame>
<Frame w="fill" h={36} flex="row" items="center" gap={16} px={16} bg="${c.sunken}">${T(c, 12, 16, 400, 'ink3', '↑↓ 이동')}${T(c, 12, 16, 400, 'ink3', '↵ 실행')}${T(c, 12, 16, 400, 'ink3', 'Esc 닫기')}</Frame>
</Frame>`;
  const scrim = `<Frame name="Overlay" position="absolute" x={0} y={0} w={1440} h={900} bg="${c.overlay}" />`;
  return windowFrame(c, '08 Command Palette · Dark', {
    side: sidebar(c, { groups: repos({ session: 'add 함수 버그 수정' }) }),
    main: sessionMain(c),
    panel: evidence(c, { todos: SESSION_TODOS, current: 't1' }),
    overlay: scrim + palettePanel,
  });
}

const PHASE_OBJECTIVE = 'add 함수가 덧셈을 하도록 고치고, 테스트와 README 예제까지 맞춘다';
const PHASE_FIND = {
  name: '원인 찾기',
  steps: 3,
  todos: [{ id: 't1', title: 'add가 뺄셈을 하는 줄을 찾는다', status: 'verified' }],
};

/** phase로 나눈 할 일 패널(실행 중). 끝난 phase는 접고, 작업 중인 할 일이 있는 phase를 펼쳐 흐름을 보인다. */
function phasesScreen() {
  const c = palette('Dark');
  const phases = [
    PHASE_FIND,
    {
      name: '수정',
      open: true,
      criterion: 'node check.js가 exit 0으로 끝난다',
      todos: [
        {
          id: 't2',
          title: 'math.js의 add를 덧셈으로 고친다',
          status: 'verified',
          origin: 'model',
          cmd: '$ node check.js',
          result: 'exit 0',
          resultColor: 'ok',
          flow: [
            ['try', '시도 · 스텝 4'],
            ['fail', '검증 실패 · exit 1 · 스텝 5'],
            ['repair', '수리 1 · 스텝 6'],
            ['pass', '검증 통과 · exit 0 · 스텝 7'],
          ],
        },
        {
          id: 't3',
          title: '음수 입력 검사를 check.js에 더한다',
          status: 'attempted',
          origin: 'model',
          cmd: '$ node check.js --neg',
          result: '실행 전',
          flow: [['try', '시도 · 스텝 8']],
        },
      ],
    },
    {
      name: '문서',
      hover: true,
      criterion: 'README 예제가 실제 출력과 같다',
      todos: [
        { id: 't4', title: 'README 예제 출력을 갱신한다', status: 'pending' },
        { id: 't5', title: '변경 요약을 남긴다', status: 'pending' },
      ],
    },
  ];
  return windowFrame(c, '12 Phases · Dark', {
    side: sidebar(c, { groups: repos({ session: 'add 함수 버그 수정' }) }),
    main: sessionMain(c),
    panel: phasePanel(c, { objective: PHASE_OBJECTIVE, phases, current: 't3' }),
  });
}

/** phase 패널의 상태 네 가지: 엔진이 blocked로 멈춘 상태, 포기 메뉴, 포기 확인, 포기가 섞인 완료와 포기 취소 메뉴. */
function phaseStatesScreen() {
  const c = palette('Dark');
  const blocked = {
    name: '실제 앱에서 확인',
    open: true,
    todos: [
      {
        id: 't4',
        title: 'claude CLI로 실제 응답을 받는다',
        status: 'blocked',
        origin: 'model',
        reason: '격리 정책이 claude 실행을 막습니다',
        flow: [
          ['try', '시도 · 스텝 9'],
          ['block', '막힘 · 스텝 10'],
        ],
      },
      {
        id: 't5',
        title: 'check.js를 통과시킨다',
        status: 'blocked',
        origin: 'model',
        reason: '3번 고쳤지만 검사를 통과하지 못했습니다',
        cmd: '$ node check.js',
        result: 'exit 1',
        resultColor: 'del',
        flow: [
          ['more', '이전 4개 보기'],
          ['fail', '검증 실패 · exit 1 · 스텝 15'],
          ['repair', '수리 3 · 스텝 16'],
          ['fail', '검증 실패 · exit 1 · 스텝 17'],
          ['block', '막힘 · 스텝 17'],
        ],
      },
    ],
  };
  const stopBanner = {
    icon: 'octagon-pause',
    color: 'warn',
    title: '막혀서 멈췄습니다',
    body: '막힌 할 일 2개. 사유를 보고 포기하거나, 메시지로 다른 방법을 알려 주세요.',
  };
  const pop = (x, y, w, inner) =>
    `<Frame name="Popover" position="absolute" x={${x}} y={${y}} w={${w}} h="hug" flex="col" p={4} rounded={10} bg="${c.popover}" stroke="${c.borderStrong}" strokeWidth={1} strokeAlign="inside">${inner}</Frame>`;
  const item = (icon, label) =>
    `<Frame w="fill" h={32} flex="row" items="center" gap={8} px={10} rounded={6} bg="${c.hover}">${I(c, icon, 'ink', 14)}${T(c, 13, 18, 500, 'ink', label)}</Frame>`;
  const menu = pop(150, 322, 176, item('circle-slash', '포기하기'));
  const confirm = pop(
    16,
    300,
    308,
    `<Frame w="fill" h="hug" flex="col" gap={10} p={10}>${T(c, 13, 18, 600, 'ink', '이 할 일을 포기할까요?')}${T(c, 12, 18, 400, 'ink2', '포기한 할 일은 완료 판정에서 빠집니다. 같은 메뉴의 포기 취소로 되돌릴 수 있습니다.', 'w="fill" textAutoResize="height"')}<Frame w="fill" h="hug" flex="row" items="center" gap={8}>${SP}${button(c, 'ghost', '취소')}${button(c, 'primary', '포기하기')}</Frame></Frame>`,
  );
  const fix = {
    name: '수정',
    open: true,
    steps: 9,
    todos: [
      {
        id: 't2',
        title: 'math.js의 add를 덧셈으로 고친다',
        status: 'verified',
        cmd: '$ node check.js',
        result: 'exit 0',
        resultColor: 'ok',
      },
      {
        id: 't3',
        title: '음수 입력 검사를 check.js에 더한다',
        status: 'abandoned',
        flow: [
          ['try', '시도 · 스텝 8'],
          ['abandon', '포기 · 사용자 · 스텝 9'],
        ],
      },
    ],
  };
  const docs = {
    name: '문서',
    steps: 2,
    todos: [{ id: 't4', title: 'README 예제 출력을 갱신한다', status: 'abandoned' }],
  };
  const restore = pop(150, 378, 176, item('rotate-ccw', '포기 취소'));
  const doneBanner = {
    icon: 'circle-check',
    color: 'ok',
    title: '검증을 통과해 끝났습니다',
    body: '검증 2개 통과 · 포기 2개',
  };
  const col = (caption, panel) =>
    `<Frame w={340} h="fill" flex="col" gap={10}>${T(c, 13, 18, 600, 'ink2', caption)}<Frame w={340} h="fill" flex="col" rounded={12} overflow="hidden">${panel}</Frame></Frame>`;
  return `<Frame name="13 Phase States · Dark" w={1480} h={900} flex="row" gap={24} p={24} bg="${c.window}" rounded={12}>
${col('막혀서 멈춤', phasePanel(c, { banner: stopBanner, objective: PHASE_OBJECTIVE, phases: [PHASE_FIND, blocked] }))}
${col('포기 메뉴', phasePanel(c, { banner: stopBanner, objective: PHASE_OBJECTIVE, phases: [PHASE_FIND, blocked], overlay: menu }))}
${col('포기 확인', phasePanel(c, { banner: stopBanner, objective: PHASE_OBJECTIVE, phases: [PHASE_FIND, blocked], overlay: confirm }))}
${col('포기가 섞인 완료 · 포기 취소 메뉴', phasePanel(c, { banner: doneBanner, objective: PHASE_OBJECTIVE, phases: [PHASE_FIND, fix, docs], overlay: restore }))}
</Frame>`;
}

const gateTodo = (status, flow, extra = {}) => ({
  id: 't2',
  title: 'add에 음수 처리 TODO 주석을 남기고 덧셈으로 고친다',
  status,
  origin: 'model',
  cmd: '$ node check.js',
  result: 'exit 0',
  resultColor: status === 'failed' ? 'ink3' : 'ok',
  flow,
  ...extra,
});
const GATE_FLOW = [
  ['try', '시도 · 스텝 6'],
  ['gate', '게이트 실패 · TODO 1곳 · 스텝 7'],
];
const gatePanel = (c, todo, current) =>
  phasePanel(c, {
    objective: '사용자 요청대로 음수 처리 TODO 주석을 남기고 add를 고친다',
    phases: [
      PHASE_FIND,
      { name: '수정', open: true, criterion: 'node check.js가 exit 0으로 끝난다', todos: [todo] },
    ],
    current,
  });

/** 완성 무결성 게이트가 막은 todo에 모델이 예외를 요청한 순간. 권한 모드와 상관없이 승인 카드가 뜬다. */
function gateWaiverScreen() {
  const c = palette('Dark');
  const blocks = [
    userBubble(c, 'add를 덧셈으로 고치고, 음수 처리는 나중에 할 테니 TODO 주석으로 남겨 주세요.'),
    `<Frame w="fill" h="hug" flex="col" gap={4}>${toolLine(c, { icon: 'file-pen', verb: '수정', target: 'math.js', add: 2, del: 1 })}${toolLine(c, { icon: 'shield-check', verb: '검증', target: 't2 · node check.js', status: T(c, 12, 16, 500, 'del', 't2: 게이트 실패 (exit 0, TODO 1곳)', '', mono) })}</Frame>`,
    reply(
      c,
      `check.js는 통과했지만 게이트가 ${code(c, 'math.js:2')}의 TODO를 찾았습니다. 이 TODO는 요청하신 주석이라 예외를 요청합니다.`,
    ),
    waiverCard(c, {
      todo: { id: 't2', title: 'add에 음수 처리 TODO 주석을 남기고 덧셈으로 고친다' },
      command: 'node check.js',
      exit: 0,
      findings: ['math.js:2  // TODO: 음수 입력 처리'],
      reason:
        '사용자가 음수 처리를 나중에 하겠다며 TODO 주석을 남기라고 지시했습니다. 구현을 빼먹은 것이 아닙니다.',
    }),
  ];
  const todo = gateTodo('failed', [
    ...GATE_FLOW,
    ['waiveAsk', '예외 요청 · 사용자 답 기다림 · 스텝 8'],
  ]);
  return windowFrame(c, '14 Gate Waiver · Dark', {
    side: sidebar(c, { groups: repos({ session: 'add 함수 버그 수정' }) }),
    main:
      header(c, { title: 'add 함수 버그 수정', repo: 'math-demo · main', stage: 5, diff: [2, 1] }) +
      thread(c, blocks, { status: STATUS }),
    panel: gatePanel(c, todo, 't2'),
  });
}

/** 예외 요청에 답한 뒤 할 일 패널: 승인하면 "검증됨 · 예외 승인", 거부하면 실패로 남는다. */
function gateResultScreen() {
  const c = palette('Dark');
  const approved = gateTodo(
    'verified',
    [...GATE_FLOW, ['waiveAsk', '예외 요청 · 스텝 8'], ['waive', '예외 승인 · 사용자 · 스텝 8']],
    { waived: true },
  );
  const rejected = gateTodo('failed', [
    ...GATE_FLOW,
    ['waiveAsk', '예외 요청 · 스텝 8'],
    ['waiveNo', '예외 거부 · 사용자 · 스텝 8'],
  ]);
  const col = (caption, panel) =>
    `<Frame w={340} h="fill" flex="col" gap={10}>${T(c, 13, 18, 600, 'ink2', caption)}<Frame w={340} h="fill" flex="col" rounded={12} overflow="hidden">${panel}</Frame></Frame>`;
  return `<Frame name="15 Gate Result · Dark" w={752} h={640} flex="row" gap={24} p={24} bg="${c.window}" rounded={12}>
${col('예외 승인 뒤', gatePanel(c, approved, null))}
${col('예외 거부 뒤', gatePanel(c, rejected, 't2'))}
</Frame>`;
}

const ROUTE_CHAIN = [
  { model: 'claude-haiku-5-5', provider: 'claude', effort: 'medium', signedIn: true },
  { model: 'gpt-5.6-luna', provider: 'codex', effort: 'low', signedIn: true },
];

/** 라우팅 미리보기(SPEC 2.4절). 입력창 아래 줄이 default 역할의 체인을 보이고, 모델 칩을 누르면 모델을 고르는 팝오버가 열린다. */
function routingScreen() {
  const c = palette('Dark');
  const chip = (icon, label, extra = '') =>
    `<Frame w="hug" h={28} flex="row" items="center" gap={6} px={10} rounded={8} bg="${c.raised}">${I(c, icon, 'ink2', 14)}${T(c, 13, 18, 500, 'ink2', label, '', mono)}${extra}</Frame>`;
  const context = `${chip('folder', '~/Desktop/ora')}${chip('git-branch', 'main')}${T(c, 12, 16, 400, 'ink3', '이 워크트리에서 시작합니다', 'pl={6}')}`;
  const picker = modelPicker(c, {
    x: ROUTE_PICKER_X,
    y: ROUTE_PICKER_Y,
    groups: [
      ['역할 default의 체인', ROUTE_CHAIN.map((m, i) => ({ ...m, selected: i === 0 }))],
      [
        '다른 모델',
        [
          { model: 'claude-sonnet-5-5', provider: 'claude', effort: 'medium', signedIn: true },
          { model: 'grok-5', provider: 'grok', effort: 'medium', signedIn: false },
        ],
      ],
    ],
    note: '고른 모델을 이 세션 체인의 맨 앞에 두고, 세션 기록에 "직접 고름"으로 남깁니다. 나머지 체인은 폴백으로 그대로 씁니다.',
  });
  return windowFrame(c, '16 Routing Preview · Dark', {
    side: sidebar(c, { groups: repos({ worktree: 'ora/main' }) }),
    main:
      header(c, { title: '새 세션', repo: 'ora · main' }) +
      welcome(c, context, {
        composerOptions: { model: 'claude-haiku-5-5', effort: 'medium', modelOpen: true },
        below: routingPreview(c, { chain: ROUTE_CHAIN }),
        overlay: picker,
      }),
  });
}
// 모델 칩 바로 위로 팝오버를 연다. 아래로 열면 미리보기 줄을 가리기 때문이다. 16 Routing Preview 시안을 내보낸 이미지(1280px)에서 칩 왼쪽 위 끝(470, 414)과 팝오버 높이(218px)를 재고, 1440px 창과 Welcome 프레임 원점(264, 50) 기준으로 바꿨다.
const ROUTE_PICKER_X = 265;
const ROUTE_PICKER_Y = 167;

/** 실행 중 폴백. 대화에 모델 전환 표시가 생기고, 상태 표시줄의 모델 칸이 폴백 중임을 글자로 알린다. */
function fallbackScreen() {
  const c = palette('Dark');
  const blocks = [
    userBubble(c, 'math.js의 add가 뺄셈을 하고 있어요. 고치고 테스트까지 돌려 주세요.'),
    `<Frame w="fill" h="hug" flex="col" gap={4}>${toolLine(c, { icon: 'file-text', verb: '읽기', target: 'math.js' })}${toolLine(c, { icon: 'file-pen', verb: '수정', target: 'math.js', add: 1, del: 1 })}</Frame>`,
    modelSwitchMark(c, {
      from: 'claude-haiku-5-5',
      to: 'gpt-5.6-luna',
      reason: '사용 한도 · 18:10에 풀림',
      time: '17:42',
    }),
    reply(c, `이어서 ${code(c, 'node check.js')}로 검증하겠습니다.`),
    `<Frame w="fill" h="hug" flex="col" gap={4}>${toolLine(c, { icon: 'shield-check', verb: '검증', target: 't1 · node check.js', status: T(c, 12, 16, 500, 'ok', 't1: verified (exit 0)', '', mono) })}</Frame>`,
    modelSwitchMark(c, {
      from: 'gpt-5.6-luna',
      to: 'claude-haiku-5-5',
      reason: '사용 한도가 풀림',
      time: '18:11',
      icon: 'undo-2',
      label: '첫 모델로 돌아왔습니다',
    }),
  ];
  const phases = [
    PHASE_FIND,
    {
      name: '수정',
      open: true,
      todos: [
        {
          id: 't1',
          title: 'math.js의 add를 덧셈으로 고친다',
          status: 'verified',
          origin: 'user',
          cmd: '$ node check.js',
          result: 'exit 0',
          resultColor: 'ok',
        },
        { id: 't2', title: 'README 예제 출력을 갱신한다', status: 'attempted', origin: 'model' },
      ],
    },
  ];
  return windowFrame(c, '17 Fallback · Dark', {
    side: sidebar(c, { groups: repos({ session: 'add 함수 버그 수정' }) }),
    main:
      header(c, { title: 'add 함수 버그 수정', repo: 'math-demo · main', stage: 4, diff: [1, 1] }) +
      thread(c, blocks, {
        composerOptions: { running: true, model: 'claude-haiku-5-5' },
        status: [
          ['스텝 14/50'],
          ['claude-haiku-5-5 · 체인 1/2'],
          ['폴백 1회', 'warn'],
          ['격리 harness'],
          ['캐시 적중 61%'],
        ],
      }),
    panel: phasePanel(c, { objective: PHASE_OBJECTIVE, phases, current: 't2' }),
  });
}

const WORKSPACES = [
  {
    repo: 'math-demo',
    worktrees: [
      { name: 'main', add: 1, del: 1, running: 2, selected: true },
      { name: 'docs/readme-pnpm', add: 12, del: 3 },
    ],
  },
  {
    repo: 'ora',
    worktrees: [
      { name: 'main', add: 4, del: 0 },
      { name: 'feat/engine-slice2', add: 1930, del: 350 },
    ],
  },
  { repo: 'notes', worktrees: [{ name: 'main', add: 0, del: 0 }] },
];
const MATH_MAIN = { repo: 'math-demo', name: 'main', diff: [1, 1] };
const MATH_TABS = [
  { title: 'add 함수 버그 수정', state: 'running' },
  { title: 'README 예제 출력 갱신', state: 'approval' },
  { title: '터미널 1', state: 'terminal' },
];
// 탭 줄에는 짧은 칩을 두고, 덮어쓰기 경고 전체 문구는 입력창 바로 위 안내 줄에 둔다. 탭 줄 폭이 좁아 긴 문구가 잘리기 때문이다.
const RUNNING_WARNING = '세션 2개 동시 실행';
const RUNNING_NOTICE = '같은 폴더에서 세션 2개 실행 중 · 파일을 서로 덮어쓸 수 있습니다';

/** 워크트리 탭(SPEC 8.2절). 사이드바는 워크트리만 보이고, 가운데 위쪽 탭 줄에서 세션과 터미널을 오간다. */
function tabsScreen() {
  const c = palette('Dark');
  const blocks = [
    userBubble(c, 'math.js의 add가 뺄셈을 하고 있어요. 고치고 테스트까지 돌려 주세요.'),
    `<Frame w="fill" h="hug" flex="col" gap={4}>${toolLine(c, { icon: 'file-text', verb: '읽기', target: 'math.js' })}${toolLine(c, { icon: 'file-pen', verb: '수정', target: 'math.js', add: 1, del: 1 })}</Frame>`,
    reply(
      c,
      `${code(c, 'add')}를 덧셈으로 고쳤습니다. 이제 ${code(c, 'node check.js')}로 검증하겠습니다.`,
    ),
  ];
  return windowFrame(c, '18 Tabs · Dark', {
    side: workspaceSidebar(c, { groups: WORKSPACES }),
    main:
      tabBar(c, { worktree: MATH_MAIN, tabs: MATH_TABS, active: 0, warning: RUNNING_WARNING }) +
      thread(c, blocks, {
        composerOptions: { running: true, model: 'claude-haiku-5-5' },
        status: STATUS,
        notice: RUNNING_NOTICE,
      }),
    panel: phasePanel(c, {
      objective: PHASE_OBJECTIVE,
      phases: [
        PHASE_FIND,
        {
          name: '수정',
          open: true,
          todos: [
            {
              id: 't2',
              title: 'math.js의 add를 덧셈으로 고친다',
              status: 'attempted',
              origin: 'model',
            },
          ],
        },
      ],
      current: 't2',
    }),
  });
}

/** 새 탭. 세션과 터미널을 고르고, 브라우저와 에뮬레이터는 M3까지 "곧 지원"으로 흐리게 둔다. 줄 전체가 버튼이다. */
function newTabScreen() {
  const c = palette('Dark');
  const item = (icon, label, key, soon = false) =>
    `<Frame w="fill" h={40} flex="row" items="center" gap={10} px={14} rounded={10} bg="${c.raised}">${I(c, icon, soon ? 'ink3' : 'ink2', 16)}${T(c, 14, 20, 500, soon ? 'ink3' : 'ink', label, 'grow={1}')}${soon ? T(c, 12, 16, 500, 'ink3', '곧 지원') : T(c, 12, 16, 500, 'ink3', key, '', mono)}</Frame>`;
  const chooser = `<Frame name="NewTab" w="fill" h="fill" flex="col" items="center" justify="center" gap={10} pb={60}>
<Frame w={360} h="hug" flex="col" gap={6}>${T(c, 13, 18, 500, 'ink3', 'math-demo · main에서 열기', 'pb={4}')}
${item('message-square', '세션', '⇧⌘S')}${item('square-terminal', '터미널', '⇧⌘T')}${item('globe', '브라우저', '', true)}${item('smartphone', '에뮬레이터', '', true)}</Frame>
${T(c, 12, 16, 400, 'ink3', '브라우저와 에뮬레이터는 데스크톱 앱(M3)에서 지원합니다.')}
</Frame>`;
  return windowFrame(c, '19 New Tab · Dark', {
    side: workspaceSidebar(c, { groups: WORKSPACES }),
    main:
      tabBar(c, {
        worktree: MATH_MAIN,
        tabs: [...MATH_TABS, { title: '새 탭', state: 'new' }],
        active: 3,
        warning: RUNNING_WARNING,
      }) + chooser,
  });
}

/** 터미널 탭. 워크트리 폴더에서 로그인 셸을 연다. 엔진의 승인 대화상자를 거치지 않는 사용자 셸이다. */
function terminalScreen() {
  const c = palette('Dark');
  const line = (s, color = 'ink') => T(c, 13, 20, 400, color, s, '', mono);
  const term = `<Frame name="Terminal" w="fill" h="fill" flex="col" gap={0} px={20} py={14} bg="${c.sunken}">
${line('~/projects/math-demo (main) $ node check.js', 'ink')}
${line('ok', 'ink2')}
${line('~/projects/math-demo (main) $ git status --short', 'ink')}
${line(' M math.js', 'del')}
${line('~/projects/math-demo (main) $ █', 'ink')}
</Frame>`;
  return windowFrame(c, '20 Terminal · Dark', {
    side: workspaceSidebar(c, { groups: WORKSPACES }),
    main:
      tabBar(c, { worktree: MATH_MAIN, tabs: MATH_TABS, active: 2, warning: RUNNING_WARNING }) +
      term,
  });
}

/** 기록 화면. 모든 워크트리의 세션을 찾고, 누르면 그 워크트리의 탭으로 연다. 줄 전체가 버튼이다. */
function historyScreen() {
  const c = palette('Dark');
  const filter = (label, on = false) =>
    `<Frame w="hug" h={28} flex="row" items="center" px={10} rounded={8} ${on ? `bg="${c.raised}"` : ''}>${T(c, 13, 18, on ? 600 : 500, on ? 'ink' : 'ink2', label)}</Frame>`;
  const row = (state, title, where, time) => {
    const [icon, col, label] = {
      running: ['loader', 'ink2', '실행 중'],
      approval: ['shield-alert', 'warn', '승인 대기'],
      done: ['circle-check', 'ok', '완료'],
      failed: ['circle-x', 'del', '실패'],
      stopped: ['octagon-pause', 'warn', '막혀서 멈춤'],
    }[state];
    return `<Frame w="fill" h={52} flex="row" items="center" gap={12} px={14} rounded={10}>${I(c, icon, col, 16)}<Frame w="fill" h="hug" flex="col" gap={2}>${T(c, 14, 20, 500, 'ink', title, 'maxLines={1} truncate')}${T(c, 12, 16, 400, 'ink3', where, '', mono)}</Frame>${T(c, 12, 16, 500, col, label, 'w={80}')}${T(c, 12, 16, 400, 'ink3', time, 'w={64}')}</Frame>`;
  };
  const list = `<Frame name="History" w="fill" h="fill" flex="col" items="center" pt={28}>
<Frame w={760} h="hug" flex="col" gap={14}>
${T(c, 20, 28, 600, 'ink', '기록')}
<Frame w="fill" h={36} flex="row" items="center" gap={8} px={12} rounded={10} bg="${c.raised}">${I(c, 'search', 'ink3', 15)}${T(c, 14, 20, 400, 'ink3', '제목, 본문, 할 일로 찾기', 'grow={1}')}</Frame>
<Frame w="fill" h="hug" flex="row" gap={4}>${filter('전체', true)}${filter('실행 중')}${filter('승인 대기')}${filter('완료')}${filter('실패·멈춤')}</Frame>
<Frame w="fill" h="hug" flex="col" gap={2}>
${row('running', 'add 함수 버그 수정', 'math-demo · main', '방금')}
${row('approval', 'README 예제 출력 갱신', 'math-demo · main', '2분 전')}
${row('done', '엔진 슬라이스 2 구현', 'ora · feat/engine-slice2', '어제')}
${row('stopped', 'npm 레지스트리에 publish', 'math-demo · docs/readme-pnpm', '어제')}
${row('failed', '검색 도구 타임아웃 재현', 'notes · main', '3일 전')}
</Frame>
</Frame>
</Frame>`;
  return windowFrame(c, '21 History · Dark', {
    side: workspaceSidebar(c, {
      groups: WORKSPACES.map((g) => ({
        ...g,
        worktrees: g.worktrees.map((w) => ({ ...w, selected: false })),
      })),
      nav: 'history',
    }),
    main: list,
  });
}

const V2_GROUPS = [
  {
    repo: 'math-demo',
    worktrees: [
      { name: 'main', running: 2, selected: true },
      { name: 'docs/readme-pnpm', meta: '2시간' },
    ],
  },
  {
    repo: 'ora',
    worktrees: [
      { name: 'main', meta: '어제' },
      { name: 'feat/engine-slice2', meta: '3일' },
    ],
  },
];
const V2_TABS = [
  { title: 'add 함수 버그 수정', state: 'running' },
  { title: 'README 예제 출력 갱신', state: 'approval' },
  { title: '터미널 1', state: 'terminal' },
];
const V2_USAGE = [
  ['5시간', 13],
  ['7일', 21],
];

/** 새 시각 언어 1: 세션 탭. 가운데는 Antigravity식 대화 기둥, 좌우 사이드바와 탭 줄은 Paseo식이다. */
function v2SessionScreen() {
  const c = palette('Slate');
  const blocks = [
    userBoxV2(c, 'math.js의 add가 뺄셈을 하고 있어요. 고치고 테스트까지 돌려 주세요.'),
    `<Frame w="fill" h="hug" flex="col" gap={2}>${toolRowV2(c, { icon: 'file-text', verb: '읽기', target: 'math.js' })}${toolRowV2(c, { icon: 'file-pen', verb: '수정', target: 'math.js', result: '+1 −1' })}</Frame>`,
    codeCardV2(c, {
      title: 'math.js',
      meta: T(c, 12, 16, 500, 'add', '+1', '', mono) + T(c, 12, 16, 500, 'del', '−1', '', mono),
      rows: [
        ['1', '-', 'exports.add = (a, b) => a - b;'],
        ['1', '+', 'exports.add = (a, b) => a + b;'],
      ],
    }),
    paraV2(
      c,
      `${icode(c, 'add')}가 뺄셈 부호를 쓰고 있어서 덧셈으로 고쳤습니다. 이제 저장소에 있는 ${icode(c, 'check.js')}로 검증하겠습니다.`,
    ),
    approvalV2(c),
  ];
  const panel = `<Frame w={340} h="fill" flex="row">${`<Frame w={1} h="fill" bg="${c.line}" />`}${phasePanel(
    c,
    {
      head: panelHeadV2(c, { right: `${T(c, 13, 18, 500, 'ink2', '검증 2/5', 'pr={8}', mono)}` }),
      objective: PHASE_OBJECTIVE,
      phases: [
        PHASE_FIND,
        {
          name: '수정',
          open: true,
          criterion: 'node check.js가 exit 0으로 끝난다',
          todos: [
            {
              id: 't2',
              title: 'math.js의 add를 덧셈으로 고친다',
              status: 'attempted',
              origin: 'user',
              cmd: '$ node check.js',
              result: '승인 대기',
              flow: [['try', '시도 · 스텝 4']],
            },
            { id: 't3', title: '음수 입력 검사를 check.js에 더한다', status: 'pending' },
          ],
        },
        {
          name: '문서',
          criterion: 'README 예제가 실제 출력과 같다',
          todos: [{ id: 't4', title: 'README 예제 출력을 갱신한다', status: 'pending' }],
        },
      ],
      current: 't2',
    },
  )}</Frame>`;
  return windowFrame(c, '22 V2 Session · Slate', {
    side: sidebarV2(c, { groups: V2_GROUPS, usage: V2_USAGE }),
    main:
      tabsHeaderV2(c, {
        worktree: 'main',
        repo: 'math-demo',
        diff: [1, 1],
        tabs: V2_TABS,
        active: 0,
        warning: '세션 2개 동시 실행',
      }) +
      threadV2(c, blocks, {
        composer: composerV2(c, { running: true }),
        status: [
          ['스텝 12/50'],
          ['claude-haiku-5-5 · 체인 1/2'],
          ['격리 harness'],
          ['컨텍스트 12%'],
          ['캐시 적중 82%'],
        ],
        notice: '같은 폴더에서 세션 2개 실행 중 · 파일을 서로 덮어쓸 수 있습니다',
      }),
    panel,
  });
}

/** 새 시각 언어 2: 새 탭. Paseo식 선택 목록이다. */
function v2NewTabScreen() {
  const c = palette('Slate');
  return windowFrame(c, '23 V2 New Tab · Slate', {
    side: sidebarV2(c, { groups: V2_GROUPS, usage: V2_USAGE }),
    main:
      tabsHeaderV2(c, {
        worktree: 'main',
        repo: 'math-demo',
        diff: [1, 1],
        tabs: [...V2_TABS, { title: '새 탭', state: 'new' }],
        active: 3,
        warning: '세션 2개 동시 실행',
      }) +
      chooserV2(c, {
        title: 'math-demo · main에서 열기',
        items: [
          ['message-square', '세션', '⇧⌘S'],
          ['square-terminal', '터미널', '⇧⌘T'],
          ['globe', '브라우저', '', true],
          ['smartphone', '에뮬레이터', '', true],
        ],
        note: '브라우저와 에뮬레이터는 데스크톱 앱(M3)에서 지원합니다.',
      }),
  });
}

/** 새 시각 언어 3: 새 세션. Antigravity식 입력창 아래에 라우팅 미리보기 줄을 둔다. */
function v2NewSessionScreen() {
  const c = palette('Slate');
  const preview = `<Frame w={720} h="hug" flex="row" items="center" gap={8} px={12}>${T(c, 13, 18, 500, 'ink3', '역할 default')}${T(c, 13, 18, 400, 'ink3', '·')}${T(c, 13, 18, 500, 'ink3', '1', '', mono)}${T(c, 13, 18, 500, 'ink', 'claude-haiku-5-5', '', mono)}${T(c, 13, 18, 400, 'ink2', 'medium')}${I(c, 'arrow-right', 'ink3', 12)}${T(c, 13, 18, 500, 'ink3', '2', '', mono)}${T(c, 13, 18, 500, 'ink', 'gpt-5.6-luna', '', mono)}${T(c, 13, 18, 400, 'ink2', 'low')}</Frame>`;
  const center = `<Frame name="WelcomeV2" w="fill" h="fill" flex="col" items="center" justify="center" gap={14} pb={90}>
<Frame w={720} h="hug" flex="col" gap={6} px={4}>${T(c, 26, 34, 600, 'ink', '무엇을 할까요?')}${T(c, 15, 22, 400, 'ink2', 'Ora는 계획을 세우고, 검증 명령으로 결과를 확인한 뒤 완료를 보고합니다.')}</Frame>
${composerV2(c)}
${preview}
</Frame>`;
  return windowFrame(c, '24 V2 New Session · Slate', {
    side: sidebarV2(c, { groups: V2_GROUPS, usage: V2_USAGE }),
    main:
      tabsHeaderV2(c, {
        worktree: 'main',
        repo: 'math-demo',
        diff: [1, 1],
        tabs: [...V2_TABS, { title: '새 세션', state: 'new' }],
        active: 3,
        warning: '세션 2개 동시 실행',
      }) + center,
  });
}

const V3_GROUPS = [
  {
    repo: 'math-demo',
    worktrees: [
      {
        name: 'main',
        base: true,
        selected: true,
        sessions: [
          { state: 'running', title: 'add 함수 버그 수정', model: 'gpt-5.6-luna', age: '2분' },
          {
            state: 'approval',
            title: 'README 예제 출력 갱신',
            model: 'claude-haiku-5-5',
            age: '5분',
          },
        ],
      },
      { name: 'docs/readme-pnpm' },
    ],
  },
  {
    repo: 'ora',
    worktrees: [
      { name: 'main', base: true },
      { name: 'feat/engine-slice2', running: 1 },
    ],
  },
];
const V3_STATUS = {
  usage: [
    [
      'Claude',
      [
        ['5시간', 13],
        ['7일', 21],
      ],
    ],
    ['Codex', [['5시간', 4]]],
  ],
  right: [
    ['loader', '세션 2개 실행 중'],
    ['square-terminal', '터미널 1'],
  ],
};
const v3Right = (c) =>
  `${titleButtonV3(c, 'git-compare', T(c, 12, 16, 500, 'add', '+1', '', mono) + T(c, 12, 16, 500, 'del', '−1', '', mono))}${titleButtonV3(c, 'code-xml', T(c, 13, 18, 500, 'ink2', '편집기'))}${titleButtonV3(c, 'play', T(c, 13, 18, 500, 'ink2', '명령'))}`;
const v3Panel = (c, panelOptions) =>
  `<Frame w={340} h="fill" flex="row"><Frame w={1} h="fill" bg="${c.line}" />${phasePanel(c, { head: panelHeadV2(c, { titleRow: true, right: T(c, 13, 18, 500, 'ink2', '검증 2/5', 'pr={8}', mono) }), ...panelOptions })}</Frame>`;

/** v3 세션 탭. 모델이 한도에 걸려 다음 모델로 넘어간 순간이다. 알림을 띄우고 입력창의 모델 칩을 새 모델로 바꾼다. */
function v3SessionScreen() {
  const c = palette('Slate');
  const blocks = [
    userBoxV2(c, 'math.js의 add가 뺄셈을 하고 있어요. 고치고 테스트까지 돌려 주세요.'),
    `<Frame w="fill" h="hug" flex="col" gap={2}>${toolRowV2(c, { icon: 'file-text', verb: '읽기', target: 'math.js' })}${toolRowV2(c, { icon: 'file-pen', verb: '수정', target: 'math.js', result: '+1 −1' })}</Frame>`,
    codeCardV2(c, {
      title: 'math.js',
      meta: T(c, 12, 16, 500, 'add', '+1', '', mono) + T(c, 12, 16, 500, 'del', '−1', '', mono),
      rows: [
        ['1', '-', 'exports.add = (a, b) => a - b;'],
        ['1', '+', 'exports.add = (a, b) => a + b;'],
      ],
    }),
    paraV2(
      c,
      `${icode(c, 'add')}가 뺄셈 부호를 쓰고 있어서 덧셈으로 고쳤습니다. 이제 저장소에 있는 ${icode(c, 'check.js')}로 검증하겠습니다.`,
    ),
    approvalV2(c),
  ];
  const toast = toastV3(c, {
    x: 724,
    y: 52,
    icon: 'arrow-right-left',
    title: '모델을 gpt-5.6-luna로 바꿨습니다',
    body: 'claude-haiku-5-5가 사용 한도에 걸렸습니다. 18:10에 한도가 풀리면 다시 claude-haiku-5-5로 돌아갑니다.',
  });
  return windowV3(c, '25 V3 Session · Slate', {
    side: sidebarV3(c, { groups: V3_GROUPS }),
    main:
      titleTabsV3(c, { tabs: V2_TABS, active: 0, right: v3Right(c) }) +
      threadV2(c, blocks, {
        composer: composerV2(c, { running: true, model: 'gpt-5.6-luna', effort: 'low' }),
        status: [['스텝 12/50'], ['격리 harness'], ['컨텍스트 12%'], ['캐시 적중 82%']],
        notice: '같은 폴더에서 세션 2개 실행 중 · 파일을 서로 덮어쓸 수 있습니다',
      }),
    panel: v3Panel(c, {
      objective: PHASE_OBJECTIVE,
      phases: [
        PHASE_FIND,
        {
          name: '수정',
          open: true,
          criterion: 'node check.js가 exit 0으로 끝난다',
          todos: [
            {
              id: 't2',
              title: 'math.js의 add를 덧셈으로 고친다',
              status: 'attempted',
              origin: 'user',
              cmd: '$ node check.js',
              result: '승인 대기',
              flow: [['try', '시도 · 스텝 4']],
            },
            { id: 't3', title: '음수 입력 검사를 check.js에 더한다', status: 'pending' },
          ],
        },
        {
          name: '문서',
          criterion: 'README 예제가 실제 출력과 같다',
          todos: [{ id: 't4', title: 'README 예제 출력을 갱신한다', status: 'pending' }],
        },
      ],
      current: 't2',
    }),
    status: statusBarV3(c, V3_STATUS),
    overlay: toast,
  });
}

/** v3 새 탭. 오른쪽 패널이 접힌 상태이고, 제목 줄 끝의 단추(⌥⌘B)로 다시 연다. */
function v3NewTabScreen() {
  const c = palette('Slate');
  return windowV3(c, '26 V3 New Tab · Slate', {
    side: sidebarV3(c, { groups: V3_GROUPS }),
    main:
      titleTabsV3(c, {
        tabs: [...V2_TABS, { title: '새 탭', state: 'new' }],
        active: 3,
        right: v3Right(c) + panelOpenButtonV3(c),
      }) +
      chooserV2(c, {
        title: 'math-demo · main에서 열기',
        items: [
          ['message-square', '세션', '⇧⌘S'],
          ['square-terminal', '터미널', '⇧⌘T'],
          ['globe', '브라우저', '', true],
          ['smartphone', '에뮬레이터', '', true],
        ],
        note: '브라우저와 에뮬레이터는 데스크톱 앱(M3)에서 지원합니다.',
      }),
    status: statusBarV3(c, V3_STATUS),
  });
}

/** v3 새 세션. 모델 체인은 보이지 않고, 입력창의 모델 칩에서 모델만 고른다. 오른쪽 패널은 할 일이 없으므로 "변경" 탭으로 연다. */
function v3NewSessionScreen() {
  const c = palette('Slate');
  const center = `<Frame name="WelcomeV3" w="fill" h="fill" flex="col" items="center" justify="center" gap={14} pb={90}>
<Frame w={720} h="hug" flex="col" gap={6} px={4}>${T(c, 26, 34, 600, 'ink', '무엇을 할까요?')}${T(c, 15, 22, 400, 'ink2', 'math-demo · main에서 시작합니다. Ora는 계획을 세우고, 검증 명령으로 결과를 확인한 뒤 완료를 보고합니다.')}</Frame>
${composerV2(c)}
</Frame>`;
  return windowV3(c, '27 V3 New Session · Slate', {
    side: sidebarV3(c, { groups: V3_GROUPS }),
    main:
      titleTabsV3(c, {
        tabs: [...V2_TABS, { title: '새 세션', state: 'new' }],
        active: 3,
        right: v3Right(c),
      }) + center,
    panel: changesPanelV3(c, {
      branch: 'main',
      files: [
        ['math.js', 1, 1],
        ['check.js', 4, 0],
      ],
    }),
    status: statusBarV3(c, V3_STATUS),
  });
}

// 남은 M2 기능(복수 모델 검토, MCP, 스킬, 비용 가드레일, 데스크톱 알림)의 v3 시안이다. 2026-10-29 사용자 요청으로 그렸다.
const hr = (c) => `<Frame w="fill" h={1} bg="${c.line}" />`;
const v3Card = (c, { icon, iconColor, title, right = '', body }) =>
  `<Frame w="fill" h="hug" flex="col" rounded={10} bg="${c.raised}" stroke="${c.line}" strokeWidth={1} strokeAlign="inside">
<Frame w="fill" h={40} flex="row" items="center" gap={8} px={14}>${I(c, icon, iconColor, 15)}${T(c, 14, 20, 600, 'ink', title)}${SP}${right}</Frame>
${hr(c)}
<Frame w="fill" h="hug" flex="col" gap={10} p={14}>${body}</Frame>
</Frame>`;
const v3Toggle = (c, on) =>
  `<Frame w={34} h={20} flex="row" items="center" ${on ? 'justify="end"' : ''} px={2} rounded={10} bg="${on ? c.primary : c.hover}"><Ellipse w={16} h={16} bg="${on ? c.onPrimary : c.ink3}" /></Frame>`;
const v3Badge = (c, label, color = 'ink2') =>
  `<Frame w="hug" h={20} flex="row" items="center" px={6} rounded={6} bg="${c.hover}">${T(c, 11, 14, 500, color, label)}</Frame>`;
const v3SettingsPage = (c, name, nav, { title, desc, body }) =>
  windowV3(c, name, {
    side: settingsNav(c, nav),
    main: `<Frame w="fill" h="fill" flex="col" items="center" pt={56}><Frame w={680} h="hug" flex="col" gap={22}>
<Frame w="fill" h="hug" flex="col" gap={6}>${T(c, 24, 32, 600, 'ink', title)}${T(c, 13, 20, 400, 'ink2', desc, 'w="fill" textAutoResize="height"')}</Frame>
${body}
</Frame></Frame>`,
    status: statusBarV3(c, V3_STATUS),
  });
const v3Group = (c, title, note, rows) =>
  `<Frame w="fill" h="hug" flex="col" gap={8}><Frame w="fill" h="hug" flex="row" items="center" gap={8}>${T(c, 13, 18, 500, 'ink2', title)}${SP}${note ? T(c, 12, 16, 400, 'ink3', note, '', mono) : ''}</Frame><Frame w="fill" h="hug" flex="col" rounded={10} bg="${c.raised}" stroke="${c.line}" strokeWidth={1} strokeAlign="inside">${rows.join(hr(c))}</Frame></Frame>`;

/** 세션 탭: 스킬과 MCP 도구를 쓴 줄, 다른 모델의 검토 카드, 비용 경고. 단계는 제목 줄 대신 입력창 아래 줄에 둔다. */
function v3ReviewScreen() {
  const c = palette('Slate');
  const finding = (sev, sevColor, text, where) =>
    `<Frame w="fill" h="hug" flex="row" items="start" gap={10}>${v3Badge(c, sev, sevColor)}${T(c, 13, 20, 400, 'ink', text, 'grow={1} textAutoResize="height" w="fill"')}${T(c, 12, 20, 400, 'ink3', where, '', mono)}</Frame>`;
  const review = v3Card(c, {
    icon: 'scan-eye',
    iconColor: 'ink2',
    title: '다른 모델의 검토',
    right: `${T(c, 12, 16, 400, 'ink3', '검토 모델')}${T(c, 12, 16, 500, 'ink2', 'gpt-5.6-luna', '', mono)}`,
    body: `<Frame w="fill" h="hug" flex="row" items="center" gap={8}>${I(c, 'circle-alert', 'warn', 15)}${T(c, 13, 18, 600, 'warn', '고칠 점 있음')}${T(c, 13, 18, 400, 'ink2', '· 지적 2건')}</Frame>
${finding('중요', 'warn', 'check.js가 음수 입력을 검사하지 않아 a - b로 되돌려도 통과할 수 있습니다.', 'check.js:4')}
${finding('참고', 'ink2', 'README 예제의 출력이 바뀐 동작과 다릅니다.', 'README.md:18')}
${T(c, 12, 18, 400, 'ink3', '검토 결과는 증거로 남습니다. 할 일은 검증 명령이 통과해야 끝납니다.', 'w="fill" textAutoResize="height"')}`,
  });
  const blocks = [
    userBoxV2(c, 'math.js의 add가 뺄셈을 하고 있어요. 고치고, 다른 모델 검토까지 받아 주세요.'),
    `<Frame w="fill" h="hug" flex="col" gap={2}>${toolRowV2(c, { icon: 'sparkles', verb: '스킬', target: 'bugfix-checklist', result: '프로젝트' })}${toolRowV2(c, { icon: 'plug', verb: 'MCP', target: 'github:get_issue #12' })}${toolRowV2(c, { icon: 'file-pen', verb: '수정', target: 'math.js', result: '+1 −1' })}${toolRowV2(c, { icon: 'square-terminal', verb: '검증', target: 'node check.js', result: 'exit 0', resultColor: 'ok' })}</Frame>`,
    review,
    paraV2(
      c,
      `검토가 짚은 대로 ${icode(c, 'check.js')}에 음수 입력 검사를 더하고, README 예제도 맞추겠습니다.`,
    ),
  ];
  return windowV3(c, '28 V3 Review · Slate', {
    side: sidebarV3(c, { groups: V3_GROUPS }),
    main:
      titleTabsV3(c, { tabs: V2_TABS, active: 0, right: v3Right(c) }) +
      threadV2(c, blocks, {
        composer: composerV2(c, { running: true }),
        status: [
          ['단계 Verify'],
          ['스텝 18/50'],
          ['격리 harness'],
          ['컨텍스트 31%'],
          ['캐시 적중 82%'],
          ['비용 상한 80%', 'warn'],
        ],
        notice: '비용 상한의 80%를 썼습니다 · 상한에 닿으면 다음 요청을 보내지 않고 멈춥니다',
      }),
    panel: v3Panel(c, {
      objective: PHASE_OBJECTIVE,
      phases: [
        PHASE_FIND,
        {
          name: '수정',
          open: true,
          criterion: 'node check.js가 exit 0으로 끝난다',
          todos: [
            {
              id: 't2',
              title: 'math.js의 add를 덧셈으로 고친다',
              status: 'attempted',
              origin: 'repo',
              cmd: '$ node check.js',
              result: '검토 지적 2',
              flow: [['try', '시도 · 스텝 4']],
            },
            { id: 't3', title: '음수 입력 검사를 check.js에 더한다', status: 'pending' },
          ],
        },
        {
          name: '문서',
          criterion: 'README 예제가 실제 출력과 같다',
          todos: [{ id: 't4', title: 'README 예제 출력을 갱신한다', status: 'pending' }],
        },
      ],
      current: 't2',
    }),
    status: statusBarV3(c, V3_STATUS),
  });
}

/** 비용 상한에 닿아 멈춘 세션. 금액 대신 상한 대비 비율과 남은 할 일을 보인다. */
function v3CostStopScreen() {
  const c = palette('Slate');
  const stop = v3Card(c, {
    icon: 'octagon-pause',
    iconColor: 'warn',
    title: '비용 상한에 닿아 멈췄습니다',
    right: T(c, 12, 16, 500, 'warn', '상한의 100%', '', mono),
    body: `${T(c, 13, 20, 400, 'ink2', '다음 모델 요청을 보내지 않았습니다. 남은 할 일은 2개이고, Learn 단계는 건너뛰었습니다.', 'w="fill" textAutoResize="height"')}
${T(c, 13, 20, 400, 'ink2', '상한을 올리거나 지시를 바꿔 보내면 이어 갑니다. 지금까지 쓴 양은 그대로 이어받습니다.', 'w="fill" textAutoResize="height"')}
<Frame w="fill" h="hug" flex="row" items="center" gap={8}>${SP}${button(c, 'secondary', '비용 상한 설정 열기', { icon: 'gauge' })}</Frame>`,
  });
  const blocks = [
    userBoxV2(c, 'math.js의 add가 뺄셈을 하고 있어요. 고치고, 다른 모델 검토까지 받아 주세요.'),
    `<Frame w="fill" h="hug" flex="col" gap={2}>${toolRowV2(c, { icon: 'file-pen', verb: '수정', target: 'math.js', result: '+1 −1' })}${toolRowV2(c, { icon: 'square-terminal', verb: '검증', target: 'node check.js', result: 'exit 0', resultColor: 'ok' })}${toolRowV2(c, { icon: 'file-pen', verb: '수정', target: 'check.js', result: '+4 −0' })}</Frame>`,
    stop,
  ];
  return windowV3(c, '29 V3 Cost Stop · Slate', {
    side: sidebarV3(c, { groups: V3_GROUPS }),
    main:
      titleTabsV3(c, { tabs: V2_TABS, active: 0, right: v3Right(c) }) +
      threadV2(c, blocks, {
        composer: composerV2(c, {
          placeholder: '지시를 바꿔 보내면 멈춘 곳에서 이어 갑니다',
        }),
        status: [
          ['멈춤 · 비용 상한', 'warn'],
          ['스텝 22/50'],
          ['격리 harness'],
          ['컨텍스트 38%'],
          ['비용 상한 100%', 'warn'],
        ],
      }),
    panel: v3Panel(c, {
      objective: PHASE_OBJECTIVE,
      phases: [
        PHASE_FIND,
        {
          name: '수정',
          open: true,
          criterion: 'node check.js가 exit 0으로 끝난다',
          todos: [
            {
              id: 't2',
              title: 'math.js의 add를 덧셈으로 고친다',
              status: 'verified',
              origin: 'repo',
              cmd: '$ node check.js',
              result: 'exit 0',
            },
            { id: 't3', title: '음수 입력 검사를 check.js에 더한다', status: 'pending' },
          ],
        },
        {
          name: '문서',
          criterion: 'README 예제가 실제 출력과 같다',
          todos: [{ id: 't4', title: 'README 예제 출력을 갱신한다', status: 'pending' }],
        },
      ],
      current: null,
    }),
    status: statusBarV3(c, V3_STATUS),
  });
}

/** 설정 › MCP. 서버별 연결 상태, 장애 기록, 켜고 끄기, 서버 추가 폼. 비밀정보는 환경변수 이름만 받는다. */
function v3McpScreen() {
  const c = palette('Slate');
  const server = ({ name, kind, target, state, stateColor, stateIcon, tools, on, extra = '' }) =>
    `<Frame w="fill" h="hug" flex="col" gap={8} px={16} py={12}>
<Frame w="fill" h="hug" flex="row" items="center" gap={12}>
<Frame w="fill" h="hug" flex="col" gap={3}><Frame w="hug" h="hug" flex="row" items="center" gap={8}>${T(c, 14, 20, 600, 'ink', name, '', mono)}${v3Badge(c, kind)}</Frame>${T(c, 12, 16, 400, 'ink3', target, 'w="fill" maxLines={1} truncate', mono)}</Frame>
<Frame w={130} h="hug" flex="col" gap={2}>${T(c, 12, 16, 400, 'ink3', '도구')}${T(c, 12, 16, 500, 'ink2', tools, '', mono)}</Frame>
<Frame w={150} h="hug" flex="row" items="center" gap={6}>${I(c, stateIcon, stateColor, 14)}${T(c, 12, 16, 500, stateColor, state)}</Frame>
${v3Toggle(c, on)}
</Frame>${extra}</Frame>`;
  const failure = `<Frame w="fill" h="hug" flex="row" items="center" gap={10} px={12} py={10} rounded={8} bg="${c.sunken}">${T(c, 12, 18, 400, 'ink2', '14:02 연결 시간 초과(10초). 이 서버의 도구만 껐고, 세션은 계속 진행합니다.', 'grow={1} w="fill" textAutoResize="height"')}${button(c, 'secondary', '다시 연결', { icon: 'refresh-cw' })}</Frame>`;
  const field = (label, value, hint = '') =>
    `<Frame w="fill" h="hug" flex="col" gap={6}>${T(c, 12, 16, 500, 'ink2', label)}<Frame w="fill" h={34} flex="row" items="center" px={10} rounded={8} bg="${c.sunken}" stroke="${c.line}" strokeWidth={1} strokeAlign="inside">${T(c, 13, 18, 400, value.startsWith('예:') ? 'ink3' : 'ink', value, '', mono)}</Frame>${hint ? T(c, 12, 16, 400, 'ink3', hint, 'w="fill" textAutoResize="height"') : ''}</Frame>`;
  const seg = `<Frame w="hug" h={30} flex="row" items="center" p={2} rounded={8} bg="${c.sunken}"><Frame w="hug" h={26} flex="row" items="center" px={12} rounded={6} bg="${c.hover}">${T(c, 13, 18, 500, 'ink', 'stdio')}</Frame><Frame w="hug" h={26} flex="row" items="center" px={12}>${T(c, 13, 18, 500, 'ink2', 'HTTP')}</Frame></Frame>`;
  const form = `<Frame w="fill" h="hug" flex="col" gap={12} p={16}>
<Frame w="fill" h="hug" flex="row" gap={12}>${field('이름', 'figma')}<Frame w="hug" h="hug" flex="col" gap={6}>${T(c, 12, 16, 500, 'ink2', '전송 방식')}${seg}</Frame></Frame>
${field('실행 명령', 'npx -y figma-mcp')}
${field('환경변수 이름', 'FIGMA_TOKEN', '값은 여기에 적지 않습니다. Ora는 실행할 때 환경변수에서 읽습니다.')}
<Frame w="fill" h="hug" flex="row" items="center" gap={8}>${SP}${button(c, 'ghost', '취소')}${button(c, 'primary', '추가하고 연결')}</Frame>
</Frame>`;
  return v3SettingsPage(c, '30 V3 Settings MCP · Slate', 'MCP', {
    title: 'MCP',
    desc: '외부 도구 서버를 연결합니다. 서버의 도구도 권한 모드와 승인 규칙을 똑같이 따르고, 이름은 서버명:도구명으로 보입니다.',
    body: `${v3Group(c, '서버', '3개', [
      server({
        name: 'github',
        kind: 'stdio',
        target: 'npx -y @modelcontextprotocol/server-github',
        state: '연결됨',
        stateColor: 'ok',
        stateIcon: 'circle-check',
        tools: '26개',
        on: true,
      }),
      server({
        name: 'linear',
        kind: 'HTTP',
        target: 'https://mcp.linear.app/mcp',
        state: '응답 없음 · 도구 끔',
        stateColor: 'warn',
        stateIcon: 'circle-alert',
        tools: '0 / 18개',
        on: true,
        extra: failure,
      }),
      server({
        name: 'notes',
        kind: 'stdio',
        target: 'node ~/tools/notes-mcp.js',
        state: '꺼 둠',
        stateColor: 'ink3',
        stateIcon: 'circle-dashed',
        tools: '—',
        on: false,
      }),
    ])}
${v3Group(c, '서버 추가', '', [form])}`,
  });
}

/** 설정 › 스킬. 프로젝트 스킬과 전역 스킬, 가려진 스킬, 최근 회상 기록. */
function v3SkillsScreen() {
  const c = palette('Slate');
  const skill = ({ name, desc, used, shadowed = false }) =>
    `<Frame w="fill" h="hug" flex="row" items="center" gap={12} px={16} py={12}>
<Frame w="fill" h="hug" flex="col" gap={3}><Frame w="hug" h="hug" flex="row" items="center" gap={8}>${I(c, 'sparkles', shadowed ? 'ink3' : 'ink2', 14)}${T(c, 14, 20, 600, shadowed ? 'ink3' : 'ink', name, '', mono)}${shadowed ? v3Badge(c, '프로젝트 스킬이 가림') : ''}</Frame>${T(c, 12, 18, 400, shadowed ? 'ink3' : 'ink2', desc, 'w="fill" textAutoResize="height"')}</Frame>
<Frame w={130} h="hug" flex="col" gap={2}>${T(c, 12, 16, 400, 'ink3', '사용')}${T(c, 12, 16, 500, 'ink2', used)}</Frame>
</Frame>`;
  const recall = (session, skills, age) =>
    `<Frame w="fill" h={40} flex="row" items="center" gap={10} px={16}>${T(c, 13, 18, 500, 'ink', session, 'maxLines={1} truncate')}${T(c, 12, 16, 400, 'ink3', '·')}${T(c, 12, 16, 400, 'ink2', skills, 'grow={1}', mono)}${T(c, 12, 16, 400, 'ink3', age)}</Frame>`;
  return v3SettingsPage(c, '31 V3 Settings Skills · Slate', '스킬', {
    title: '스킬',
    desc: '모델이 읽는 절차 문서입니다. 작업을 시작할 때 목록만 읽고, 관련 있는 스킬의 본문만 넣습니다. 이름이 같으면 프로젝트 스킬을 씁니다.',
    body: `${v3Group(c, '프로젝트 · math-demo', '.ora/skills/', [
      skill({
        name: 'bugfix-checklist',
        desc: '버그를 고치기 전에 재현 명령을 먼저 만들고, 고친 뒤 같은 명령으로 확인한다.',
        used: '3회 · 2분 전',
      }),
      skill({
        name: 'readme-examples',
        desc: 'README 예제를 바꾸면 실제 실행 출력과 대조한다.',
        used: '없음',
      }),
    ])}
${v3Group(c, '전역', '~/.ora/skills/', [
  skill({
    name: 'korean-commit',
    desc: '커밋 메시지를 한국어 한 줄 제목과 본문으로 쓴다.',
    used: '12회 · 어제',
  }),
  skill({
    name: 'bugfix-checklist',
    desc: '버그 수정 절차의 전역 판입니다.',
    used: '—',
    shadowed: true,
  }),
])}
${v3Group(c, '최근 회상', '', [
  recall('add 함수 버그 수정', 'bugfix-checklist', '2분 전'),
  recall('README 예제 출력 갱신', 'readme-examples 후보 · 본문 넣지 않음', '5분 전'),
])}`,
  });
}

/** 설정 › 알림. 사건별 데스크톱 알림 켜기, 브라우저 권한, 알림 미리보기와 테스트 알림. */
function v3NotifyScreen() {
  const c = palette('Slate');
  const row = (icon, title, desc, on) =>
    `<Frame w="fill" h="hug" flex="row" items="center" gap={12} px={16} py={12}>${I(c, icon, 'ink2', 16)}<Frame w="fill" h="hug" flex="col" gap={2}>${T(c, 14, 20, 500, 'ink', title)}${T(c, 12, 18, 400, 'ink3', desc, 'w="fill" textAutoResize="height"')}</Frame>${v3Toggle(c, on)}</Frame>`;
  const preview = `<Frame w={360} h="hug" flex="row" items="start" gap={10} p={12} rounded={14} bg="${c.popover}" stroke="${c.borderStrong}" strokeWidth={1} strokeAlign="inside">
<Frame w={32} h={32} flex="row" items="center" justify="center" rounded={8} bg="${c.hover}">${T(c, 15, 20, 700, 'ink', 'O')}</Frame>
<Frame w="fill" h="hug" flex="col" gap={2}><Frame w="fill" h="hug" flex="row" items="center">${T(c, 13, 18, 600, 'ink', 'Ora · math-demo')}${SP}${T(c, 11, 14, 400, 'ink3', '지금')}</Frame>${T(c, 13, 18, 500, 'ink', '승인이 필요합니다')}${T(c, 12, 18, 400, 'ink2', 'add 함수 버그 수정 · $ node check.js', 'w="fill" textAutoResize="height"')}</Frame>
</Frame>`;
  return v3SettingsPage(c, '32 V3 Settings Notify · Slate', '알림', {
    title: '알림',
    desc: 'Ora 창을 보고 있지 않을 때 데스크톱 알림을 보냅니다. 알림을 누르면 해당 세션 탭으로 갑니다. 알림을 꺼도 기록은 남습니다.',
    body: `<Frame w="fill" h="hug" flex="row" items="center" gap={10} px={14} py={12} rounded={10} bg="${c.raised}" stroke="${c.line}" strokeWidth={1} strokeAlign="inside">${I(c, 'circle-check', 'ok', 15)}${T(c, 13, 18, 500, 'ink', '브라우저 알림 권한: 허용됨')}${SP}${button(c, 'secondary', '테스트 알림 보내기', { icon: 'bell' })}</Frame>
${v3Group(c, '알림을 보낼 사건', '', [
  row(
    'shield-check',
    '승인 대기',
    '명령 실행이나 예외 승인을 기다립니다. 알림을 누르면 그 승인 카드로 갑니다.',
    true,
  ),
  row('message-circle-question', '질문 대기', '모델이 질문 카드로 답을 기다립니다.', true),
  row('circle-check', '완료', '세션이 모든 할 일을 검증하고 끝났습니다.', true),
  row('octagon-pause', '실패·멈춤', '오류, blocked, 비용 상한이나 최대 스텝으로 멈췄습니다.', true),
  row('gauge', '비용 경고', '비용 상한의 경고 비율에 닿았습니다.', true),
])}
<Frame w="fill" h="hug" flex="col" gap={8}>${T(c, 13, 18, 500, 'ink2', '미리보기')}${preview}</Frame>`,
  });
}

/** 설정 › 메모리. 메모리는 자동으로 저장하고 모델이 하루 한 번 다듬는다. 사람은 보고 지운다. 되돌리기는 M3이다. */
function v3MemoryScreen() {
  const c = palette('Slate');
  const item = ({ text, from, used, tag = null, hover = false }) =>
    `<Frame w="fill" h="hug" flex="row" items="center" gap={12} px={16} py={12} ${hover ? `bg="${c.hover}"` : ''}>
<Frame w="fill" h="hug" flex="col" gap={5}>${T(c, 14, 21, 400, 'ink', text, 'w="fill" textAutoResize="height"')}<Frame w="hug" h="hug" flex="row" items="center" gap={8}>${tag ? v3Badge(c, tag[0], tag[1]) : ''}${T(c, 12, 16, 400, 'ink3', from)}</Frame></Frame>
<Frame w={96} h="hug" flex="col" gap={2}>${T(c, 12, 16, 400, 'ink3', '쓴 횟수')}${T(c, 12, 16, 500, 'ink2', used)}</Frame>
${hover ? button(c, 'ghost', '지우기', { icon: 'trash-2' }) : '<Frame w={78} h={30} />'}
</Frame>`;
  const tidy = `<Frame w="fill" h="hug" flex="row" items="center" gap={10} px={14} py={12} rounded={10} bg="${c.raised}" stroke="${c.line}" strokeWidth={1} strokeAlign="inside">${I(c, 'sparkles', 'ink2', 15)}<Frame w="fill" h="hug" flex="col" gap={2}>${T(c, 13, 18, 500, 'ink', '오늘 03:12에 모델이 메모리를 다듬었습니다')}${T(c, 12, 16, 400, 'ink3', '합침 2 · 문장 고침 1 · 틀린 메모리 보관 1 · 다음은 내일, 또는 새 메모리 20개가 쌓이면')}</Frame>${button(c, 'secondary', '지금 다듬기')}</Frame>`;
  return v3SettingsPage(c, '33 V3 Settings Memory · Slate', '메모리', {
    title: '메모리',
    desc: 'Ora가 작업하면서 알게 된 사실과 선호입니다. 작업이 끝나면 알아서 저장하고, 모델이 하루 한 번 다듬습니다. 틀린 메모리는 지우면 됩니다.',
    body: `${tidy}
${v3Group(c, '이 프로젝트 · math-demo', '3개', [
  item({
    text: 'math-demo의 검증 명령은 node check.js이고, 음수 입력도 확인한다.',
    from: 'add 함수 버그 수정에서 · 2분 전',
    used: '3회',
  }),
  item({
    text: '이 저장소의 테스트는 pnpm check 한 번으로 모두 돈다.',
    from: 'README 예제 출력 갱신에서 · 어제',
    used: '0회',
    tag: ['출처 없음', 'warn'],
    hover: true,
  }),
  item({
    text: 'README 예제는 실제 실행 출력과 대조한 뒤에 고친다.',
    from: '문서 갱신에서 · 3일 전',
    used: '5회',
  }),
])}
${v3Group(c, '모든 프로젝트', '2개', [
  item({
    text: '사용자는 커밋 메시지를 한국어로 쓰기를 원한다.',
    from: 'ora 엔진 작업에서 · 어제',
    used: '12회',
  }),
  item({
    text: 'node 18에서는 fetch 실험 경고가 나오므로 출력 비교에서 뺀다.',
    from: 'notes 작업에서 · 94일 전',
    used: '0회',
    tag: ['오래 안 씀', 'ink2'],
  }),
])}`,
  });
}

/** 세션이 끝나며 메모리를 저장한 순간. 대화 끝에 저장한 내용이 한 줄씩 보이고, 줄의 지우기 단추로 바로 지운다. */
function v3MemorySavedScreen() {
  const c = palette('Slate');
  const saved = (text, hover = false) =>
    `<Frame w="fill" h="hug" flex="row" items="center" gap={8} px={10} py={6} rounded={8} ${hover ? `bg="${c.raised}"` : ''}>${I(c, 'brain', 'ink2', 14)}${T(c, 13, 18, 500, 'ink2', '메모리에 저장했습니다')}${T(c, 13, 18, 400, 'ink3', '·')}${T(c, 13, 18, 400, 'ink', text, 'grow={1} maxLines={1} truncate')}${hover ? button(c, 'ghost', '지우기', { icon: 'trash-2' }) : ''}</Frame>`;
  const blocks = [
    userBoxV2(c, 'math.js의 add가 뺄셈을 하고 있어요. 고치고 테스트까지 돌려 주세요.'),
    `<Frame w="fill" h="hug" flex="col" gap={2}>${toolRowV2(c, { icon: 'file-pen', verb: '수정', target: 'math.js', result: '+1 −1' })}${toolRowV2(c, { icon: 'square-terminal', verb: '검증', target: 'node check.js', result: 'exit 0', resultColor: 'ok' })}</Frame>`,
    paraV2(c, `${icode(c, 'add')}를 덧셈으로 고쳤고, ${icode(c, 'node check.js')}가 통과했습니다.`),
    `<Frame w="fill" h="hug" flex="col" gap={2}>${saved('math-demo의 검증 명령은 node check.js이고, 음수 입력도 확인한다.')}${saved('이 저장소의 테스트는 pnpm check 한 번으로 모두 돈다.', true)}</Frame>`,
  ];
  return windowV3(c, '34 V3 Memory Saved · Slate', {
    side: sidebarV3(c, { groups: V3_GROUPS }),
    main:
      titleTabsV3(c, { tabs: V2_TABS, active: 0, right: v3Right(c) }) +
      threadV2(c, blocks, {
        composer: composerV2(c),
        status: [
          ['단계 Learn'],
          ['스텝 9/50'],
          ['격리 harness'],
          ['컨텍스트 14%'],
          ['캐시 적중 83%'],
        ],
      }),
    panel: v3Panel(c, {
      objective: PHASE_OBJECTIVE,
      phases: [
        PHASE_FIND,
        {
          name: '수정',
          open: true,
          criterion: 'node check.js가 exit 0으로 끝난다',
          todos: [
            {
              id: 't2',
              title: 'math.js의 add를 덧셈으로 고친다',
              status: 'verified',
              origin: 'repo',
              cmd: '$ node check.js',
              result: 'exit 0',
            },
          ],
        },
      ],
      current: null,
    }),
    status: statusBarV3(c, V3_STATUS),
  });
}

// 설정의 남은 다섯 페이지(일반, 키보드 단축키, 모델, 권한, 격리) 시안이다. 2026-10-30 사용자 요청으로 그렸다.
const v3Seg = (c, options, active) =>
  `<Frame w="hug" h={30} flex="row" items="center" p={2} rounded={8} bg="${c.sunken}">${options
    .map((label, i) =>
      i === active
        ? `<Frame w="hug" h={26} flex="row" items="center" px={10} rounded={6} bg="${c.hover}">${T(c, 12, 16, 600, 'ink', label)}</Frame>`
        : `<Frame w="hug" h={26} flex="row" items="center" px={10}>${T(c, 12, 16, 500, 'ink2', label)}</Frame>`,
    )
    .join('')}</Frame>`;
const v3Field = (c, value, unit = '', w = 84) =>
  `<Frame w="hug" h="hug" flex="row" items="center" gap={6}><Frame w={${w}} h={30} flex="row" items="center" px={10} rounded={7} bg="${c.sunken}" stroke="${c.line}" strokeWidth={1} strokeAlign="inside">${T(c, 13, 18, 500, 'ink', value, '', mono)}</Frame>${unit ? T(c, 12, 16, 400, 'ink3', unit) : ''}</Frame>`;
const v3Row = (c, title, desc, control) =>
  `<Frame w="fill" h="hug" flex="row" items="center" gap={16} px={16} py={10}><Frame w="fill" h="hug" flex="col" gap={2}>${T(c, 14, 20, 500, 'ink', title)}${desc ? T(c, 12, 17, 400, 'ink3', desc, 'w="fill" textAutoResize="height"') : ''}</Frame>${control}</Frame>`;
const v3Choice = (c, { title, desc, on, badge = '', h = '"hug"' }) =>
  `<Frame w="fill" h=${h} flex="row" items="start" gap={12} px={14} py={12} rounded={10} bg="${on ? c.raised : c.window}" stroke="${on ? c.borderStrong : c.line}" strokeWidth={1} strokeAlign="inside"><Frame w={16} h={16} flex="row" items="center" justify="center" rounded={8} stroke="${on ? c.ink : c.ink3}" strokeWidth={1.5} strokeAlign="inside">${on ? `<Ellipse w={8} h={8} bg="${c.ink}" />` : ''}</Frame><Frame w="fill" h="hug" flex="col" gap={3}><Frame w="hug" h="hug" flex="row" items="center" gap={8}>${T(c, 14, 20, 600, 'ink', title)}${badge}</Frame>${T(c, 12, 17, 400, 'ink2', desc, 'w="fill" textAutoResize="height"')}</Frame></Frame>`;
const v3Save = (c, note) =>
  `<Frame w="fill" h="hug" flex="row" items="center" gap={10}>${T(c, 12, 16, 400, 'ink3', note, 'grow={1}')}${button(c, 'ghost', '되돌리기')}${button(c, 'primary', '저장')}</Frame>`;

/** 설정 › 일반. 세션 한도, 다른 모델 검토, 대화 길이, 도구 한도. 바꾼 값은 다음 세션부터 쓴다. */
function v3GeneralScreen() {
  const c = palette('Slate');
  return v3SettingsPage(c, '35 V3 Settings General · Slate', '일반', {
    title: '일반',
    desc: '세션이 얼마나 오래, 몇 개까지 돌지와 대화가 길어졌을 때의 처리를 정합니다. 바꾼 값은 다음 세션부터 씁니다.',
    body: `${v3Group(c, '세션 한도', '', [
      v3Row(
        c,
        '최대 스텝',
        '이 횟수만큼 모델 요청을 하면 멈추고 보고합니다.',
        v3Field(c, '50', '스텝'),
      ),
      v3Row(
        c,
        '할 일 하나를 고치는 최대 횟수',
        '넘으면 그 할 일을 막힘으로 바꿉니다.',
        v3Field(c, '3', '번'),
      ),
      v3Row(
        c,
        '진전 없이 멈추는 스텝',
        '할 일이 나아지지 않은 채 이만큼 지나면 멈춥니다.',
        v3Field(c, '5', '스텝'),
      ),
      v3Row(c, '동시에 돌리는 세션', '', v3Field(c, '4', '개')),
    ])}
${v3Group(c, '검증', '', [v3Row(c, '다른 모델의 검토', '검증을 통과한 할 일을 다른 모델이 한 번 더 검토합니다.', v3Toggle(c, false))])}
${v3Group(c, '대화 길이', '', [
  v3Row(
    c,
    '압축을 시작하는 지점',
    '컨텍스트가 이 비율에 닿으면 앞부분을 요약합니다.',
    v3Field(c, '80', '%'),
  ),
  v3Row(
    c,
    '캐시 만료 전 요약',
    '오래 기다릴 때 캐시가 끝나기 전에 미리 요약해 둡니다. 컨텍스트가 20만 토큰 이상일 때만 합니다.',
    v3Toggle(c, false),
  ),
])}
${v3Save(c, '바꾼 값이 2개 있습니다')}`,
  });
}

/** 설정 › 키보드 단축키. 지금 쓸 수 있는 단축키를 묶어 보인다. 바꾸는 기능은 없다. */
function v3KeysScreen() {
  const c = palette('Slate');
  const key = (label, keys) =>
    `<Frame w="fill" h={40} flex="row" items="center" px={16}>${T(c, 14, 20, 400, 'ink', label, 'grow={1}')}<Frame w="hug" h={22} flex="row" items="center" px={7} rounded={5} bg="${c.kbd}">${T(c, 12, 16, 500, 'ink2', keys)}</Frame></Frame>`;
  return v3SettingsPage(c, '36 V3 Settings Keys · Slate', '키보드 단축키', {
    title: '키보드 단축키',
    desc: '마우스 없이 화면을 오갈 수 있습니다. 단축키는 아직 바꿀 수 없습니다.',
    body: `${v3Group(c, '이동', '', [key('명령 팔레트', '⌘K'), key('기록', '⌘Y'), key('설정', '⌘,'), key('할 일 패널로 이동', '⌘1')])}
${v3Group(c, '탭', '', [key('새 탭', '⌘T'), key('새 세션', '⌘N'), key('새 탭에서 세션 열기', '⇧⌘S'), key('터미널 열기', '⇧⌘T')])}
${v3Group(c, '화면', '', [key('오른쪽 패널 열기·접기', '⌥⌘B')])}
${v3Group(c, '명령 팔레트 안에서', '', [key('위아래로 고르기', '↑ ↓'), key('실행', '↵'), key('닫기', 'Esc')])}`,
  });
}

/** 설정 › 모델. 역할별로 쓸 모델의 순서와 추론 강도, 다음 모델로 넘어가는 경우와 돌아오는 방식. */
function v3ModelsScreen() {
  const c = palette('Slate');
  const chip = (model, effort) =>
    `<Frame w="hug" h={26} flex="row" items="center" gap={6} px={8} rounded={6} bg="${c.hover}">${T(c, 12, 16, 500, 'ink', model, '', mono)}${T(c, 12, 16, 400, 'ink3', effort)}</Frame>`;
  const arrow = I(c, 'arrow-right', 'ink3', 12);
  const roleName = (title, en) =>
    `<Frame w="hug" h="hug" flex="row" items="center" gap={6}>${T(c, 14, 20, 500, 'ink', title)}${T(c, 12, 16, 400, 'ink3', `(${en})`, '', mono)}</Frame>`;
  const role = (title, en, desc, chain) =>
    `<Frame w="fill" h="hug" flex="row" items="center" gap={12} px={16} py={6}><Frame w={190} h="hug" flex="col" gap={2}>${roleName(title, en)}${T(c, 12, 16, 400, 'ink3', desc)}</Frame><Frame w="fill" h="hug" flex="row" items="center" gap={6}>${chain}</Frame>${button(c, 'ghost', '바꾸기')}</Frame>`;
  const step = (n, model, effort) =>
    `<Frame w="fill" h={36} flex="row" items="center" gap={10} px={10} rounded={8} bg="${c.sunken}">${I(c, 'grip-vertical', 'ink3', 14)}${T(c, 12, 16, 500, 'ink3', String(n), 'w={12}', mono)}${T(c, 13, 18, 500, 'ink', model, 'grow={1}', mono)}${v3Seg(c, ['low', 'medium', 'high'], effort)}${I(c, 'x', 'ink3', 14)}</Frame>`;
  const editing = `<Frame w="fill" h="hug" flex="col" gap={8} px={16} py={12}>
<Frame w="fill" h="hug" flex="row" items="center" gap={8}>${roleName('기본 작업', 'default')}${T(c, 12, 16, 400, 'ink3', '세션에서 쓰는 모델입니다. 위에서부터 쓰고, 쓸 수 없을 때만 다음 모델로 넘어갑니다.', 'grow={1}')}</Frame>
${step(1, 'claude-haiku-5-5', 0)}${step(2, 'gpt-5.6-luna', 0)}
<Frame w="fill" h="hug" flex="row" items="center" gap={8}>${button(c, 'ghost', '모델 추가', { icon: 'plus' })}${SP}${button(c, 'ghost', '취소')}${button(c, 'secondary', '완료')}</Frame>
</Frame>`;
  return v3SettingsPage(c, '37 V3 Settings Models · Slate', '모델', {
    title: '모델',
    desc: '역할마다 쓸 모델을 순서대로 정합니다. 세션 화면에는 지금 쓰는 모델만 보입니다.',
    body: `${v3Group(c, '역할별 모델', '', [
      editing,
      role(
        '압축 요약',
        'compaction',
        '대화가 길 때',
        `${T(c, 13, 18, 400, 'ink3', '기본 작업과 같음')}`,
      ),
      role('메모리', 'memory', '저장과 다듬기', `${T(c, 13, 18, 400, 'ink3', '기본 작업과 같음')}`),
      role(
        '검토',
        'review',
        '검토 에이전트',
        `${chip('gpt-5.6-luna', 'low')}${arrow}${chip('claude-haiku-5-5', 'low')}`,
      ),
      role(
        '빠른 조사',
        'fast',
        '조사 에이전트',
        `${T(c, 13, 18, 400, 'ink3', '기본 작업과 같음')}`,
      ),
      `<Frame w="fill" h={36} flex="row" items="center" px={8}>${button(c, 'ghost', '역할 추가', { icon: 'plus' })}</Frame>`,
    ])}
${v3Group(c, '다음 모델로 넘어가는 경우', '', [
  `<Frame w="fill" h="hug" flex="col" gap={6} px={16} py={12}>
${[
  ['gauge', '사용 한도(429)', '다음 계정으로 바꾸고, 모든 계정이 한도면 다음 모델로 넘어갑니다'],
  [
    'server-crash',
    '서버 오류(5xx)·연결 오류',
    '같은 계정으로 다시 시도하고, 그래도 안 되면 다음 모델로 넘어갑니다',
  ],
  ['circle-x', '그 밖의 오류', '넘어가지 않고 오류를 보입니다'],
]
  .map(
    ([icon, title, desc]) =>
      `<Frame w="fill" h={24} flex="row" items="center" gap={10}>${I(c, icon, 'ink2', 15)}${T(c, 13, 18, 500, 'ink', title, 'w={170}')}${T(c, 12, 18, 400, 'ink2', desc, 'grow={1}')}</Frame>`,
  )
  .join('')}
</Frame>`,
  v3Row(
    c,
    '첫 모델로 돌아가기',
    '한도가 풀리는 시각을 알면 그때 돌아갑니다.',
    v3Seg(c, ['한도가 풀리면', '돌아가지 않음'], 0),
  ),
])}
${v3Save(c, '')}`,
  });
}

/** 설정 › 권한. 권한 모드, 도구별 정책, 항상 묻는 폴더, 기억한 승인. 모델 도구 호출로는 바꿀 수 없다. */
function v3PermissionsScreen() {
  const c = palette('Slate');
  const tool = (name, active) =>
    `<Frame w="fill" h={44} flex="row" items="center" gap={12} px={16}>${T(c, 13, 18, 500, 'ink', name, 'grow={1}', mono)}${v3Seg(c, ['허용', '묻기', '막기'], active)}${I(c, 'x', 'ink3', 14)}</Frame>`;
  const listRow = (main, sub) =>
    `<Frame w="fill" h={44} flex="row" items="center" gap={12} px={16}><Frame w="fill" h="hug" flex="col" gap={1}>${T(c, 13, 18, 500, 'ink', main, '', mono)}${sub ? T(c, 12, 16, 400, 'ink3', sub, '', mono) : ''}</Frame>${button(c, 'ghost', '지우기', { icon: 'trash-2' })}</Frame>`;
  return v3SettingsPage(c, '38 V3 Settings Permissions · Slate', '권한', {
    title: '권한',
    desc: '모델이 묻지 않고 할 수 있는 일을 정합니다. 비밀정보 가리기, rm 대신 휴지통, 금지 구역 차단은 어느 모드에서나 적용합니다.',
    body: `<Frame w="fill" h="hug" flex="row" gap={10}>
${v3Choice(c, { title: '항상 묻기', desc: '파일 쓰기와 명령 실행을 모두 묻습니다.', on: false, h: '{78}' })}
${v3Choice(c, { title: '쓰기 허용', desc: '명령 실행만 묻습니다.', on: false, h: '{78}' })}
${v3Choice(c, { title: '승인 생략', desc: '묻지 않고 실행합니다.', on: true, h: '{78}' })}
</Frame>
${v3Group(c, '도구별 정책', '모드보다 먼저 적용', [tool('shell', 1), tool('github:create_issue', 2), `<Frame w="fill" h={40} flex="row" items="center" px={8}>${button(c, 'ghost', '도구 추가', { icon: 'plus' })}</Frame>`])}
${v3Group(c, '항상 묻는 폴더', '', [listRow('~/projects/math-demo/secrets', ''), `<Frame w="fill" h={40} flex="row" items="center" px={8}>${button(c, 'ghost', '폴더 추가', { icon: 'plus' })}</Frame>`])}
${v3Group(c, '항상 승인한 명령', '2개', [listRow('node check.js', 'shell · ~/projects/math-demo'), listRow('pnpm test -- readme', 'verify.run · ~/projects/math-demo')])}`,
  });
}

/** 설정 › 격리. 세션이 사용자 환경을 얼마나 물려받는지 정한다. 바꾸면 다음 세션부터 적용한다. */
function v3IsolationScreen() {
  const c = palette('Slate');
  const path = (p) =>
    `<Frame w="fill" h={34} flex="row" items="center" px={16}>${T(c, 13, 18, 400, 'ink2', p, '', mono)}</Frame>`;
  return v3SettingsPage(c, '39 V3 Settings Isolation · Slate', '격리', {
    title: '격리',
    desc: '세션이 내 컴퓨터의 홈 폴더와 환경변수를 얼마나 물려받을지 정합니다. 바꾸면 다음 세션부터 적용하고, 실행 중인 세션 2개는 지금 값을 계속 씁니다.',
    body: `<Frame w="fill" h="hug" flex="col" gap={8}>
${v3Choice(c, { title: '없음', desc: '홈 폴더와 환경변수를 그대로 물려받습니다.', on: false })}
${v3Choice(c, { title: '하네스', desc: 'Ora가 다른 에이전트 도구의 설정을 읽지 않고, 명령마다 필요한 설정만 덮어씁니다. 홈 폴더는 그대로입니다.', on: true, badge: v3Badge(c, '기본값') })}
${v3Choice(c, { title: '깨끗한 홈', desc: '하네스에 더해 따로 만든 홈 폴더를 쓰고, 허용한 환경변수만 넘깁니다. 작업 폴더에 다른 에이전트의 설정이 있으면 그 도구의 CLI 실행을 막습니다.', on: false })}
</Frame>
${v3Group(c, '어느 옵션에서도 읽지 않는 경로', '', [path('~/.agents  ·  ~/.claude  ·  ~/.pi'), path('~/.omp  ·  ~/.codex  ·  ~/.gemini')])}
${T(c, 12, 18, 400, 'ink3', '작업 폴더의 AGENTS.md, CLAUDE.md, AGENTS.local.md, CLAUDE.local.md는 모든 옵션에서 읽습니다.', 'w="fill" textAutoResize="height"')}`,
  });
}

export const SCREENS = [
  { file: 'components-dark', jsx: componentBoard },
  { file: 'session-dark', jsx: sessionScreen },
  { file: 'question-dark', jsx: questionScreen },
  { file: 'new-session-dark', jsx: newSessionScreen },
  { file: 'empty-dark', jsx: emptyScreen },
  { file: 'crashed-dark', jsx: crashedScreen },
  { file: 'settings-light', jsx: settingsScreen },
  { file: 'command-palette-dark', jsx: commandPaletteScreen },
  { file: 'cache-dark', jsx: cacheScreen },
  { file: 'settings-accounts-dark', jsx: accountsScreen },
  { file: 'context-dark', jsx: contextScreen },
  { file: 'phases-dark', jsx: phasesScreen },
  { file: 'phase-states-dark', jsx: phaseStatesScreen },
  { file: 'gate-waiver-dark', jsx: gateWaiverScreen },
  { file: 'gate-result-dark', jsx: gateResultScreen },
  { file: 'routing-dark', jsx: routingScreen },
  { file: 'fallback-dark', jsx: fallbackScreen },
  { file: 'tabs-dark', jsx: tabsScreen },
  { file: 'new-tab-dark', jsx: newTabScreen },
  { file: 'terminal-dark', jsx: terminalScreen },
  { file: 'history-dark', jsx: historyScreen },
  { file: 'v2-session-slate', jsx: v2SessionScreen },
  { file: 'v2-new-tab-slate', jsx: v2NewTabScreen },
  { file: 'v2-new-session-slate', jsx: v2NewSessionScreen },
  { file: 'v3-session-slate', jsx: v3SessionScreen },
  { file: 'v3-new-tab-slate', jsx: v3NewTabScreen },
  { file: 'v3-new-session-slate', jsx: v3NewSessionScreen },
  { file: 'v3-review-slate', jsx: v3ReviewScreen },
  { file: 'v3-cost-stop-slate', jsx: v3CostStopScreen },
  { file: 'v3-settings-mcp-slate', jsx: v3McpScreen },
  { file: 'v3-settings-skills-slate', jsx: v3SkillsScreen },
  { file: 'v3-settings-notify-slate', jsx: v3NotifyScreen },
  { file: 'v3-settings-memory-slate', jsx: v3MemoryScreen },
  { file: 'v3-memory-saved-slate', jsx: v3MemorySavedScreen },
  { file: 'v3-settings-general-slate', jsx: v3GeneralScreen },
  { file: 'v3-settings-keys-slate', jsx: v3KeysScreen },
  { file: 'v3-settings-models-slate', jsx: v3ModelsScreen },
  { file: 'v3-settings-permissions-slate', jsx: v3PermissionsScreen },
  { file: 'v3-settings-isolation-slate', jsx: v3IsolationScreen },
];
