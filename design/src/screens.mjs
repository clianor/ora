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
  phasePanel,
  waiverCard,
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
  ['key-round', '계정'],
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
];
