// Ora 시안(방향 D)의 부품. 함수마다 OpenPencil 0.16 `render` 도구의 `jsx` 인자에 넣을 JSX 문자열을 돌려준다.
// OpenPencil 0.16의 JSX는 문자열 전체가 식 하나여야 하고, Icon은 토큰 변수 색을 연결하지 못한다.
// 그래서 이 파일은 토큰 정본(design/tokens/Ora/*.tokens.json)과 같은 hex 값을 직접 쓴다.
const F = 'Pretendard';
const M = 'JetBrains Mono';

const DARK = {
  window: '#1F1F1F',
  sidebar: '#181818',
  raised: '#2A2A2A',
  sunken: '#161616',
  hover: '#262626',
  line: '#2C2C2C',
  ink: '#ECECEC',
  ink2: '#B4B4B4',
  ink3: '#939393',
  add: '#3FB950',
  del: '#FF7B72',
  warn: '#D29922',
  ok: '#3FB950',
  addBg: '#12261A',
  delBg: '#2D1517',
  primary: '#ECECEC',
  onPrimary: '#1F1F1F',
  ring: '#8AB4F8',
  overlay: '#00000099',
  popover: '#333333',
  borderStrong: '#4D4D4D',
};
const LIGHT = {
  window: '#FFFFFF',
  sidebar: '#F9F9F9',
  raised: '#F4F4F4',
  sunken: '#F7F7F8',
  hover: '#EFEFEF',
  line: '#E8E8E8',
  ink: '#0D0D0D',
  ink2: '#4A4A4A',
  ink3: '#6B6B6B',
  add: '#116329',
  del: '#CF222E',
  warn: '#7D5300',
  ok: '#116329',
  addBg: '#E6F4EA',
  delBg: '#FDECEC',
  primary: '#0D0D0D',
  onPrimary: '#FFFFFF',
  ring: '#1A66D9',
  overlay: '#0000004D',
  popover: '#FFFFFF',
  borderStrong: '#D4D4D4',
};
export const palette = (mode) => (mode === 'Light' ? LIGHT : DARK);

export const T = (c, size, lh, weight, color, body, extra = '', font = F) =>
  `<Text size={${size}} lineHeight={${lh}} weight={${weight}} font="${font}" color="${c[color] ?? color}" ${extra}>${body}</Text>`;
export const I = (c, name, color, size = 14) =>
  `<Icon name="lucide:${name}" size={${size}} color="${c[color] ?? color}" />`;
export const SP = '<Frame name="Spacer" w="fill" h={1} />';
// 글 안의 코드 조각. Span은 배경을 못 가지므로 고정폭 글꼴과 밝은 글자로만 구분한다.
export const code = (c, s) => `<Span font="${M}" size={13} color="${c.ink}">${s}</Span>`;
export const mono = M;

const STATUS_DOT = { ok: 'ok', warn: 'warn', del: 'del', none: null };

function stat(c, add, del) {
  return T(c, 12, 16, 500, 'add', '+' + add, '', M) + T(c, 12, 16, 500, 'del', '−' + del, '', M);
}

// 스택에서 한 층 들어갈 때마다 왼쪽 여백을 14px씩 늘린다.
const STACK_INDENT = 14;

function sessionRow(c, { title, meta = null, selected = false, dot = 'none' }, depth) {
  const dotColor = STATUS_DOT[dot];
  return `<Frame w="fill" h="hug" flex="col" gap={2} pl={${42 + STACK_INDENT * depth}} pr={10} py={6} rounded={8} bg="${selected ? c.hover : c.sidebar}">
<Frame w="fill" h="hug" flex="row" items="center" gap={6}>${dotColor ? `<Ellipse w={6} h={6} bg="${c[dotColor]}" />` : ''}${T(c, 13, 18, selected ? 500 : 400, selected ? 'ink' : 'ink2', title, 'grow={1} maxLines={1} truncate')}</Frame>
${meta ? T(c, 12, 16, 400, 'ink3', meta) : ''}</Frame>`;
}

/**
 * 워크트리 행. 워크트리를 고르면 그 워크트리의 새 세션 화면이 열린다. 변경 통계는 세션이 아니라 워크트리에 붙는다.
 * depth는 스택에서 부모 워크트리 아래로 들어간 깊이다. 부모가 타깃 브랜치이면 0이고, 0보다 크면 꺾인 화살표로 부모를 가리킨다.
 */
function worktreeRow(c, { name, add, del, selected = false }, depth) {
  const icon = depth > 0 ? 'corner-down-right' : 'git-branch';
  return `<Frame w="fill" h={28} flex="row" items="center" gap={8} pl={${20 + STACK_INDENT * depth}} pr={10} rounded={8} bg="${selected ? c.hover : c.sidebar}">${I(c, icon, selected ? 'ink' : 'ink3', 13)}${T(c, 13, 18, selected ? 500 : 400, selected ? 'ink' : 'ink2', name, 'grow={1} maxLines={1} truncate', M)}${stat(c, add, del)}${selected ? I(c, 'plus', 'ink2', 14) : ''}</Frame>`;
}

/** 워크트리와 그 위에 쌓은 자식 워크트리(stack)를 깊이 우선으로 펼친다. */
function worktreeTree(c, wt, depth = 0) {
  return (
    worktreeRow(c, wt, depth) +
    (wt.sessions ?? []).map((s) => sessionRow(c, s, depth)).join('') +
    (wt.stack ?? []).map((child) => worktreeTree(c, child, depth + 1)).join('')
  );
}

function searchBox(c, { query, filters, filter, summary }) {
  const chip = (f) => {
    const on = f === filter;
    return `<Frame w="hug" h={24} flex="row" items="center" px={8} rounded={6} bg="${on ? c.hover : c.sidebar}">${T(c, 12, 16, on ? 600 : 500, on ? 'ink' : 'ink3', f)}</Frame>`;
  };
  return `<Frame w="fill" h="hug" flex="col" gap={8} px={2}>
<Frame w="fill" h={32} flex="row" items="center" gap={8} px={10} rounded={8} bg="${c.raised}">${I(c, 'search', 'ink3', 14)}${T(c, 13, 18, 400, 'ink', query, 'grow={1}')}${I(c, 'x', 'ink3', 14)}</Frame>
<Frame w="fill" h="hug" flex="row" wrap gap={4} rowGap={4}>${filters.map(chip).join('')}</Frame>
<Frame w="fill" h="hug" flex="row" px={8}>${T(c, 12, 16, 400, 'ink3', summary)}</Frame>
</Frame>`;
}

export function sidebar(c, { groups = [], empty = false, search = null } = {}) {
  const lights = ['#FF5F57', '#FEBC2E', '#28C840']
    .map((x) => `<Ellipse w={12} h={12} bg="${x}" />`)
    .join('');
  const group = ({ repo, worktrees }) => `<Frame w="fill" h="hug" flex="col" gap={1}>
<Frame w="fill" h={28} flex="row" items="center" gap={8} px={10}>${I(c, 'folder', 'ink3', 14)}${T(c, 13, 18, 500, 'ink2', repo)}</Frame>${worktrees.map((wt) => worktreeTree(c, wt)).join('')}</Frame>`;
  const body = empty
    ? `<Frame w="fill" h="hug" flex="col" gap={4} px={10} pt={4}>${T(c, 13, 18, 500, 'ink2', '아직 세션이 없습니다')}${T(c, 12, 16, 400, 'ink3', '오른쪽 입력창에 첫 작업을 적으면 세션이 생깁니다.', 'w={220} textAutoResize="height"')}</Frame>`
    : groups.map(group).join('');
  return `<Frame name="Sidebar" w={264} h="fill" flex="col" gap={16} pt={16} pb={12} px={8} bg="${c.sidebar}">
<Frame w="fill" h={20} flex="row" items="center" gap={8} px={10}>${lights}${SP}${I(c, 'square-pen', 'ink2', 16)}</Frame>
<Frame w="fill" h="hug" flex="row" items="center" gap={8} px={10} pt={6}>${I(c, 'message-square', 'ink2', 15)}${T(c, 13, 18, 500, 'ink2', '세션', 'grow={1}')}${search ? '' : I(c, 'search', 'ink3', 14)}</Frame>
${search ? searchBox(c, search) : ''}
${body}
<Frame w="fill" h="fill" />
<Frame w="fill" h={32} flex="row" items="center" gap={8} px={10}><Ellipse w={8} h={8} bg="${c.ok}" />${T(c, 13, 18, 400, 'ink2', 'MacBook-Pro', 'grow={1}')}${I(c, 'plus', 'ink3', 16)}${I(c, 'settings', 'ink3', 16)}</Frame>
</Frame>`;
}

const STAGES = [
  'Understand',
  'Research',
  'Decide',
  'Plan',
  'Execute',
  'Verify',
  'Operate',
  'Learn',
];
function stageDotColor(c, i, cur) {
  if (i < cur) return c.ok;
  if (i === cur) return c.ink;
  return c.ink3;
}
export function header(c, { title = '', repo = null, stage = null, diff = null, badge = '' } = {}) {
  const stageChip =
    stage === null
      ? ''
      : `<Frame w="hug" h={28} flex="row" items="center" gap={8} px={10} rounded={8} bg="${c.raised}"><Frame w="hug" h="hug" flex="row" gap={3}>${STAGES.map((_, i) => `<Ellipse w={6} h={6} bg="${stageDotColor(c, i, stage)}" />`).join('')}</Frame>${T(c, 12, 16, 500, 'ink', STAGES[stage])}${T(c, 12, 16, 400, 'ink3', `${stage + 1}/8`)}</Frame>`;
  const diffChip =
    diff === null
      ? ''
      : `<Frame w="hug" h={28} flex="row" items="center" gap={6} px={10} rounded={8} bg="${c.raised}">${I(c, 'git-compare', 'ink2', 14)}${T(c, 12, 16, 500, 'add', '+' + diff[0], '', M)}${T(c, 12, 16, 500, 'del', '−' + diff[1], '', M)}</Frame>`;
  return `<Frame name="Header" w="fill" h={48} flex="row" items="center" gap={12} px={20}>
${I(c, 'panel-left', 'ink2', 16)}${title ? T(c, 14, 20, 600, 'ink', title) : ''}${repo ? T(c, 13, 18, 400, 'ink3', repo) : ''}${badge}${SP}${stageChip}${diffChip}
</Frame>`;
}

export function userBubble(c, text) {
  return `<Frame w="fill" h="hug" flex="row" justify="end"><Frame w="hug" maxW={520} h="hug" px={16} py={10} rounded={18} bg="${c.raised}">${T(c, 15, 24, 400, 'ink', text, 'w={488} textAutoResize="height"')}</Frame></Frame>`;
}

export function reply(c, html) {
  return `<Text size={15} lineHeight={24} weight={400} font="${F}" color="${c.ink2}" w="fill" textAutoResize="height">${html}</Text>`;
}

export function toolLine(c, { icon, verb, target, add = null, del = null, status = '' }) {
  return `<Frame w="fill" h={28} flex="row" items="center" gap={8}>${I(c, icon, 'ink3', 15)}${T(c, 13, 18, 500, 'ink2', verb)}${T(c, 13, 18, 400, 'ink2', target, '', M)}${add === null ? '' : stat(c, add, del)}${status ? SP + status : ''}</Frame>`;
}

const DIFF_BG = { '+': 'addBg', '-': 'delBg', ' ': 'sunken' };
export function diffBlock(c, rows) {
  const row = ([n, sign, text]) =>
    `<Frame w="fill" h={22} flex="row" items="center" gap={10} px={12} bg="${c[DIFF_BG[sign]]}">${T(c, 12, 18, 400, 'ink3', n, '', M)}${T(c, 12, 18, 400, sign === '+' ? 'add' : 'del', sign, '', M)}${T(c, 12, 18, 400, 'ink', text, '', M)}</Frame>`;
  return `<Frame w="fill" h="hug" flex="col" py={6} rounded={10} bg="${c.sunken}" overflow="hidden">${rows.map(row).join('')}</Frame>`;
}

const BUTTON = {
  primary: ['primary', 600, 'onPrimary'],
  secondary: ['hover', 500, 'ink'],
  ghost: [null, 500, 'ink2'],
};
export function button(c, kind, label, { icon = null, keyHint = null, extra = '' } = {}) {
  const [bg, weight, fg] = BUTTON[kind];
  return `<Frame w="hug" h={30} flex="row" items="center" gap={6} px={12} rounded={8} ${bg ? `bg="${c[bg]}"` : ''} ${extra}>${icon ? I(c, icon, fg, 14) : ''}${T(c, 13, 18, weight, fg, label)}${keyHint ? T(c, 11, 14, 500, fg, keyHint, 'opacity={0.7}', M) : ''}</Frame>`;
}

export function approvalCard(c) {
  return `<Frame name="Approval" w="fill" h="hug" flex="col" gap={12} p={16} rounded={14} bg="${c.raised}">
<Frame w="fill" h="hug" flex="row" items="center" gap={8}>${I(c, 'shield-check', 'warn', 16)}${T(c, 14, 20, 600, 'ink', '이 명령을 실행할까요?')}${SP}${T(c, 12, 16, 500, 'warn', '위험도 보통')}</Frame>
<Frame w="fill" h="hug" flex="row" items="start" gap={8} px={12} py={10} rounded={10} bg="${c.window}"><Frame w="fill" h="hug" flex="col" gap={2}>${T(c, 13, 20, 400, 'ink', '$ node check.js', '', M)}${T(c, 12, 18, 400, 'ink3', 'cwd ~/projects/math-demo', '', M)}</Frame>${I(c, 'pencil', 'ink3', 14)}</Frame>
${T(c, 12, 18, 400, 'ink3', 't1의 검증 명령입니다. 엔진이 실행하고, 종료 코드와 출력을 증거로 남깁니다.', 'w="fill" textAutoResize="height"')}
<Frame w="fill" h="hug" flex="row" items="center" gap={8}>${SP}${button(c, 'ghost', '거부')}${button(c, 'secondary', '이 세션 동안 허용')}${button(c, 'primary', '실행', { keyHint: '↵' })}</Frame>
</Frame>`;
}

const CHIP_ICON = { model: 'cpu', permission: 'shield' };
export function composer(
  c,
  {
    placeholder = null,
    running = false,
    width = 720,
    model = '기본 모델',
    effort = 'medium',
    modelOpen = false,
  } = {},
) {
  const hint =
    placeholder ??
    (running
      ? '조향 메시지를 입력합니다. 현재 스텝이 끝난 뒤 반영합니다'
      : 'Ora에게 메시지, @파일, /명령');
  const chip = (kind, label, caret) =>
    `<Frame name="Chip/${kind}" w="hug" h={26} flex="row" items="center" gap={4} px={8} rounded={8} ${kind === 'model' && modelOpen ? `bg="${c.hover}"` : ''}>${CHIP_ICON[kind] ? I(c, CHIP_ICON[kind], 'ink2', 14) : ''}${T(c, 12, 16, 500, 'ink2', label, '', kind === 'model' && model !== '기본 모델' ? M : F)}${caret ? I(c, 'chevron-down', 'ink3', 12) : ''}</Frame>`;
  const action = running ? I(c, 'square', 'onPrimary', 12) : I(c, 'arrow-up', 'onPrimary', 16);
  return `<Frame name="Composer" w={${width}} h="hug" flex="col" gap={10} pt={12} pb={10} px={14} rounded={18} bg="${c.raised}">
${T(c, 15, 22, 400, 'ink3', hint, 'w="fill"')}
<Frame w="fill" h={28} flex="row" items="center" gap={6}>${I(c, 'paperclip', 'ink3', 16)}${chip('model', model, true)}${chip('effort', effort, true)}${chip('permission', '승인 생략', false)}${SP}<Frame w={30} h={30} flex="row" items="center" justify="center" rounded={15} bg="${c.primary}">${action}</Frame></Frame>
</Frame>`;
}

/**
 * 라우팅 미리보기. 입력창 바로 아래 한 줄에 이번 세션이 쓸 역할과 모델 체인, 추론 강도, 로그인 상태를 보여 준다.
 * chain은 { model, effort, signedIn, picked } 목록이고, picked는 사용자가 고른 모델이다.
 */
export function routingPreview(c, { role = 'default', chain }) {
  const item = (m, i) => {
    const state = m.signedIn
      ? ''
      : `<Frame w="hug" h="hug" flex="row" items="center" gap={3}>${I(c, 'circle-alert', 'warn', 12)}${T(c, 12, 16, 500, 'warn', '로그인 필요')}</Frame>`;
    const picked = m.picked ? T(c, 12, 16, 500, 'ink2', '· 직접 고름') : '';
    return `<Frame w="hug" h="hug" flex="row" items="center" gap={5}>${T(c, 12, 16, 500, 'ink3', String(i + 1), '', M)}${T(c, 12, 16, 500, 'ink', m.model, '', M)}${T(c, 12, 16, 400, 'ink2', m.effort)}${picked}${state}</Frame>`;
  };
  const arrow = I(c, 'arrow-right', 'ink3', 12);
  return `<Frame name="RoutingPreview" w={720} h="hug" flex="row" items="center" gap={8} px={14} wrap={true}>${T(c, 12, 16, 500, 'ink3', `역할 ${role}`)}${T(c, 12, 16, 400, 'ink3', '·')}${chain.map(item).join(arrow)}</Frame>`;
}

/**
 * 모델 칩을 누르면 뜨는 모델 고르기 팝오버. 줄 전체가 버튼이다.
 * groups는 [제목, [{ model, provider, effort, signedIn, selected }]] 목록이다.
 */
export function modelPicker(c, { x, y, groups, note }) {
  const row = (m) => {
    const right = m.signedIn
      ? T(c, 12, 16, 400, 'ink3', m.provider)
      : `<Frame w="hug" h="hug" flex="row" items="center" gap={3}>${I(c, 'circle-alert', 'warn', 12)}${T(c, 12, 16, 500, 'warn', '로그인 필요')}</Frame>`;
    return `<Frame w="fill" h={32} flex="row" items="center" gap={8} px={10} rounded={6} ${m.selected ? `bg="${c.hover}"` : ''}><Frame w={14} h={14} flex="row" items="center">${m.selected ? I(c, 'check', 'ink', 14) : ''}</Frame>${T(c, 13, 18, 500, m.signedIn ? 'ink' : 'ink2', m.model, 'grow={1}', M)}${T(c, 12, 16, 400, 'ink2', m.effort ?? '')}${right}</Frame>`;
  };
  const group = ([title, items]) =>
    `<Frame w="fill" h="hug" flex="col" gap={2}><Frame w="fill" h="hug" px={10} pt={6} pb={2}>${T(c, 12, 16, 500, 'ink3', title)}</Frame>${items.map(row).join('')}</Frame>`;
  return `<Frame name="ModelPicker" position="absolute" x={${x}} y={${y}} w={340} h="hug" flex="col" gap={4} p={4} rounded={10} bg="${c.popover}" stroke="${c.borderStrong}" strokeWidth={1} strokeAlign="inside">${groups.map(group).join('')}<Frame w="fill" h="hug" px={10} pt={4} pb={6}>${T(c, 12, 18, 400, 'ink2', note, 'w="fill" textAutoResize="height"')}</Frame></Frame>`;
}

/** 대화 안의 모델 전환 표시. 폴백과 첫 모델 복귀를 같은 모양으로 보이고, 이유와 시각을 함께 적는다. */
export function modelSwitchMark(
  c,
  { from, to, reason, time, icon = 'arrow-right-left', label = '모델을 바꿨습니다' },
) {
  const rule = `<Frame w="fill" h={1} bg="${c.line}" />`;
  return `<Frame name="ModelSwitch" w="fill" h="hug" flex="row" items="center" gap={10}>${rule}<Frame w="hug" h="hug" flex="row" items="center" gap={6}>${I(c, icon, 'warn', 14)}${T(c, 12, 16, 500, 'ink2', label)}${T(c, 12, 16, 500, 'ink', from, '', M)}${I(c, 'arrow-right', 'ink3', 12)}${T(c, 12, 16, 500, 'ink', to, '', M)}${T(c, 12, 16, 400, 'ink3', `· ${reason} · ${time}`)}</Frame>${rule}</Frame>`;
}

/** 상태 표시줄. 입력창 바로 아래 한 줄에 스텝 수, 사용 모델, 격리 옵션을 적는다. items는 [글자, 색 이름] 쌍이다. */
function statusLine(c, items) {
  const sep = T(c, 12, 16, 400, 'ink3', '·');
  return `<Frame name="StatusLine" w={720} h={20} flex="row" items="center" gap={8} px={14}>${items.map(([text, color = 'ink3']) => T(c, 12, 16, 400, color, text)).join(sep)}</Frame>`;
}

const TODO_STATUS = {
  pending: ['대기', 'circle', 'ink3'],
  attempted: ['시도함', 'circle-dashed', 'warn'],
  claimed_verified: ['모델 확인', 'circle-dot', 'ink2'],
  verified: ['검증됨', 'circle-check', 'ok'],
  failed: ['실패', 'circle-x', 'del'],
  interrupted: ['중단됨', 'circle-pause', 'ink3'],
};
export function evidence(c, { todos = [], current = null } = {}) {
  const total = todos.length;
  const verified = todos.filter((t) => t.status === 'verified').length;
  const bar = total ? Math.round((308 * verified) / total) : 0;
  const row = (t) => {
    const [label, icon, col] = TODO_STATUS[t.status];
    const cmdRow = t.cmd
      ? `<Frame w="fill" h="hug" flex="row" items="center" gap={6} pt={2}>${T(c, 12, 16, 400, 'ink2', t.cmd, 'grow={1}', M)}${T(c, 12, 16, 500, t.resultColor ?? 'ink3', t.result ?? '', '', M)}</Frame>`
      : T(c, 12, 16, 400, 'ink3', '검증 명령을 아직 선언하지 않았습니다');
    return `<Frame name="Todo/${t.id}" w="fill" h="hug" flex="row" items="start" gap={10} px={10} py={10} rounded={10} bg="${t.id === current ? c.hover : c.sidebar}">
<Frame w={16} h={20} flex="row" items="center">${I(c, icon, col, 16)}</Frame>
<Frame w="fill" h="hug" flex="col" gap={4}>${T(c, 13, 20, 500, 'ink', t.title, 'w={270} textAutoResize="height"')}
<Frame w="fill" h="hug" flex="row" items="center" gap={6}>${T(c, 12, 16, 500, col, label)}${t.origin ? T(c, 12, 16, 400, 'ink3', '출처 ' + t.origin) : ''}</Frame>
${cmdRow}</Frame></Frame>`;
  };
  const body = total
    ? `<Frame w="fill" h="hug" flex="col" gap={2} px={8}>${todos.map(row).join('')}</Frame>`
    : `<Frame w="fill" h="hug" flex="col" gap={4} px={16} pt={8}>${T(c, 13, 18, 500, 'ink2', '할 일이 아직 없습니다')}${T(c, 12, 16, 400, 'ink3', 'Plan 단계에서 Ora가 할 일과 검증 명령을 정하면 여기에 쌓입니다.', 'w={300} textAutoResize="height"')}</Frame>`;
  return `<Frame name="Evidence" w={340} h="fill" flex="col" bg="${c.sidebar}">
<Frame w="fill" h={48} flex="row" items="center" gap={16} px={16}>${T(c, 13, 18, 600, 'ink', '할 일')}${T(c, 13, 18, 500, 'ink3', '변경')}${T(c, 13, 18, 500, 'ink3', '파일')}${SP}${T(c, 12, 16, 500, 'ink2', `${verified}/${total}`, '', M)}</Frame>
<Frame w="fill" h="hug" px={16} pb={8}><Frame w="fill" h={3} flex="row" rounded={2} bg="${c.line}">${bar ? `<Frame w={${bar}} h={3} rounded={2} bg="${c.ok}" />` : ''}</Frame></Frame>
${body}
</Frame>`;
}

const PHASE_TODO_STATUS = {
  ...TODO_STATUS,
  blocked: ['막힘', 'octagon-pause', 'warn'],
  abandoned: ['포기함', 'circle-slash', 'ink3'],
};
// 흐름 항목의 종류. [아이콘, 색]이며, 글자가 항상 함께 붙으므로 색만으로 구분하지 않는다.
const FLOW = {
  try: ['play', 'ink2'],
  repair: ['wrench', 'warn'],
  claim: ['circle-dot', 'ink2'],
  pass: ['circle-check', 'ok'],
  fail: ['circle-x', 'del'],
  block: ['octagon-pause', 'warn'],
  unblock: ['play', 'ink2'],
  abandon: ['circle-slash', 'ink3'],
  more: ['chevrons-up', 'ink2'],
  gate: ['shield-alert', 'del'],
  waiveAsk: ['shield-question', 'warn'],
  waive: ['shield-check', 'ok'],
  waiveNo: ['shield-x', 'del'],
};

/**
 * phase로 나눈 할 일 패널. phase 카드의 머리(펼침 아이콘, 이름, 수치, 끝남 표시)는 줄 전체가 버튼 하나다.
 * phases[].todos[].flow는 [종류, 글자] 목록이고, banner는 패널 맨 위 안내 줄이다.
 */
export function phasePanel(
  c,
  { objective = null, banner = null, phases = [], current = null, overlay = '' } = {},
) {
  const all = phases.flatMap((p) => p.todos);
  const verified = all.filter((t) => t.status === 'verified').length;
  const denom = all.filter((t) => t.status !== 'abandoned').length;
  const bar = (n, d, w) =>
    `<Frame w="fill" h={3} flex="row" rounded={2} bg="${c.line}">${d && n ? `<Frame w={${Math.round((w * n) / d)}} h={3} rounded={2} bg="${c.ok}" />` : ''}</Frame>`;
  const flowRow = ([kind, text]) => {
    const [icon, col] = FLOW[kind];
    return `<Frame w="fill" h="hug" flex="row" items="start" gap={8} py={2}><Frame w={12} h={16} flex="row" items="center">${I(c, icon, col, 12)}</Frame>${T(c, 12, 16, 400, kind === 'more' ? 'ink2' : 'ink2', text, 'grow={1} textAutoResize="height"')}</Frame>`;
  };
  const todoRow = (t) => {
    const [baseLabel, icon, col] = PHASE_TODO_STATUS[t.status];
    const label = t.waived ? '검증됨 · 예외 승인' : baseLabel;
    const isCurrent = t.id === current;
    const tag = isCurrent
      ? `<Frame w="hug" h={18} flex="row" items="center" px={6} rounded={4} bg="${c.ink}">${T(c, 11, 14, 600, 'onPrimary', '작업 중')}</Frame>`
      : '';
    const menu =
      t.status === 'verified'
        ? ''
        : `<Frame name="Menu" w={24} h={24} flex="row" items="center" justify="center" rounded={6}>${I(c, 'ellipsis', 'ink2', 16)}</Frame>`;
    const cmd = t.cmd
      ? `<Frame w="fill" h="hug" flex="row" items="center" gap={6}>${T(c, 12, 16, 400, 'ink2', t.cmd, 'grow={1}', M)}${T(c, 12, 16, 500, t.resultColor ?? 'ink3', t.result ?? '', '', M)}</Frame>`
      : '';
    const reason = t.reason
      ? T(c, 12, 16, 400, 'ink', t.reason, 'w="fill" textAutoResize="height"')
      : '';
    const flow = t.flow?.length
      ? `<Frame name="Flow" w="fill" h="hug" flex="col" pt={4}>${t.flow.map(flowRow).join('')}</Frame>`
      : '';
    return `<Frame name="Todo/${t.id}" w="fill" h="hug" flex="row" items="start" gap={10} px={8} py={8} rounded={8} ${isCurrent ? `bg="${c.hover}"` : ''}>
<Frame w={16} h={20} flex="row" items="center">${I(c, icon, col, 16)}</Frame>
<Frame w="fill" h="hug" flex="col" gap={4}>
<Frame w="fill" h="hug" flex="row" items="start" gap={6}>${T(c, 13, 20, 500, t.status === 'abandoned' ? 'ink3' : 'ink', t.title, 'grow={1} textAutoResize="height"')}${tag}</Frame>
<Frame w="fill" h="hug" flex="row" items="center" gap={6}>${T(c, 12, 16, 500, col, label)}${t.origin ? T(c, 12, 16, 400, 'ink3', '출처 ' + t.origin) : ''}</Frame>
${reason}${cmd}${flow}</Frame>${menu}</Frame>`;
  };
  const card = (p) => {
    const done = p.todos.every((t) => t.status === 'verified' || t.status === 'abandoned');
    const n = p.todos.filter((t) => t.status === 'verified').length;
    const d = p.todos.filter((t) => t.status !== 'abandoned').length;
    const gaveUp = p.todos.length - d;
    let right;
    if (!done) right = T(c, 12, 16, 500, 'ink2', `${n}/${d}`, '', M);
    else if (d === 0)
      right = `${I(c, 'circle-slash', 'ink3', 14)}${T(c, 12, 16, 500, 'ink2', '모두 포기')}`;
    else if (gaveUp)
      right = `${I(c, 'circle-check', 'ok', 14)}${T(c, 12, 16, 500, 'ink2', `끝남 · 포기 ${gaveUp}`)}`;
    else {
      const waived = p.todos.filter((t) => t.waived).length;
      right = `${I(c, 'circle-check', 'ok', 14)}${T(c, 12, 16, 500, 'ok', '통과')}${waived ? T(c, 12, 16, 500, 'ink2', `· 예외 ${waived}`) : ''}`;
    }
    const steps = done && p.steps ? T(c, 12, 16, 400, 'ink3', `· 스텝 ${p.steps}`) : '';
    const head = `<Frame name="PhaseHead" w="fill" h="hug" flex="row" items="center" gap={8} px={10} py={10} rounded={10}>${I(c, p.open ? 'chevron-down' : 'chevron-right', 'ink2', 14)}${T(c, 13, 18, 600, 'ink', p.name, 'grow={1}')}${right}${steps}</Frame>`;
    const meta = done
      ? ''
      : `<Frame w="fill" h="hug" flex="col" gap={6} px={10} pb={${p.open ? 4 : 10}}>${p.criterion ? T(c, 12, 16, 400, 'ink2', '완료 조건 · ' + p.criterion, 'w="fill" textAutoResize="height"') : ''}${bar(n, d, 284)}</Frame>`;
    const body = p.open
      ? `<Frame w="fill" h="hug" flex="col" gap={2} px={4} pb={6}>${p.todos.map(todoRow).join('')}</Frame>`
      : '';
    return `<Frame name="Phase/${p.name}" w="fill" h="hug" flex="col" rounded={10} bg="${c.window}">${p.hover ? head.replace('rounded={10}>', `rounded={10} bg="${c.hover}">`) : head}${meta}${body}</Frame>`;
  };
  const bannerRow = banner
    ? `<Frame name="Banner" w="fill" h="hug" flex="row" items="start" gap={10} px={12} py={10} rounded={10} bg="${c.raised}">${I(c, banner.icon, banner.color, 16)}<Frame w="fill" h="hug" flex="col" gap={2}>${T(c, 13, 18, 600, 'ink', banner.title)}${T(c, 12, 16, 400, 'ink2', banner.body, 'w="fill" textAutoResize="height"')}</Frame></Frame>`
    : '';
  const goal = objective
    ? `<Frame name="Objective" w="fill" h="hug" flex="col" gap={2} px={8}>${T(c, 12, 16, 500, 'ink3', '목표')}${T(c, 13, 18, 400, 'ink2', objective, 'w="fill" textAutoResize="height"')}</Frame>`
    : '';
  return `<Frame name="Evidence" w={340} h="fill" flex="col" bg="${c.sidebar}">
<Frame w="fill" h={48} flex="row" items="center" gap={16} px={16}>${T(c, 13, 18, 600, 'ink', '할 일')}${T(c, 13, 18, 500, 'ink3', '변경')}${T(c, 13, 18, 500, 'ink3', '파일')}${SP}${T(c, 12, 16, 500, 'ink2', `검증 ${verified}/${denom}`, '', M)}</Frame>
<Frame w="fill" h="hug" flex="col" gap={10} px={8} pt={4}>${bannerRow}${goal}${phases.map(card).join('')}</Frame>
${overlay}
</Frame>`;
}

/**
 * 완성 무결성 게이트의 예외 승인 카드. 권한 모드와 상관없이 뜨고, 승인해야만 todo가 verified가 된다.
 * findings는 게이트가 찾은 항목 한 줄씩이다.
 */
export function waiverCard(c, { todo, command, exit, findings, reason }) {
  const finding = (s) => T(c, 12, 18, 400, 'ink', s, 'w="fill" textAutoResize="height"', M);
  return `<Frame name="WaiverCard" w="fill" h="hug" flex="col" gap={12} p={16} rounded={14} bg="${c.raised}">
<Frame w="fill" h="hug" flex="row" items="center" gap={8}>${I(c, 'shield-question', 'warn', 16)}${T(c, 14, 20, 600, 'ink', '검증 예외를 승인할까요?')}${SP}${T(c, 12, 16, 500, 'ink2', todo.id)}</Frame>
${T(c, 13, 20, 400, 'ink2', `${todo.title}. 검증 명령은 통과했지만 완성 무결성 게이트가 아래 항목을 찾았습니다.`, 'w="fill" textAutoResize="height"')}
<Frame w="fill" h="hug" flex="col" gap={4} px={12} py={10} rounded={10} bg="${c.window}">${T(c, 12, 16, 500, 'ink3', `$ ${command} · exit ${exit}`, '', M)}${findings.map(finding).join('')}</Frame>
<Frame w="fill" h="hug" flex="col" gap={4}>${T(c, 12, 16, 500, 'ink3', '모델이 적은 사유')}${T(c, 13, 20, 400, 'ink', reason, 'w="fill" textAutoResize="height"')}</Frame>
${T(c, 12, 18, 400, 'ink3', '승인하면 이 할 일은 "검증됨 · 예외 승인"으로 남고, 증거에 사유를 기록합니다. 거부하면 실패로 남아 모델이 다시 고칩니다.', 'w="fill" textAutoResize="height"')}
<Frame w="fill" h="hug" flex="row" items="center" gap={8}>${SP}${button(c, 'ghost', '거부')}${button(c, 'primary', '예외 승인', { keyHint: '↵' })}</Frame>
</Frame>`;
}

/** overlay는 창 위에 겹쳐 그릴 JSX다. 그 안의 프레임은 position="absolute"로 창 기준 좌표에 놓는다. */
export function windowFrame(c, name, { side, main, panel = '', overlay = '' }) {
  return `<Frame name="${name}" w={1440} h={900} flex="row" bg="${c.window}" overflow="hidden" rounded={12}>${side}<Frame w="fill" h="fill" flex="col">${main}</Frame>${panel}${overlay}</Frame>`;
}

/** 대화 영역. blocks는 위에서부터 쌓을 JSX 목록이고, 맨 아래에 입력창과 상태 표시줄을 둔다. */
export function thread(c, blocks, { composerOptions = {}, status = [] } = {}) {
  return `<Frame name="Thread" w="fill" h="fill" flex="col" items="center" pt={20}>
<Frame w={720} h="hug" flex="col" gap={16}>${blocks.join('')}</Frame>
<Frame w="fill" h="fill" />
${composer(c, composerOptions)}
${status.length ? statusLine(c, status) : ''}
<Frame w="fill" h={status.length ? 12 : 20} />
</Frame>`;
}
