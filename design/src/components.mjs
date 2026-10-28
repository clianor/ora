// 방향 D 컴포넌트 보드. 색과 반경은 토큰 변수(designVar)에 연결한다.
// OpenPencil 0.16: JSX 문자열 전체가 식 하나다. ComponentSet 자식 Component의 이름이 변형(variant)을 정한다.
const F = 'Pretendard';
const M = 'JetBrains Mono';
const v = (k) => `{designVar('color/${k}')}`;
const r = (k) => `{designVar('radius/${k}')}`;

const T = (size, lh, weight, color, body, extra = '', font = F) =>
  `<Text size={${size}} lineHeight={${lh}} weight={${weight}} font="${font}" color=${v(color)} ${extra}>${body}</Text>`;
// OpenPencil 0.16의 Icon은 변수 색을 연결하지 못해 다크 토큰 값을 직접 넣는다.
const ICON_HEX = {
  background: '#1F1F1F',
  sidebar: '#181818',
  surface: '#2A2A2A',
  'surface-sunken': '#161616',
  'surface-hover': '#262626',
  border: '#2C2C2C',
  foreground: '#ECECEC',
  'foreground-muted': '#B4B4B4',
  'foreground-subtle': '#939393',
  primary: '#ECECEC',
  'primary-foreground': '#1F1F1F',
  success: '#3FB950',
  'success-subtle': '#12261A',
  danger: '#FF7B72',
  'danger-subtle': '#2D1517',
  warning: '#D29922',
  ring: '#8AB4F8',
};
const I = (name, color, size = 14) =>
  `<Icon name="lucide:${name}" size={${size}} color="${ICON_HEX[color]}" />`;
const SP = '<Frame name="Spacer" w="fill" h={1} />';
const FOCUS = `stroke=${v('ring')} strokeWidth={2} strokeAlign="outside"`;

function buttons() {
  const kinds = {
    Primary: { bg: 'primary', fg: 'primary-foreground', label: '실행' },
    Secondary: { bg: 'surface-hover', fg: 'foreground', label: '이 세션 동안 허용' },
    Ghost: { bg: null, fg: 'foreground-muted', label: '거부' },
  };
  const states = ['Default', 'Hover', 'Focus', 'Disabled'];
  const one = (kind, state) => {
    const k = kinds[kind];
    const hoverBg = { Primary: 'foreground-muted', Secondary: 'surface', Ghost: 'surface-hover' };
    const bg = state === 'Hover' ? hoverBg[kind] : k.bg;
    return `<Component name="Kind=${kind}, State=${state}" w="hug" h={30} flex="row" items="center" gap={6} px={12} rounded=${r('sm')} ${bg ? `bg=${v(bg)}` : ''} ${state === 'Focus' ? FOCUS : ''} opacity={${state === 'Disabled' ? 0.4 : 1}}>${T(13, 18, kind === 'Primary' ? 600 : 500, k.fg, k.label, ``)}</Component>`;
  };
  return `<ComponentSet name="Button" flex="row" wrap gap={12} rowGap={12} w={720}>${Object.keys(
    kinds,
  )
    .flatMap((k) => states.map((s) => one(k, s)))
    .join('')}</ComponentSet>`;
}

const STATUS = {
  pending: ['대기', 'circle', 'foreground-subtle'],
  attempted: ['시도함', 'circle-dashed', 'warning'],
  claimed_verified: ['모델 확인', 'circle-dot', 'foreground-muted'],
  verified: ['검증됨', 'circle-check', 'success'],
  failed: ['실패', 'circle-x', 'danger'],
  interrupted: ['중단됨', 'circle-pause', 'foreground-subtle'],
};
function status() {
  return `<ComponentSet name="TodoStatus" flex="row" gap={16} w="hug">${Object.entries(STATUS)
    .map(
      ([k, [l, i, c]]) =>
        `<Component name="Status=${k}" w="hug" h={20} flex="row" items="center" gap={6}>${I(i, c, 14)}${T(12, 16, 500, c, l)}</Component>`,
    )
    .join('')}</ComponentSet>`;
}

function toolCalls() {
  const head = (open, verb, target, extra = '') =>
    `<Frame w="fill" h={28} flex="row" items="center" gap={8}>${I(open ? 'chevron-down' : 'chevron-right', 'foreground-subtle', 12)}${I('terminal', 'foreground-subtle', 15)}${T(13, 18, 500, 'foreground-muted', verb)}${T(13, 18, 400, 'foreground-muted', target, '', M)}${extra}${SP}${T(12, 16, 400, 'foreground-subtle', '1.2s', '', M)}${I('circle-check', 'success', 14)}</Frame>`;
  const collapsed = `<Component name="State=Collapsed" w={720} h="hug" flex="col">${head(false, '실행', 'pnpm test -- readme')}</Component>`;
  const expanded = `<Component name="State=Expanded" w={720} h="hug" flex="col" gap={4}>${head(true, '실행', 'pnpm test -- readme')}
<Frame w="fill" h="hug" pl={20}><Frame w="fill" h="hug" flex="col" gap={8} px={16} py={12} rounded=${r('md')} bg=${v('surface-sunken')}>
<Frame w="fill" h="hug" flex="col" gap={2}>${T(12, 16, 500, 'foreground-subtle', '입력')}${T(12, 18, 400, 'foreground', '{\'{ "command": "pnpm test -- readme", "cwd": "~/projects/math-demo" }\'}', 'w="fill" textAutoResize="height"', M)}</Frame>
<Frame w="fill" h="hug" flex="col" gap={2}>${T(12, 16, 500, 'foreground-subtle', '출력 (마지막 3줄)')}${T(12, 18, 400, 'foreground-muted', '✓ readme.test.ts (12 tests) 340ms', '', M)}${T(12, 18, 400, 'foreground-muted', 'Test Files  1 passed (1)', '', M)}${T(12, 18, 400, 'success', 'exit 0', '', M)}</Frame>
<Frame w="hug" h={24} flex="row" items="center" gap={6} px={8} rounded=${r('sm')} bg=${v('surface-hover')}>${I('file-text', 'foreground-muted', 12)}${T(12, 16, 500, 'foreground-muted', '전체 출력 열기')}</Frame>
</Frame></Frame></Component>`;
  return `<ComponentSet name="ToolCall" flex="col" gap={16} w="hug">${collapsed}${expanded}</ComponentSet>`;
}

function sessionRows() {
  const row = (
    state,
    dot,
    label,
    meta,
  ) => `<Component name="State=${state}" w={248} h="hug" flex="col" gap={2} pl={32} pr={10} py={6} rounded=${r('sm')} ${state === 'Selected' ? `bg=${v('surface-hover')}` : `bg=${v('sidebar')}`}>
<Frame w="fill" h="hug" flex="row" items="center" gap={6}><Ellipse w={6} h={6} bg=${v(dot)} />${T(13, 18, state === 'Selected' ? 500 : 400, state === 'Selected' ? 'foreground' : 'foreground-muted', label, 'grow={1} maxLines={1} truncate')}${T(12, 16, 500, 'success', '+1', '', M)}${T(12, 16, 500, 'danger', '−1', '', M)}</Frame>
${T(12, 16, 400, 'foreground-subtle', meta, ``)}</Component>`;
  return `<ComponentSet name="SessionRow" flex="col" gap={4} w="hug" p={8} bg=${v('sidebar')}>${row('Default', 'success', 'README 설치 절차 갱신', '검증 2/2, 완료')}${row('Selected', 'warning', 'add 함수 버그 수정', '승인 대기')}</ComponentSet>`;
}

function todoRows() {
  const row = (name, s, cur, title, cmd, result, rc, origin) => {
    const [l, i, c] = STATUS[s];
    return `<Component name="${name}" w={324} h="hug" flex="row" items="start" gap={10} px={10} py={10} rounded=${r('md')} bg=${v(cur ? 'surface-hover' : 'sidebar')}>
<Frame w={16} h={20} flex="row" items="center">${I(i, c, 16)}</Frame>
<Frame w="fill" h="hug" flex="col" gap={4}>${T(13, 20, 500, 'foreground', title, 'w={270} textAutoResize="height"')}
<Frame w="fill" h="hug" flex="row" items="center" gap={6}>${T(12, 16, 500, c, l)}${origin ? T(12, 16, 400, 'foreground-subtle', '출처 ' + origin) : ''}</Frame>
${cmd ? `<Frame w="fill" h="hug" flex="row" items="center" gap={6} pt={2}>${T(12, 16, 400, 'foreground-muted', cmd, 'grow={1}', M)}${T(12, 16, 500, rc, result, '', M)}</Frame>` : T(12, 16, 400, 'foreground-subtle', '검증 명령을 아직 선언하지 않았습니다')}
</Frame></Component>`;
  };
  return `<ComponentSet name="TodoRow" flex="col" gap={4} w="hug" p={8} bg=${v('sidebar')}>
${row('Status=attempted, Current=true', 'attempted', true, 'math.js의 add를 덧셈으로 고친다', '$ node check.js', '승인 대기', 'foreground-subtle', 'model')}
${row('Status=verified, Current=false', 'verified', false, 'README 예제 출력을 갱신한다', '$ pnpm test -- readme', 'exit 0', 'success', 'repo')}
${row('Status=failed, Current=false', 'failed', false, '검색 도구 타임아웃을 고친다', '$ pnpm test -- search', 'exit 1', 'danger', 'repo')}
${row('Status=pending, Current=false', 'pending', false, '변경 요약을 남긴다', null, null, null, null)}
</ComponentSet>`;
}

function approval() {
  const btn = (kind, label) => {
    const [bg, weight, fg] = {
      Primary: [`bg=${v('primary')}`, 600, 'primary-foreground'],
      Secondary: [`bg=${v('surface-hover')}`, 500, 'foreground'],
      Ghost: ['', 500, 'foreground-muted'],
    }[kind];
    return `<Frame w="hug" h={30} flex="row" items="center" gap={6} px={12} rounded=${r('sm')} ${bg}>${T(13, 18, weight, fg, label)}</Frame>`;
  };
  const head = `<Frame w="fill" h="hug" flex="row" items="center" gap={8}>${I('shield-check', 'warning', 16)}${T(14, 20, 600, 'foreground', '이 명령을 실행할까요?')}${SP}${T(12, 16, 500, 'warning', '위험도 보통')}</Frame>`;
  const note = T(
    12,
    16,
    400,
    'foreground-subtle',
    't1의 검증 명령입니다. 엔진이 실행하고, 종료 코드와 출력을 증거로 남깁니다.',
    'w="fill" textAutoResize="height"',
  );
  const def = `<Component name="State=Default" w={720} h="hug" flex="col" gap={12} p={16} rounded=${r('lg')} bg=${v('surface')}>${head}
<Frame w="fill" h="hug" flex="row" items="start" gap={8} px={12} py={10} rounded=${r('md')} bg=${v('background')}><Frame w="fill" h="hug" flex="col" gap={2}>${T(13, 20, 400, 'foreground', '$ node check.js', '', M)}${T(12, 16, 400, 'foreground-subtle', 'cwd ~/projects/math-demo', '', M)}</Frame>${I('pencil', 'foreground-subtle', 14)}</Frame>
${note}<Frame w="fill" h="hug" flex="row" items="center" gap={8}>${SP}${btn('Ghost', '거부')}${btn('Secondary', '이 세션 동안 허용')}${btn('Primary', '실행')}</Frame></Component>`;
  const edit = `<Component name="State=Editing" w={720} h="hug" flex="col" gap={12} p={16} rounded=${r('lg')} bg=${v('surface')}>${head}
<Frame w="fill" h="hug" flex="col" gap={2} px={12} py={10} rounded=${r('md')} bg=${v('background')} ${FOCUS}>${T(13, 20, 400, 'foreground', '$ node check.js --verbose', '', M)}${T(12, 16, 400, 'foreground-subtle', '원본: node check.js', '', M)}</Frame>
${T(12, 16, 400, 'foreground-subtle', '고친 명령으로 실행합니다. 원본과 고친 명령을 함께 기록에 남깁니다.', 'w="fill" textAutoResize="height"')}<Frame w="fill" h="hug" flex="row" items="center" gap={8}>${SP}${btn('Ghost', '취소')}${btn('Primary', '고친 명령으로 실행')}</Frame></Component>`;
  return `<ComponentSet name="ApprovalCard" flex="col" gap={16} w="hug">${def}${edit}</ComponentSet>`;
}

function composer() {
  const base = (
    state,
  ) => `<Component name="State=${state}" w={720} h="hug" flex="col" gap={10} pt={12} pb={10} px={14} rounded=${r('xl')} bg=${v('surface')}>
${T(15, 22, 400, 'foreground-subtle', state === 'Running' ? '조향 메시지를 입력합니다. 현재 스텝이 끝난 뒤 반영합니다' : 'Ora에게 메시지, @파일, /명령', 'w="fill"')}
<Frame w="fill" h={28} flex="row" items="center" gap={6}>${I('paperclip', 'foreground-subtle', 16)}${[
    'cpu:기본 모델',
    ':medium',
    'shield:승인 생략',
  ]
    .map((x) => {
      const [ic, l] = x.split(':');
      return `<Frame w="hug" h={26} flex="row" items="center" gap={4} px={8} rounded=${r('sm')}>${ic ? I(ic, 'foreground-muted', 14) : ''}${T(12, 16, 500, 'foreground-muted', l)}${ic === 'shield' ? '' : I('chevron-down', 'foreground-subtle', 12)}</Frame>`;
    })
    .join(
      '',
    )}${SP}<Frame w={30} h={30} flex="row" items="center" justify="center" rounded={15} bg=${v('primary')}>${I(state === 'Running' ? 'square' : 'arrow-up', 'primary-foreground', state === 'Running' ? 12 : 16)}</Frame></Frame></Component>`;
  return `<ComponentSet name="Composer" flex="col" gap={16} w="hug">${base('Idle')}${base('Running')}</ComponentSet>`;
}

function stage() {
  const stages = [
    'Understand',
    'Research',
    'Decide',
    'Plan',
    'Execute',
    'Verify',
    'Operate',
    'Learn',
  ];
  const dot = (i) => {
    if (i < 4) return 'success';
    return i === 4 ? 'foreground' : 'foreground-subtle';
  };
  return `<Component name="StageIndicator" w="hug" h={28} flex="row" items="center" gap={8} px={10} rounded=${r('sm')} bg=${v('surface')}><Frame w="hug" h="hug" flex="row" gap={3}>${stages.map((_, i) => `<Ellipse w={6} h={6} bg=${v(dot(i))} />`).join('')}</Frame>${T(12, 16, 500, 'foreground', 'Execute', '')}${T(12, 16, 400, 'foreground-subtle', '5/8', '')}</Component>`;
}

function section(title, note, body) {
  return `<Frame name="${title}" w="fill" h="hug" flex="col" gap={12}>${T(13, 18, 600, 'foreground', title)}${note ? T(12, 16, 400, 'foreground-subtle', note, 'w="fill" textAutoResize="height"') : ''}${body}</Frame>`;
}

export function componentBoard() {
  return `<Frame name="01 Components" w={1600} h="hug" flex="col" gap={40} p={48} rounded={12} bg=${v('background')}>
${T(20, 28, 600, 'foreground', 'Ora 컴포넌트')}
<Frame w="fill" h="hug" flex="row" gap={48}>
<Frame w={760} h="hug" flex="col" gap={40}>
${section('Button', '종류 3가지와 상태 4가지입니다. Focus는 키보드로 이동했을 때 2px 바깥 링을 그립니다. Disabled는 불투명도 40%입니다.', buttons())}
${section('ToolCall', '도구 호출은 한 줄로 접혀 있습니다. 펼치면 입력과 출력 마지막 3줄을 보여 주고, 전체 출력은 별도로 엽니다.', toolCalls())}
${section('ApprovalCard', '명령 상자를 누르면 편집 상태가 됩니다. 고친 명령은 원본과 함께 기록에 남습니다 (SPEC 5.1절).', approval())}
${section('Composer', '대기 중에는 전송 버튼, 실행 중에는 중지 버튼을 둡니다. 실행 중 입력은 조향 메시지입니다.', composer())}
</Frame>
<Frame w="fill" h="hug" flex="col" gap={40}>
${section('TodoStatus', '상태는 아이콘, 글자, 색을 함께 씁니다 (SPEC 8.4절).', status())}
${section('StageIndicator', null, stage())}
${section('SessionRow', null, sessionRows())}
${section('TodoRow', '현재 작업 중인 todo만 배경으로 강조합니다.', todoRows())}
</Frame>
</Frame>
</Frame>`;
}
