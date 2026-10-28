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

const GROUPS = [
  {
    repo: 'ora',
    rows: [
      { title: 'main', add: 4, del: 0 },
      { title: 'feat/engine-slice2', add: 1930, del: 350, meta: '검증 3/3, 완료', dot: 'ok' },
    ],
  },
  {
    repo: 'math-demo',
    rows: [
      {
        title: 'add 함수 버그 수정',
        add: 1,
        del: 1,
        meta: '승인 대기',
        selected: true,
        dot: 'warn',
      },
      { title: 'README 설치 절차 갱신', add: 12, del: 3, meta: '검증 2/2, 완료', dot: 'ok' },
    ],
  },
  {
    repo: 'notes',
    rows: [
      { title: '검색 도구 타임아웃 조사', add: 0, del: 0, meta: '실패, 1시간 전', dot: 'del' },
    ],
  },
];
const STATUS = [['스텝 12/50'], ['기본 모델 사용 중'], ['격리 harness']];

function sessionMain(c) {
  return (
    header(c, { title: 'add 함수 버그 수정', repo: 'math-demo', stage: 4, diff: [1, 1] }) +
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

function sessionScreen(mode) {
  const c = palette(mode);
  return windowFrame(c, `02 Session · ${mode}`, {
    side: sidebar(c, { groups: GROUPS }),
    main: sessionMain(c),
    panel: evidence(c, { todos: SESSION_TODOS, current: 't1' }),
  });
}

function questionCard(c) {
  const option = (
    n,
    title,
    desc,
    focused,
  ) => `<Frame w="fill" h="hug" flex="row" items="center" gap={12} px={12} py={10} rounded={10} bg="${focused ? c.hover : c.raised}" ${focused ? `stroke="${c.ring}" strokeWidth={2} strokeAlign="inside"` : ''}>
<Frame w={22} h={22} flex="row" items="center" justify="center" rounded={6} bg="${c.window}">${T(c, 12, 16, 600, 'ink2', String(n), '', mono)}</Frame>
<Frame w="fill" h="hug" flex="col" gap={2}>${T(c, 14, 20, 500, 'ink', title)}${T(c, 12, 16, 400, 'ink3', desc)}</Frame>
${focused ? I(c, 'check', 'ink', 16) : ''}</Frame>`;
  return `<Frame name="Question" w="fill" h="hug" flex="col" gap={12} p={16} rounded={14} bg="${c.raised}">
<Frame w="fill" h="hug" flex="row" items="center" gap={8}>${I(c, 'message-circle-question', 'ink2', 16)}${T(c, 14, 20, 600, 'ink', '어떤 상황을 타임아웃으로 볼까요?')}${SP}${T(c, 12, 16, 500, 'warn', '답변 대기')}</Frame>
${T(c, 12, 18, 400, 'ink3', '기준에 따라 재현 명령과 검증 명령이 달라집니다.')}
<Frame w="fill" h="hug" flex="col" gap={6}>
${option(1, '응답이 10초를 넘을 때', 'CLI 기본 타임아웃과 같습니다', false)}
${option(2, '응답이 30초를 넘을 때', 'MCP 기본 타임아웃과 같습니다', true)}
${option(3, '오류 응답이 돌아올 때', '시간과 관계없이 실패한 호출을 모두 봅니다', false)}
<Frame w="fill" h={40} flex="row" items="center" gap={10} px={12} rounded={10} bg="${c.window}">${I(c, 'pencil', 'ink3', 14)}${T(c, 13, 18, 400, 'ink3', '직접 입력합니다')}</Frame>
</Frame>
<Frame w="fill" h="hug" flex="row" items="center" gap={8}>${T(c, 12, 16, 400, 'ink3', '숫자 키로 고르고 Enter로 답합니다')}${SP}${button(c, 'primary', '답하기', { keyHint: '↵' })}</Frame>
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
      rows: [
        {
          title: '검색 도구 타임아웃 조사',
          meta: '답변 대기, 제목 일치',
          selected: true,
          dot: 'warn',
        },
        { title: 'MCP 연결 끊김 조사', meta: '완료, 3일 전, todo 일치', dot: 'ok' },
      ],
    },
  ];
  const main =
    header(c, { title: '검색 도구 타임아웃 조사', repo: 'notes', stage: 0 }) +
    thread(
      c,
      [
        userBubble(c, '검색 도구가 가끔 타임아웃으로 끝나요. 원인을 찾아 주세요.'),
        `<Frame w="fill" h="hug" flex="col" gap={4}>${toolLine(c, { icon: 'file-text', verb: '읽기', target: 'src/search.ts' })}${toolLine(c, { icon: 'search', verb: '검색', target: 'timeout' })}</Frame>`,
        reply(
          c,
          '검색 도구 호출이 기대보다 오래 걸려 실패하는 원인을 찾는 작업으로 이해했습니다. 시작하기 전에 타임아웃 기준을 하나 정해야 합니다.',
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

function field(c, label, control, hint = '설정 기본값') {
  return `<Frame w="fill" h={44} flex="row" items="center" gap={16}>${T(c, 13, 18, 500, 'ink2', label, 'w={112}')}${control}${SP}${T(c, 12, 16, 400, 'ink3', hint)}</Frame>`;
}
function select(c, icon, value, caret = true) {
  return `<Frame w={240} h={32} flex="row" items="center" gap={8} px={10} rounded={8} bg="${c.raised}">${icon ? I(c, icon, 'ink2', 14) : ''}${T(c, 13, 18, 400, 'ink', value, 'grow={1}')}${caret ? I(c, 'chevron-down', 'ink3', 12) : ''}</Frame>`;
}
function segmented(c, items, selected, font = undefined) {
  const item = ([label, icon], i) => {
    const on = i === selected;
    return `<Frame w="hug" h={28} grow={1} flex="row" items="center" justify="center" gap={6} px={10} rounded={6} ${on ? `bg="${c.window}" shadow="0 1 2 #0000001F"` : ''}>${icon ? I(c, icon, on ? 'ink' : 'ink3', 14) : ''}${T(c, 13, 18, on ? 600 : 500, on ? 'ink' : 'ink3', label, '', font)}</Frame>`;
  };
  return `<Frame w="hug" h={32} flex="row" items="center" gap={2} p={2} rounded={8} bg="${c.raised}">${items.map(item).join('')}</Frame>`;
}

function newSessionScreen() {
  const c = palette('Dark');
  const groups = GROUPS.map((g) => ({
    ...g,
    rows: g.rows.map((r) => ({ ...r, selected: false })),
  }));
  const form = `<Frame name="NewSessionForm" w="fill" h="fill" flex="col" items="center" pt={24}>
<Frame w={640} h="hug" flex="col" gap={20}>
<Frame w="fill" h="hug" flex="col" gap={8}>${T(c, 13, 18, 500, 'ink2', '작업 요청')}
<Frame w="fill" h={132} flex="col" p={14} rounded={14} bg="${c.raised}">${T(c, 15, 24, 400, 'ink', 'README의 설치 절차를 pnpm 기준으로 갱신하고, 예제가 실제로 도는지 확인해 주세요.', 'w="fill" textAutoResize="height"')}</Frame></Frame>
<Frame w="fill" h="hug" flex="col">
${field(c, '저장소', select(c, 'folder', 'math-demo'), '마지막으로 쓴 저장소')}
${field(c, '기준 브랜치', select(c, 'git-branch', 'main'))}
${field(c, '모델', select(c, 'cpu', '기본 모델'))}
${field(c, '카테고리', select(c, 'layers', '자동'), 'Ora가 요청을 보고 고릅니다')}
${field(c, '권한 모드', segmented(c, [['항상 묻기'], ['쓰기 허용'], ['승인 생략']], 2))}
${field(c, '격리', segmented(c, [['none'], ['harness'], ['clean-home']], 1, mono))}
${field(c, '비용 상한', select(c, null, '없음', false))}
</Frame>
<Frame w="fill" h="hug" flex="row" items="center" gap={8}>${T(c, 12, 16, 400, 'ink3', '항목마다 설정 파일의 기본값을 미리 채웠습니다')}${SP}${button(c, 'ghost', '취소')}${button(c, 'primary', '세션 시작', { keyHint: '⌘↵' })}</Frame>
</Frame>
</Frame>`;
  return windowFrame(c, '04 New Session · Dark', {
    side: sidebar(c, { groups }),
    main: header(c, { title: '새 세션' }) + form,
  });
}

function emptyScreen() {
  const c = palette('Dark');
  const chip = (icon, label) =>
    `<Frame w="hug" h={28} flex="row" items="center" gap={6} px={10} rounded={8} bg="${c.raised}">${I(c, icon, 'ink2', 14)}${T(c, 13, 18, 500, 'ink2', label)}${I(c, 'chevron-down', 'ink3', 12)}</Frame>`;
  const key = (k, label) =>
    `<Frame w="hug" h="hug" flex="row" items="center" gap={6}>${T(c, 12, 16, 500, 'ink2', k, '', mono)}${T(c, 12, 16, 400, 'ink3', label)}</Frame>`;
  const main = `${header(c)}<Frame name="Welcome" w="fill" h="fill" flex="col" items="center" justify="center" gap={20} pb={80}>
<Frame w={720} h="hug" flex="col" gap={6}>${T(c, 24, 32, 600, 'ink', '무엇을 할까요?')}${T(c, 14, 22, 400, 'ink3', 'Ora는 계획을 세우고, 검증 명령으로 결과를 확인한 뒤 완료를 보고합니다.')}</Frame>
<Frame w={720} h="hug" flex="col" gap={8}>
<Frame w="fill" h="hug" flex="row" gap={6}>${chip('folder', 'math-demo')}${chip('git-branch', 'main')}</Frame>
${composer(c)}
</Frame>
<Frame w={720} h="hug" flex="row" gap={20} px={14}>${key('⌘K', '명령 팔레트')}${key('⌘N', '새 세션 폼')}${key('⌘,', '설정')}</Frame>
</Frame>`;
  return windowFrame(c, '05 Empty · Dark', { side: sidebar(c, { empty: true }), main });
}

function crashedScreen() {
  const c = palette('Dark');
  const groups = GROUPS.map((g) => ({
    ...g,
    rows: g.rows.map((r) =>
      r.title === 'README 설치 절차 갱신'
        ? { ...r, meta: '강제 종료, 재개 가능', selected: true, dot: 'warn' }
        : { ...r, selected: false },
    ),
  }));
  const badge = `<Frame w="hug" h={24} flex="row" items="center" gap={4} px={8} rounded={6} bg="${c.raised}">${I(c, 'circle-pause', 'ink2', 12)}${T(c, 12, 16, 500, 'ink2', '강제 종료')}</Frame>`;
  const aborted = `${I(c, 'circle-pause', 'ink3', 14)}${T(c, 12, 16, 500, 'ink3', 'aborted', '', mono)}`;
  const notice = `<Frame name="ResumeNotice" w="fill" h="hug" flex="col" gap={12} p={16} rounded={14} bg="${c.raised}">
<Frame w="fill" h="hug" flex="row" items="center" gap={8}>${I(c, 'triangle-alert', 'warn', 16)}${T(c, 14, 20, 600, 'ink', '하드 킬로 세션을 멈췄습니다')}${SP}${T(c, 12, 16, 400, 'ink3', '10:42')}</Frame>
${T(c, 13, 20, 400, 'ink2', '실행 중이던 도구 호출 1개를 aborted로 기록했습니다. 작업 폴더의 변경은 그대로 있습니다.', 'w="fill" textAutoResize="height"')}
<Frame w="fill" h="hug" flex="col" gap={4} px={12} py={10} rounded={10} bg="${c.window}">
<Frame w="fill" h="hug" flex="row" items="center" gap={8}>${T(c, 12, 16, 500, 'ink3', '재개 지점')}${T(c, 13, 18, 500, 'ink', 't2 README 예제 출력을 확인한다')}</Frame>
${T(c, 12, 16, 400, 'ink3', '마지막 검증 증거가 있는 t1 다음부터 다시 실행합니다.')}
</Frame>
<Frame w="fill" h="hug" flex="row" items="center" gap={8}>${SP}${button(c, 'ghost', '기록만 보기')}${button(c, 'primary', 't2부터 재개', { icon: 'rotate-ccw' })}</Frame>
</Frame>`;
  const main =
    header(c, {
      title: 'README 설치 절차 갱신',
      repo: 'math-demo',
      stage: 5,
      diff: [12, 3],
      badge,
    }) +
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

function themeScreen() {
  const c = palette('Light');
  const menu = `<Frame name="ThemeMenu" w="fill" h="hug" flex="col" gap={10} p={12} rounded={12} bg="${c.window}" shadow="0 8 24 #00000024">
${T(c, 12, 16, 500, 'ink3', '테마')}
${segmented(
  c,
  [
    ['라이트', 'sun'],
    ['다크', 'moon'],
    ['시스템', 'monitor'],
  ],
  2,
).replace('w="hug" h={32}', 'w="fill" h={32}')}
${T(c, 12, 16, 400, 'ink3', '시스템은 OS 설정을 따르고, OS 설정이 바뀌면 바로 반영합니다.', 'w={224} textAutoResize="height"')}
</Frame>`;
  return windowFrame(c, '07 Theme · Light', {
    side: sidebar(c, { groups: GROUPS, popover: menu }),
    main: sessionMain(c),
    panel: evidence(c, { todos: SESSION_TODOS, current: 't1' }),
  });
}

export const SCREENS = [
  { file: 'components-dark', jsx: componentBoard },
  { file: 'session-dark', jsx: () => sessionScreen('Dark') },
  { file: 'question-dark', jsx: questionScreen },
  { file: 'new-session-dark', jsx: newSessionScreen },
  { file: 'empty-dark', jsx: emptyScreen },
  { file: 'crashed-dark', jsx: crashedScreen },
  { file: 'theme-light', jsx: themeScreen },
];
