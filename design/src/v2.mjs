// 새 시각 언어(2026-10-29 사용자 요청)의 부품. 가운데 대화 영역은 Antigravity, 좌우 사이드바와 탭 줄은 Paseo를 참고했다.
// palette('Slate')와 함께 쓴다. 기존 kit.mjs 부품은 시안 승인 뒤 이 부품으로 옮긴다.
import { I, SP, T, mono } from './kit.mjs';

const line = (c) => `<Frame w="fill" h={1} bg="${c.line}" />`;
const vline = (c) => `<Frame w={1} h="fill" bg="${c.line}" />`;
const kbd = (c, keys) =>
  `<Frame w="hug" h={22} flex="row" items="center" px={6} rounded={5} bg="${c.kbd}">${T(c, 12, 16, 500, 'ink2', keys)}</Frame>`;
/** 글 안의 인라인 코드. Antigravity처럼 고정폭 글꼴과 따뜻한 노란색으로 구분한다. */
export const icode = (c, s) => `<Span font="${mono}" size={13} color="${c.codeInk}">${s}</Span>`;

/**
 * 왼쪽 사이드바(Paseo). 위쪽 이동 항목, "워크트리" 묶음, 아래쪽 사용량 막대와 기기 줄을 차례로 둔다.
 * groups는 [{ repo, worktrees: [{ name, meta, running, selected }] }]이다. 행 전체가 버튼이다.
 */
export function sidebarV2(c, { groups, usage = null }) {
  const lights = ['#FF5F57', '#FEBC2E', '#28C840']
    .map((x) => `<Ellipse w={12} h={12} bg="${x}" />`)
    .join('');
  const nav = (icon, label) =>
    `<Frame w="fill" h={34} flex="row" items="center" gap={10} px={12} rounded={8}>${I(c, icon, 'ink2', 16)}${T(c, 14, 20, 400, 'ink2', label)}</Frame>`;
  const wt = ({ name, meta = '', running = 0, selected = false }) => {
    const lead = running
      ? `<Frame w={14} h={14} flex="row" items="center" justify="center">${I(c, 'loader', 'ink2', 13)}</Frame>`
      : `<Frame w={14} h={14} flex="row" items="center" justify="center"><Ellipse w={6} h={6} bg="${c.ink3}" /></Frame>`;
    const right = running
      ? T(c, 13, 18, 500, 'ink2', `실행 ${running}`)
      : T(c, 13, 18, 400, 'ink3', meta);
    return `<Frame w="fill" h={36} flex="row" items="center" gap={10} pl={26} pr={12} rounded={8} ${selected ? `bg="${c.hover}"` : ''}>${lead}${T(c, 14, 20, selected ? 500 : 400, selected ? 'ink' : 'ink2', name, 'grow={1} maxLines={1} truncate')}${right}</Frame>`;
  };
  const group = ({ repo, worktrees }) =>
    `<Frame w="fill" h="hug" flex="col" gap={2}><Frame w="fill" h={36} flex="row" items="center" gap={10} px={12}>${I(c, 'folder-git-2', 'ink2', 16)}${T(c, 14, 20, 500, 'ink', repo)}</Frame>${worktrees.map(wt).join('')}</Frame>`;
  const usageRow = usage
    ? `<Frame w="fill" h="hug" flex="row" items="center" gap={10} px={12} py={12}>${I(c, 'gauge', 'ink3', 15)}${usage
        .map(
          ([label, pct]) =>
            `<Frame w="fill" h="hug" flex="row" items="center" gap={8}><Frame w="fill" h={4} flex="row" rounded={2} bg="${c.hover}"><Frame w={${Math.max(2, Math.round(pct * 0.8))}} h={4} rounded={2} bg="${c.ink2}" /></Frame>${T(c, 12, 16, 500, 'ink2', `${label} ${pct}%`)}</Frame>`,
        )
        .join('')}</Frame>`
    : '';
  return `<Frame name="SidebarV2" w={280} h="fill" flex="row" bg="${c.sidebar}"><Frame w="fill" h="fill" flex="col">
<Frame w="fill" h={44} flex="row" items="center" gap={8} px={16}>${lights}${SP}${I(c, 'panel-left', 'ink2', 16)}</Frame>
<Frame w="fill" h="hug" flex="col" gap={2} px={8} pb={10}>${nav('plus', '새 워크트리')}${nav('history', '기록')}${nav('search', '검색')}</Frame>
${line(c)}
<Frame w="fill" h="hug" flex="col" gap={4} px={8} pt={10}>
<Frame w="fill" h={30} flex="row" items="center" px={12}>${T(c, 13, 18, 500, 'ink2', '워크트리', 'grow={1}')}${I(c, 'sliders-horizontal', 'ink3', 14)}</Frame>
${groups.map(group).join('')}
</Frame>
<Frame w="fill" h="fill" />
${usage ? line(c) + usageRow : ''}
${line(c)}
<Frame w="fill" h={44} flex="row" items="center" gap={14} px={16}><Ellipse w={8} h={8} bg="${c.ok}" />${T(c, 13, 18, 400, 'ink2', 'MacBook-Pro', 'grow={1}')}${I(c, 'circle-help', 'ink3', 16)}${I(c, 'settings', 'ink3', 16)}</Frame>
</Frame>${vline(c)}</Frame>`;
}

// 탭 상태 아이콘. 모양이 서로 달라서 사용자는 색 없이도 상태를 구분한다.
const TAB_ICON = {
  running: ['loader', 'ink2'],
  approval: ['shield-alert', 'warn'],
  done: ['circle-check', 'ok'],
  failed: ['circle-x', 'del'],
  terminal: ['square-terminal', 'ink2'],
  new: ['plus', 'ink2'],
};

/** 가운데 위쪽 머리 줄과 탭 줄(Paseo). 머리 줄에는 worktree·저장소 이름, 오른쪽에 diff 칩과 패널 단추를 둔다. */
export function tabsHeaderV2(c, { worktree, repo, diff = null, tabs, active, warning = null }) {
  const chip = (inner) =>
    `<Frame w="hug" h={30} flex="row" items="center" gap={6} px={10} rounded={8} stroke="${c.line}" strokeWidth={1} strokeAlign="inside">${inner}</Frame>`;
  const tab = ({ title, state }, i) => {
    const [icon, col] = TAB_ICON[state];
    const on = i === active;
    return `<Frame name="Tab" w="hug" h={30} flex="row" items="center" gap={8} px={10} rounded={8} ${on ? `bg="${c.hover}"` : ''}>${I(c, icon, col, 14)}${T(c, 14, 20, on ? 500 : 400, on ? 'ink' : 'ink2', title, 'maxW={180} maxLines={1} truncate')}${on ? I(c, 'x', 'ink3', 13) : ''}</Frame>`;
  };
  const warn = warning
    ? `<Frame w="hug" h={26} flex="row" items="center" gap={6} px={8} rounded={6}>${I(c, 'triangle-alert', 'warn', 13)}${T(c, 13, 18, 500, 'ink2', warning)}</Frame>`
    : '';
  return `<Frame name="TabsHeaderV2" w="fill" h="hug" flex="col">
<Frame w="fill" h={44} flex="row" items="center" gap={10} px={16}>${T(c, 15, 20, 500, 'ink', worktree, '', mono)}${T(c, 15, 20, 400, 'ink2', repo)}${I(c, 'ellipsis', 'ink3', 16)}${SP}${diff ? chip(`${I(c, 'git-compare', 'ink2', 14)}${T(c, 13, 18, 500, 'add', '+' + diff[0], '', mono)}${T(c, 13, 18, 500, 'del', '−' + diff[1], '', mono)}`) : ''}${chip(`${I(c, 'code-xml', 'ink2', 14)}${T(c, 13, 18, 500, 'ink2', '편집기')}`)}</Frame>
${line(c)}
<Frame w="fill" h={42} flex="row" items="center" gap={2} px={10}>${tabs.map(tab).join('')}<Frame w={30} h={30} flex="row" items="center" justify="center" rounded={8}>${I(c, 'plus', 'ink2', 16)}</Frame>${SP}${warn}${I(c, 'ellipsis', 'ink3', 16)}</Frame>
${line(c)}
</Frame>`;
}

/** 오른쪽 패널 머리(Paseo). 아이콘과 글자가 함께 있는 알약 탭이고, 고른 탭만 바탕색이 있다. 탭 전체가 버튼이다. */
export function panelHeadV2(c, { active = 0, right = '', titleRow = false } = {}) {
  const items = [
    ['list-checks', '할 일'],
    ['file-diff', '변경'],
    ['files', '파일'],
  ];
  const pill = ([icon, label], i) =>
    `<Frame w="hug" h={30} flex="row" items="center" gap={6} px={10} rounded={8} ${i === active ? `bg="${c.hover}"` : ''}>${I(c, icon, i === active ? 'ink' : 'ink2', 14)}${T(c, 14, 20, i === active ? 500 : 400, i === active ? 'ink' : 'ink2', label)}</Frame>`;
  return `<Frame w="fill" h="hug" flex="col"><Frame w="fill" h={${titleRow ? 40 : 44}} flex="row" items="center" gap={2} px={8} ${titleRow ? `bg="${c.sunken}"` : ''}>${items.map(pill).join('')}${SP}${right}${I(c, 'panel-right', 'ink2', 16)}</Frame>${line(c)}</Frame>`;
}

/** 사용자 메시지(Antigravity). 대화 폭을 꽉 채운 상자에 담는다. */
export const userBoxV2 = (c, text) =>
  `<Frame w="fill" h="hug" px={14} py={11} rounded={10} bg="${c.raised}" stroke="${c.line}" strokeWidth={1} strokeAlign="inside">${T(c, 14, 22, 400, 'ink', text, 'w="fill" textAutoResize="height"')}</Frame>`;

/** 모델이 쓴 글. html에는 icode() 조각을 섞을 수 있다. */
export const paraV2 = (c, html) =>
  `<Text size={14} lineHeight={23} weight={400} font="Pretendard" color="${c.ink}" w="fill" textAutoResize="height">${html}</Text>`;
/** 도구 호출 한 줄. 동사와 대상만 보이고, 누르면 펼친다. */
export const toolRowV2 = (c, { icon, verb, target, result = '', resultColor = 'ink3' }) =>
  `<Frame w="fill" h={26} flex="row" items="center" gap={8}>${I(c, icon, 'ink3', 14)}${T(c, 13, 18, 500, 'ink2', verb)}${T(c, 13, 18, 400, 'ink2', target, 'grow={1}', mono)}${result ? T(c, 12, 16, 500, resultColor, result, '', mono) : ''}${I(c, 'chevron-right', 'ink3', 13)}</Frame>`;

/** 코드·diff 카드(Antigravity의 코드 블록). 머리에 파일 이름과 동작 단추를 두고, 본문은 고정폭으로 보인다. */
export function codeCardV2(c, { title, meta = '', rows }) {
  const bg = { '+': 'addBg', '-': 'delBg', ' ': 'raised' };
  const signInk = { '+': 'add', '-': 'del', ' ': 'ink3' };
  const row = ([n, sign, text]) =>
    `<Frame w="fill" h={24} flex="row" items="center" gap={12} px={14} bg="${c[bg[sign]]}">${T(c, 13, 18, 400, 'ink3', n, '', mono)}${T(c, 13, 18, 400, signInk[sign], sign, '', mono)}${T(c, 13, 18, 400, 'ink', text, '', mono)}</Frame>`;
  return `<Frame name="CodeCard" w="fill" h="hug" flex="col" rounded={10} bg="${c.raised}" stroke="${c.line}" strokeWidth={1} strokeAlign="inside" overflow="hidden">
<Frame w="fill" h={36} flex="row" items="center" gap={8} px={14}>${T(c, 13, 18, 500, 'ink2', title, '', mono)}${meta}${SP}${I(c, 'copy', 'ink3', 14)}</Frame>
${line(c)}
<Frame w="fill" h="hug" flex="col" py={6}>${rows.map(row).join('')}</Frame>
</Frame>`;
}

/** 승인 카드. 코드 카드와 같은 테두리 상자에 명령과 선택지를 담는다. */
export function approvalV2(c) {
  const btn = (label, kind) => {
    const style = {
      primary: `bg="${c.primary}"`,
      secondary: `stroke="${c.line}" strokeWidth={1} strokeAlign="inside"`,
      ghost: '',
    }[kind];
    const col = kind === 'primary' ? 'onPrimary' : 'ink2';
    return `<Frame w="hug" h={30} flex="row" items="center" gap={6} px={12} rounded={8} ${style}>${T(c, 13, 18, 500, col, label)}${kind === 'primary' ? T(c, 12, 16, 500, col, '↵', 'opacity={0.7}', mono) : ''}</Frame>`;
  };
  return `<Frame name="ApprovalV2" w="fill" h="hug" flex="col" rounded={10} bg="${c.raised}" stroke="${c.line}" strokeWidth={1} strokeAlign="inside">
<Frame w="fill" h={40} flex="row" items="center" gap={8} px={14}>${I(c, 'shield-check', 'warn', 15)}${T(c, 14, 20, 600, 'ink', '이 명령을 실행할까요?')}${SP}${T(c, 12, 16, 500, 'warn', '위험도 보통')}</Frame>
${line(c)}
<Frame w="fill" h="hug" flex="col" gap={10} p={14}>
<Frame w="fill" h="hug" flex="row" items="center" gap={8} px={12} py={10} rounded={8} bg="${c.sunken}"><Frame w="fill" h="hug" flex="col" gap={2}>${T(c, 13, 20, 400, 'ink', '$ node check.js', '', mono)}${T(c, 12, 16, 400, 'ink3', 'cwd ~/projects/math-demo', '', mono)}</Frame>${I(c, 'pencil', 'ink3', 14)}</Frame>
${T(c, 13, 20, 400, 'ink2', 't1의 검증 명령입니다. 엔진이 실행하고, 종료 코드와 출력을 증거로 남깁니다.', 'w="fill" textAutoResize="height"')}
<Frame w="fill" h="hug" flex="row" items="center" gap={8}>${SP}${btn('거부', 'ghost')}${btn('이 세션 동안 허용', 'secondary')}${btn('실행', 'primary')}</Frame>
</Frame>
</Frame>`;
}

/**
 * 입력창(Antigravity). 테두리 상자 안에 안내 글, 아래 줄에 첨부·모델 칩, 오른쪽에 권한 칩과 보내기 단추를 둔다.
 * running이면 보내기 대신 중지 단추를 보인다.
 */
export function composerV2(
  c,
  {
    width = 720,
    running = false,
    model = 'claude-haiku-5-5',
    effort = 'medium',
    permission = '승인 생략',
    placeholder = null,
  } = {},
) {
  const hint =
    placeholder ??
    (running
      ? '조향 메시지를 입력합니다. 현재 스텝이 끝난 뒤 반영합니다'
      : 'Ora에게 메시지, @파일, /명령');
  const chip = (inner) =>
    `<Frame w="hug" h={28} flex="row" items="center" gap={5} px={8} rounded={7}>${inner}</Frame>`;
  const action = running
    ? `<Frame w={30} h={30} flex="row" items="center" justify="center" rounded={15} bg="${c.primary}">${I(c, 'square', 'onPrimary', 11)}</Frame>`
    : `<Frame w={30} h={30} flex="row" items="center" justify="center" rounded={15} bg="${c.hover}">${I(c, 'arrow-up', 'ink', 16)}</Frame>`;
  return `<Frame name="ComposerV2" w={${width}} h="hug" flex="col" gap={10} pt={14} pb={10} px={12} rounded={12} bg="${c.raised}" stroke="${c.line}" strokeWidth={1} strokeAlign="inside">
${T(c, 14, 22, 400, 'ink3', hint, 'w="fill" pl={4}')}
<Frame w="fill" h={30} flex="row" items="center" gap={4}>${chip(I(c, 'plus', 'ink2', 16))}${chip(`${T(c, 13, 18, 500, 'ink', model, '', mono)}${T(c, 13, 18, 400, 'ink3', effort)}${I(c, 'chevron-up', 'ink3', 12)}`)}${SP}${chip(`${I(c, 'shield', 'ink2', 13)}${T(c, 13, 18, 500, 'ink2', permission)}${I(c, 'chevron-up', 'ink3', 12)}`)}${action}</Frame>
</Frame>`;
}

/** 입력창 아래 상태 줄. items는 [글자, 색 이름] 쌍이다. */
function statusV2(c, items, width = 720) {
  const sep = T(c, 12, 16, 400, 'ink3', '·');
  return `<Frame w={${width}} h={20} flex="row" items="center" gap={8} px={12}>${items.map(([t, col = 'ink3']) => T(c, 12, 16, 400, col, t)).join(sep)}</Frame>`;
}

/** 가운데 대화 영역(Antigravity). 폭 720 기둥을 가운데에 두고, 맨 아래에 입력창과 상태 줄을 둔다. */
export function threadV2(c, blocks, { composer, status = [], notice = null }) {
  return `<Frame name="ThreadV2" w="fill" h="fill" flex="col" items="center" pt={24}>
<Frame w={720} h="hug" flex="col" gap={14}>${blocks.join('')}</Frame>
<Frame w="fill" h="fill" />
${notice ? `<Frame w={720} h="hug" flex="row" items="center" gap={8} px={12} pb={8}>${I(c, 'triangle-alert', 'warn', 14)}${T(c, 13, 18, 500, 'ink2', notice)}</Frame>` : ''}
${composer}
${status.length ? statusV2(c, status) : ''}
<Frame w="fill" h={14} />
</Frame>`;
}

/** 새 탭에서 고르는 항목(Paseo). 줄 전체가 버튼이고, 오른쪽에 단축키를 둔다. */
export function chooserV2(c, { title, items, note }) {
  const row = ([icon, label, keys, soon]) =>
    `<Frame w="fill" h={48} flex="row" items="center" gap={12} px={16} rounded={9} bg="${c.raised}">${I(c, icon, soon ? 'ink3' : 'ink2', 17)}${T(c, 15, 20, 500, soon ? 'ink3' : 'ink', label, 'grow={1}')}${soon ? T(c, 13, 18, 500, 'ink3', '곧 지원') : kbd(c, keys)}</Frame>`;
  return `<Frame name="ChooserV2" w="fill" h="fill" flex="col" items="center" justify="center" pb={60}>
<Frame w={460} h="hug" flex="col" gap={8}>${T(c, 13, 18, 500, 'ink3', title, 'pb={4} pl={2}')}${items.map(row).join('')}${note ? T(c, 13, 18, 400, 'ink3', note, 'pt={8} pl={2}') : ''}</Frame>
</Frame>`;
}

// ── v3: Orca 구조를 더한 부품(2026-10-29 사용자 요청). 색은 슬레이트를 유지한다. ──

const SESSION_ICON = {
  running: ['loader', 'ink2'],
  approval: ['shield-alert', 'warn'],
  question: ['message-circle-question', 'warn'],
  failed: ['circle-x', 'del'],
};

/**
 * 왼쪽 사이드바(Orca 구조). 맨 위 검색칸, 기록 항목, 워크트리 묶음 순서다.
 * 고른 worktree는 테두리 카드로 묶고, 그 안에 실행 중이거나 답을 기다리는 세션을 보인다. 끝난 세션은 기록 화면에서 찾는다.
 * groups는 [{ repo, worktrees: [{ name, base, selected, sessions: [{ state, title, model, age }] }] }]이다.
 */
export function sidebarV3(c, { groups }) {
  const lights = ['#FF5F57', '#FEBC2E', '#28C840']
    .map((x) => `<Ellipse w={12} h={12} bg="${x}" />`)
    .join('');
  const badge = (t) =>
    `<Frame w="hug" h={18} flex="row" items="center" px={6} rounded={5} bg="${c.hover}">${T(c, 11, 14, 500, 'ink2', t)}</Frame>`;
  const sessionRow = ({ state, title, age }) => {
    const [icon, col] = SESSION_ICON[state];
    return `<Frame w="fill" h={30} flex="row" items="center" gap={8} pl={28} pr={10}>${I(c, icon, col, 13)}${T(c, 13, 18, 400, 'ink', title, 'grow={1} maxLines={1} truncate')}${T(c, 12, 16, 400, 'ink3', age)}</Frame>`;
  };
  const wtRow = ({ name, base = false, selected = false, running = 0, status = null }) =>
    `<Frame w="fill" h={34} flex="row" items="center" gap={8} px={10}>${I(c, 'git-branch', selected ? 'ink' : 'ink3', 14)}${T(c, 14, 20, selected ? 500 : 400, selected ? 'ink' : 'ink2', name, 'maxLines={1} truncate')}${base ? badge('기본') : ''}${SP}${status ? `<Frame w="hug" h="hug" flex="row" items="center" gap={5}>${I(c, status[0], status[2], 13)}${T(c, 12, 16, 500, status[2], status[1])}</Frame>` : ''}${!status && !selected && running ? T(c, 12, 16, 500, 'ink2', `실행 ${running}`) : ''}</Frame>`;
  const wt = (w) =>
    w.selected
      ? `<Frame w="fill" h="hug" flex="col" pb={4} rounded={10} bg="${c.raised}" stroke="${c.borderStrong}" strokeWidth={1} strokeAlign="inside">${wtRow(w)}${(w.sessions ?? []).map(sessionRow).join('')}</Frame>`
      : wtRow(w);
  const group = ({ repo, worktrees }) =>
    `<Frame w="fill" h="hug" flex="col" gap={2}><Frame w="fill" h={34} flex="row" items="center" gap={10} px={10}>${I(c, 'folder-git-2', 'ink2', 15)}${T(c, 14, 20, 600, 'ink', repo, 'grow={1}')}${I(c, 'plus', 'ink3', 15)}</Frame>${worktrees.map(wt).join('')}</Frame>`;
  return `<Frame name="SidebarV3" w={300} h="fill" flex="row" bg="${c.sidebar}"><Frame w="fill" h="fill" flex="col">
<Frame w="fill" h={40} flex="row" items="center" gap={8} px={16}>${lights}<Frame w={10} h={1} />${I(c, 'panel-left', 'ink2', 16)}${SP}${I(c, 'arrow-left', 'ink3', 15)}${I(c, 'arrow-right', 'ink3', 15)}</Frame>
<Frame w="fill" h="hug" flex="col" gap={4} px={10} pt={4}>
<Frame w="fill" h={34} flex="row" items="center" gap={8} px={10} rounded={8} bg="${c.raised}">${I(c, 'search', 'ink3', 15)}${T(c, 14, 20, 400, 'ink3', '세션, 워크트리 검색', 'grow={1}')}${kbd(c, '⌘K')}</Frame>
<Frame w="fill" h={34} flex="row" items="center" gap={10} px={10} rounded={8}>${I(c, 'history', 'ink2', 16)}${T(c, 14, 20, 400, 'ink2', '기록', 'grow={1}')}${T(c, 12, 16, 400, 'ink3', '⌘Y')}</Frame>
</Frame>
<Frame w="fill" h="hug" flex="col" gap={4} px={10} pt={14}>
<Frame w="fill" h={30} flex="row" items="center" gap={12} px={10}>${T(c, 13, 18, 500, 'ink3', '워크트리', 'grow={1}')}${I(c, 'sliders-horizontal', 'ink3', 14)}${I(c, 'plus', 'ink3', 15)}</Frame>
${groups.map(group).join('')}
</Frame>
<Frame w="fill" h="fill" />
<Frame w="fill" h={40} flex="row" items="center" gap={14} px={16}>${I(c, 'settings', 'ink3', 16)}${I(c, 'circle-help', 'ink3', 16)}</Frame>
</Frame>${vline(c)}</Frame>`;
}

/**
 * 제목 줄 탭(Orca). 창 맨 위 줄에 탭을 두어 머리 줄을 따로 두지 않는다. 고른 탭은 본문과 같은 바탕이라 본문으로 이어진다.
 * right는 오른쪽 끝에 붙일 단추 묶음이다.
 */
export function titleTabsV3(c, { tabs, active, right = '' }) {
  const tab = ({ title, state }, i) => {
    const [icon, col] = TAB_ICON[state];
    const on = i === active;
    return `<Frame name="Tab" w="hug" maxW={200} h="fill" flex="row" items="center" gap={8} px={12} ${on ? `bg="${c.window}"` : ''}>${I(c, icon, col, 14)}${T(c, 13, 18, on ? 500 : 400, on ? 'ink' : 'ink2', title, 'maxW={130} maxLines={1} truncate')}${on ? I(c, 'x', 'ink3', 13) : ''}</Frame>${vline(c)}`;
  };
  return `<Frame name="TitleTabsV3" w="fill" h="hug" flex="col"><Frame w="fill" h={40} flex="row" items="center" bg="${c.sunken}">${tabs.map(tab).join('')}<Frame w={36} h="fill" flex="row" items="center" justify="center">${I(c, 'plus', 'ink2', 16)}</Frame>${SP}<Frame w="hug" h="fill" flex="row" items="center" gap={6} px={10}>${right}</Frame></Frame>${line(c)}</Frame>`;
}

/** 제목 줄 오른쪽의 작은 단추. */
export const titleButtonV3 = (c, icon, label = '', color = 'ink2') =>
  `<Frame w="hug" h={28} flex="row" items="center" gap={6} px={8} rounded={7}>${I(c, icon, color, 15)}${label}</Frame>`;

/**
 * 창 전체 폭의 하단 상태 줄(Orca). 왼쪽에 계정 사용량, 오른쪽에 앱 상태를 둔다.
 * usage는 [[계정, [[구간, 퍼센트]...]]...], right는 [[아이콘, 글자]...]이다.
 */
export function statusBarV3(c, { usage, right }) {
  const bar = (pct) =>
    `<Frame w={48} h={4} flex="row" rounded={2} bg="${c.hover}"><Frame w={${Math.max(2, Math.round(pct * 0.48))}} h={4} rounded={2} bg="${c.ink2}" /></Frame>`;
  const acct = ([name, spans]) =>
    `<Frame w="hug" h="fill" flex="row" items="center" gap={8}>${T(c, 12, 16, 500, 'ink2', name)}${spans.map(([label, pct]) => `${bar(pct)}${T(c, 12, 16, 400, 'ink2', `${label} ${pct}%`)}`).join('')}</Frame>`;
  const item = ([icon, label]) =>
    `<Frame w="hug" h="fill" flex="row" items="center" gap={6}>${I(c, icon, 'ink3', 13)}${T(c, 12, 16, 400, 'ink2', label)}</Frame>`;
  return `<Frame name="StatusBarV3" w="fill" h="hug" flex="col">${line(c)}<Frame w="fill" h={28} flex="row" items="center" gap={18} px={14} bg="${c.sunken}">${usage.map(acct).join(vline(c))}${SP}${right.map(item).join('')}</Frame></Frame>`;
}

/** 화면 오른쪽 위에 잠시 뜨는 알림. 폴백처럼 사용자가 알아야 하는 엔진 사건에 쓴다. */
export function toastV3(c, { x, y, icon, title, body }) {
  return `<Frame name="Toast" position="absolute" x={${x}} y={${y}} w={360} h="hug" flex="row" items="start" gap={10} p={12} rounded={10} bg="${c.popover}" stroke="${c.borderStrong}" strokeWidth={1} strokeAlign="inside">${I(c, icon, 'warn', 16)}<Frame w="fill" h="hug" flex="col" gap={3}>${T(c, 13, 18, 600, 'ink', title)}${T(c, 12, 18, 400, 'ink2', body, 'w="fill" textAutoResize="height"')}</Frame>${I(c, 'x', 'ink3', 13)}</Frame>`;
}

/** v3 창. 위쪽은 사이드바·가운데·오른쪽 패널을 가로로 두고, 맨 아래에 창 전체 폭 상태 줄을 둔다. */
export function windowV3(c, name, { side, main, panel = '', status, overlay = '' }) {
  return `<Frame name="${name}" w={1440} h={900} flex="col" bg="${c.window}" overflow="hidden" rounded={12}><Frame w="fill" h="fill" flex="row">${side}<Frame w="fill" h="fill" flex="col">${main}</Frame>${panel}</Frame>${status}${overlay}</Frame>`;
}

/** 제목 줄 끝의 오른쪽 패널 열기 단추. 패널이 접혀 있을 때만 보인다. 사용자가 패널을 열면 같은 단추가 패널 머리 끝으로 옮겨 간다. */
export const panelOpenButtonV3 = (c) =>
  `<Frame name="PanelOpen" w="hug" h={28} flex="row" items="center" gap={6} px={8} rounded={7} bg="${c.hover}">${I(c, 'panel-right-open', 'ink', 15)}${T(c, 12, 16, 500, 'ink2', '⌥⌘B')}</Frame>`;

/**
 * 오른쪽 패널의 "변경" 탭. 이 워크트리에서 바뀐 파일을 보인다. 세션이 없어도 쓸 수 있다.
 * files는 [[경로, 더한 줄, 지운 줄]]이다. 줄 전체가 버튼이고, 누르면 그 파일의 diff를 연다.
 */
export function changesPanelV3(c, { branch, files }) {
  const add = files.reduce((n, f) => n + f[1], 0);
  const del = files.reduce((n, f) => n + f[2], 0);
  const row = ([path, a, d]) =>
    `<Frame w="fill" h={32} flex="row" items="center" gap={8} px={10} rounded={7}>${I(c, 'file-pen', 'ink3', 14)}${T(c, 13, 18, 400, 'ink', path, 'grow={1} maxLines={1} truncate', mono)}${T(c, 12, 16, 500, 'add', '+' + a, '', mono)}${T(c, 12, 16, 500, 'del', '−' + d, '', mono)}</Frame>`;
  return `<Frame name="ChangesPanel" w={340} h="fill" flex="row"><Frame w={1} h="fill" bg="${c.line}" /><Frame w="fill" h="fill" flex="col" bg="${c.sidebar}">
${panelHeadV2(c, { active: 1, titleRow: true })}
<Frame w="fill" h={40} flex="row" items="center" gap={6} px={14}>${I(c, 'git-branch', 'ink3', 14)}${T(c, 13, 18, 500, 'ink2', branch, '', mono)}${I(c, 'chevron-down', 'ink3', 12)}</Frame>
<Frame w="fill" h={36} flex="row" items="center" gap={6} px={14}>${T(c, 13, 18, 500, 'ink2', '모든 변경 사항')}${I(c, 'chevron-down', 'ink3', 12)}${T(c, 12, 16, 500, 'add', '+' + add, '', mono)}${T(c, 12, 16, 500, 'del', '−' + del, '', mono)}${SP}${I(c, 'refresh-cw', 'ink3', 14)}</Frame>
<Frame w="fill" h="hug" flex="col" gap={2} px={6}>${files.map(row).join('')}</Frame>
<Frame w="fill" h="fill" />
${line(c)}
<Frame w="fill" h={40} flex="row" items="center" gap={8} px={14}>${I(c, 'chevron-right', 'ink3', 14)}${T(c, 13, 18, 500, 'ink2', '커밋')}</Frame>
</Frame></Frame>`;
}
