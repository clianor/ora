import {
  defaultPhaseName,
  type OraEvent,
  type SessionRecord,
  type Todo,
  type TodoStatus,
} from '@ora/protocol';
import {
  ChevronDown,
  ChevronRight,
  ChevronsUp,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CirclePause,
  CircleSlash,
  CircleX,
  Ellipsis,
  OctagonPause,
  Play,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestionMark,
  ShieldX,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { DropdownMenu, Popover } from 'radix-ui';
import { useRef, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn.ts';
import { runAction, useActions } from '../store.tsx';
import { Button } from '../ui/button.tsx';

const statusStyle: Record<TodoStatus, { label: string; icon: LucideIcon; color: string }> = {
  pending: { label: '대기', icon: Circle, color: 'text-foreground-subtle' },
  attempted: { label: '시도함', icon: CircleDashed, color: 'text-warning' },
  claimed_verified: { label: '모델 확인', icon: CircleDot, color: 'text-foreground-muted' },
  verified: { label: '검증됨', icon: CircleCheck, color: 'text-success' },
  failed: { label: '실패', icon: CircleX, color: 'text-danger' },
  interrupted: { label: '중단됨', icon: CirclePause, color: 'text-foreground-subtle' },
  blocked: { label: '막힘', icon: OctagonPause, color: 'text-warning' },
  abandoned: { label: '포기함', icon: CircleSlash, color: 'text-foreground-subtle' },
};

type FlowKind =
  | 'try'
  | 'repair'
  | 'claim'
  | 'pass'
  | 'fail'
  | 'block'
  | 'unblock'
  | 'abandon'
  | 'gate'
  | 'waiveAsk'
  | 'waive'
  | 'waiveNo';

/** 흐름 항목의 아이콘과 색입니다. 글자가 항상 함께 붙으므로 색만으로 구분하지 않습니다. */
const flowStyle: Record<FlowKind, { icon: LucideIcon; color: string }> = {
  try: { icon: Play, color: 'text-foreground-muted' },
  repair: { icon: Wrench, color: 'text-warning' },
  claim: { icon: CircleDot, color: 'text-foreground-muted' },
  pass: { icon: CircleCheck, color: 'text-success' },
  fail: { icon: CircleX, color: 'text-danger' },
  block: { icon: OctagonPause, color: 'text-warning' },
  unblock: { icon: Play, color: 'text-foreground-muted' },
  abandon: { icon: CircleSlash, color: 'text-foreground-subtle' },
  gate: { icon: ShieldAlert, color: 'text-danger' },
  waiveAsk: { icon: ShieldQuestionMark, color: 'text-warning' },
  waive: { icon: ShieldCheck, color: 'text-success' },
  waiveNo: { icon: ShieldX, color: 'text-danger' },
};

/** 흐름이 이 개수를 넘으면 앞부분을 접고 마지막 `flowFoldLimit`개만 보입니다. */
const flowFoldLimit = 12;

const panelId = 'todo-panel';

/**
 * `⌘1`과 명령 팔레트가 패널 밖에서 포커스를 옮겨야 하는데 패널의 ref를 넘길 길이 없어 id로 찾습니다.
 * 패널이 없는 화면에서는 아무 일도 하지 않습니다.
 */
export function focusTodoPanel(): void {
  document.getElementById(panelId)?.focus();
}

interface FlowItem {
  kind: FlowKind;
  label: string;
  step: string;
}

interface PanelData {
  objective: string;
  /** phase 이름 → 완료 조건 */
  criteria: Map<string, string>;
  /** 엔진이 마지막으로 기록한 작업 중 할 일 ID입니다. */
  current: string | null;
  /** phase가 처음 나온 순서입니다. */
  phaseNames: string[];
  flows: Map<string, FlowItem[]>;
  /** phase 이름 → 그 phase 할 일의 `todo_update`·`verification` 이벤트가 속한 서로 다른 스텝 수 */
  steps: Map<string, number>;
}

const getPhaseName = (todo: Todo): string => todo.phase ?? defaultPhaseName;

function getStepSuffix(stepId: string | undefined): string {
  const match = /(\d+)$/.exec(stepId ?? '');
  return match ? ` · 스텝 ${match[1]}` : '';
}

/**
 * 게이트가 찾은 항목을 종류별로 세어 짧게 적습니다.
 * 단언 없음, 건너뜀, dry-run은 접두어로 가르고, 나머지는 스텁입니다. 스텁이 한 가지 패턴뿐이면 그 패턴 이름(예: TODO)을, 여러 가지면 "스텁"을 씁니다.
 */
function summarizeGateFindings(findings: readonly string[]): string {
  const stubPatterns = new Set<string>();
  let stubs = 0;
  let skips = 0;
  let dryRuns = 0;
  let noAssertions = 0;
  for (const finding of findings) {
    if (finding.startsWith('건너뜀:')) skips += 1;
    else if (finding.startsWith('단언 없는 검사:')) noAssertions += 1;
    else if (finding.startsWith('dry-run 검증:')) dryRuns += 1;
    else {
      stubs += 1;
      stubPatterns.add(finding.replace(/^\S+\s/, ''));
    }
  }
  const stubName = stubPatterns.size === 1 ? [...stubPatterns][0] : '스텁';
  const parts = [
    stubs > 0 ? `${stubName} ${stubs}곳` : '',
    skips > 0 ? `건너뜀 ${skips}곳` : '',
    noAssertions > 0 ? `단언 없음 ${noAssertions}곳` : '',
    dryRuns > 0 ? `dry-run ${dryRuns}곳` : '',
  ].filter((part) => part !== '');
  return parts.join(' · ');
}

/** 이벤트 기록을 처음부터 읽어 패널이 그릴 값을 만듭니다. 작업 중 할 일은 화면이 추측하지 않고 기록한 값을 씁니다. */
function readPanelData(events: readonly OraEvent[], todos: readonly Todo[]): PanelData {
  let objective = '';
  let current: string | null = null;
  const criteria = new Map<string, string>();
  const phaseNames: string[] = [];
  const flows = new Map<string, FlowItem[]>();
  const stepIds = new Map<string, Set<string>>();
  const repairs = new Map<string, number>();
  const waiverCalls = new Map<string, string>();

  const addPhase = (name: string): void => {
    if (!phaseNames.includes(name)) phaseNames.push(name);
  };
  const push = (todoId: string, item: FlowItem): void => {
    flows.set(todoId, [...(flows.get(todoId) ?? []), item]);
  };
  const markStep = (todoId: string, stepId: string | undefined): void => {
    if (stepId === undefined) return;
    stepIds.set(todoId, (stepIds.get(todoId) ?? new Set<string>()).add(stepId));
  };

  for (const event of events) {
    if (event.type === 'objective') {
      objective = event.payload.text;
    } else if (event.type === 'phase') {
      addPhase(event.payload.name);
      if (event.payload.criterion === null) criteria.delete(event.payload.name);
      else criteria.set(event.payload.name, event.payload.criterion);
    } else if (event.type === 'todo_update') {
      const { todo, from, to } = event.payload;
      if (event.payload.rejected) continue;
      addPhase(getPhaseName(todo));
      if (event.payload.current !== undefined) current = event.payload.current;
      markStep(todo.id, event.stepId);
      const step = getStepSuffix(event.stepId);
      const hasTried = flows.get(todo.id)?.some((item) => item.kind === 'try') ?? false;
      if (to === 'attempted' && from === 'failed') {
        const count = (repairs.get(todo.id) ?? 0) + 1;
        repairs.set(todo.id, count);
        push(todo.id, { kind: 'repair', label: `수리 ${count}`, step });
      } else if (to === 'attempted' && from === 'blocked') {
        push(todo.id, { kind: 'unblock', label: '막힘 해제', step });
      } else if (to === 'attempted' && !hasTried) {
        push(todo.id, { kind: 'try', label: '시도', step });
      } else if (to === 'claimed_verified') {
        push(todo.id, { kind: 'claim', label: '모델 자체 검사', step });
      } else if (to === 'blocked') {
        const reason = todo.blockedReason ?? '';
        push(todo.id, { kind: 'block', label: reason === '' ? '막힘' : `막힘 · ${reason}`, step });
      } else if (to === 'abandoned') {
        push(todo.id, { kind: 'abandon', label: '포기 · 사용자', step });
      }
    } else if (event.type === 'approval_request') {
      const { callId, detail, todo } = event.payload;
      if (detail.kind !== 'verify_waiver' || todo === undefined) continue;
      waiverCalls.set(callId, todo.id);
      push(todo.id, {
        kind: 'waiveAsk',
        label: '예외 요청 · 사용자 답 기다림',
        step: getStepSuffix(event.stepId),
      });
    } else if (event.type === 'permission') {
      const todoId = waiverCalls.get(event.payload.callId);
      if (todoId === undefined || event.payload.decision === 'auto') continue;
      const isApproved = event.payload.decision === 'approved';
      const items = flows.get(todoId) ?? [];
      const askedIndex = items.findLastIndex((item) => item.kind === 'waiveAsk');
      flows.set(
        todoId,
        items.map((item, index) => (index === askedIndex ? { ...item, label: '예외 요청' } : item)),
      );
      push(todoId, {
        kind: isApproved ? 'waive' : 'waiveNo',
        label: isApproved ? '예외 승인 · 사용자' : '예외 거부 · 사용자',
        step: getStepSuffix(event.stepId),
      });
    } else if (event.type === 'verification') {
      const { todoId, evidence, gate } = event.payload;
      markStep(todoId, event.stepId);
      const step = getStepSuffix(event.stepId);
      const exit = evidence.exitCode === undefined ? '' : ` · exit ${evidence.exitCode}`;
      if (gate?.passed === false) {
        push(todoId, {
          kind: 'gate',
          label: `게이트 실패 · ${summarizeGateFindings(gate.findings)}`,
          step,
        });
      } else if (evidence.exitCode === 0) {
        push(todoId, { kind: 'pass', label: `검증 통과${exit}`, step });
      } else {
        push(todoId, { kind: 'fail', label: `검증 실패${exit}`, step });
      }
    }
  }

  // 지금 막힌 할 일의 사유는 행에 따로 보이므로, 가장 최근 막힘 항목에서는 사유를 뺍니다.
  for (const todo of todos) {
    addPhase(getPhaseName(todo));
    const items = flows.get(todo.id);
    const lastBlock = items?.findLastIndex((item) => item.kind === 'block') ?? -1;
    if (todo.status === 'blocked' && items && lastBlock >= 0) {
      flows.set(
        todo.id,
        items.map((item, index) => (index === lastBlock ? { ...item, label: '막힘' } : item)),
      );
    }
  }

  const steps = new Map<string, number>();
  const stepSets = new Map<string, Set<string>>();
  for (const todo of todos) {
    const name = getPhaseName(todo);
    const merged = stepSets.get(name) ?? new Set<string>();
    for (const id of stepIds.get(todo.id) ?? []) merged.add(id);
    stepSets.set(name, merged);
  }
  for (const [name, set] of stepSets) steps.set(name, set.size);

  return { objective, criteria, current, phaseNames, flows, steps };
}

interface Phase {
  name: string;
  todos: Todo[];
}

const isFinished = (todo: Todo): boolean =>
  todo.status === 'verified' || todo.status === 'abandoned';
const isPhaseDone = (phase: Phase): boolean => phase.todos.every(isFinished);

/** 검증 명령 줄 오른쪽에 적는 결과입니다. 아직 결과가 없으면 null입니다. */
function getResult(
  todo: Todo,
  isAwaitingApproval: boolean,
): { text: string; tone: 'ok' | 'bad' | 'muted' } | null {
  const exitCode = todo.evidence?.exitCode;
  if (todo.status === 'verified' && exitCode !== undefined) {
    return { text: `exit ${exitCode}`, tone: 'ok' };
  }
  if (exitCode !== undefined && exitCode !== 0) return { text: `exit ${exitCode}`, tone: 'bad' };
  if (exitCode !== undefined && todo.evidence?.gateFindings !== undefined) {
    return { text: `exit ${exitCode}`, tone: 'muted' };
  }
  if (todo.status === 'interrupted') return { text: 'aborted', tone: 'muted' };
  if (todo.status === 'attempted' && isAwaitingApproval)
    return { text: '승인 대기', tone: 'muted' };
  if (todo.status === 'attempted' && todo.evidence === undefined) {
    return { text: '실행 전', tone: 'muted' };
  }
  return null;
}

const resultTone = {
  ok: 'text-success',
  bad: 'text-danger',
  muted: 'text-foreground-subtle',
};

const menuItemClass =
  'flex h-8 w-full cursor-default items-center gap-2 rounded-sm px-2.5 text-[13px] leading-[18px] font-medium text-foreground outline-none data-[highlighted]:bg-surface-hover';

/**
 * 할 일 하나의 ⋯ 메뉴입니다. 포기하기는 확인 창을 거치고, 포기 취소는 바로 보냅니다.
 * 실행 중인 세션은 스텝이 끝난 뒤 반영하므로, 요청을 보내는 동안 단추만 잠그고 상태는 저장소가 새로 읽은 값을 그립니다.
 */
function TodoMenu({ sessionId, todo }: { sessionId: string; todo: Todo }) {
  const actions = useActions();
  const [isConfirming, setIsConfirming] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const isConfirmRequested = useRef(false);

  const send = (request: Promise<boolean>): void => {
    setIsPending(true);
    runAction(
      request.finally(() => {
        setIsPending(false);
      }),
    );
  };

  return (
    <Popover.Root open={isConfirming} onOpenChange={setIsConfirming}>
      <DropdownMenu.Root>
        <Popover.Anchor asChild>
          <DropdownMenu.Trigger
            ref={triggerRef}
            disabled={isPending}
            aria-label="할 일 메뉴"
            className="flex size-6 shrink-0 items-center justify-center rounded-sm text-foreground-muted hover:bg-surface-hover disabled:opacity-40"
          >
            <Ellipsis aria-hidden className="size-4" />
          </DropdownMenu.Trigger>
        </Popover.Anchor>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            onCloseAutoFocus={(event) => {
              if (!isConfirmRequested.current) return;
              isConfirmRequested.current = false;
              event.preventDefault();
            }}
            className="z-50 min-w-44 rounded-lg bg-popover p-1 outline-1 -outline-offset-1 outline-border-strong"
          >
            {todo.status === 'abandoned' ? (
              <DropdownMenu.Item
                className={menuItemClass}
                onSelect={() => {
                  send(actions.restoreTodo(sessionId, todo.id));
                }}
              >
                <RotateCcw aria-hidden className="size-3.5" />
                포기 취소
              </DropdownMenu.Item>
            ) : (
              <DropdownMenu.Item
                className={menuItemClass}
                onSelect={() => {
                  isConfirmRequested.current = true;
                  setIsConfirming(true);
                }}
              >
                <CircleSlash aria-hidden className="size-3.5" />
                포기하기
              </DropdownMenu.Item>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          aria-label="이 할 일을 포기할까요?"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
          className="z-50 flex w-[308px] flex-col gap-2.5 rounded-lg bg-popover p-5 outline-1 -outline-offset-1 outline-border-strong"
        >
          <p className="text-[13px] leading-[18px] font-semibold text-foreground">
            이 할 일을 포기할까요?
          </p>
          <p className="text-xs leading-[18px] text-foreground-muted">
            포기한 할 일은 완료 판정에서 빠집니다. 같은 메뉴의 포기 취소로 되돌릴 수 있습니다.
          </p>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setIsConfirming(false);
              }}
            >
              취소
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setIsConfirming(false);
                send(actions.abandonTodo(sessionId, todo.id));
              }}
            >
              포기하기
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** 할 일 하나의 시간순 흐름입니다. 항목이 많으면 앞부분을 "이전 N개 보기" 단추 하나로 접습니다. */
function FlowList({ items }: { items: readonly FlowItem[] }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isFolded = items.length > flowFoldLimit && !isExpanded;
  const hiddenCount = items.length - flowFoldLimit;
  const shown = isFolded ? items.slice(hiddenCount) : items;
  return (
    <ul className="flex flex-col pt-1">
      {isFolded && (
        <li>
          <button
            type="button"
            onClick={() => {
              setIsExpanded(true);
            }}
            className="flex w-full items-center gap-2 rounded-sm py-0.5 text-left text-xs leading-4 text-foreground-muted hover:bg-surface-hover"
          >
            <ChevronsUp aria-hidden className="size-3 shrink-0" />
            이전 {hiddenCount}개 보기
          </button>
        </li>
      )}
      {shown.map((item, index) => {
        const { icon: Icon, color } = flowStyle[item.kind];
        return (
          <li
            key={`${items.length - shown.length + index}`}
            className="flex items-start gap-2 py-0.5 text-xs leading-4 text-foreground-muted"
          >
            <span className="flex h-4 w-3 shrink-0 items-center">
              <Icon aria-hidden className={cn('size-3', color)} />
            </span>
            <span className="min-w-0 flex-1">
              {item.label}
              {item.step}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function TodoRow({
  sessionId,
  todo,
  isCurrent,
  isAwaitingApproval,
  flow,
}: {
  sessionId: string;
  todo: Todo;
  isCurrent: boolean;
  isAwaitingApproval: boolean;
  flow: readonly FlowItem[];
}) {
  const style = statusStyle[todo.status];
  const Icon = style.icon;
  const result = getResult(todo, isAwaitingApproval);
  return (
    <li
      aria-current={isCurrent ? 'step' : undefined}
      className={cn('flex items-start gap-2.5 rounded-md p-2', isCurrent && 'bg-surface-hover')}
    >
      <span className="flex h-5 w-4 shrink-0 items-center">
        <Icon aria-hidden className={cn('size-4', style.color)} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start gap-1.5">
          <p
            className={cn(
              'min-w-0 flex-1 text-[13px] leading-5 font-medium',
              todo.status === 'abandoned' ? 'text-foreground-subtle' : 'text-foreground',
            )}
          >
            {todo.content}
          </p>
          {isCurrent && (
            <span className="rounded-[4px] bg-primary px-1.5 text-[11px] leading-[18px] font-semibold text-primary-foreground">
              작업 중
            </span>
          )}
        </div>
        <p className="flex items-center gap-1.5 text-xs leading-4">
          <span className={cn('font-medium', style.color)}>
            {todo.status === 'verified' && todo.evidence?.waiver
              ? '검증됨 · 예외 승인'
              : style.label}
          </span>
          {todo.verify && <span className="text-foreground-subtle">출처 {todo.verify.origin}</span>}
        </p>
        {todo.status === 'blocked' && todo.blockedReason && (
          <p className="text-xs leading-4 text-foreground">{todo.blockedReason}</p>
        )}
        {todo.verify && (
          <p className="flex items-center gap-1.5 font-mono text-xs leading-4">
            <span className="min-w-0 flex-1 truncate text-foreground-muted">
              $ {todo.verify.command}
            </span>
            {result && (
              <span className={cn('font-medium', resultTone[result.tone])}>{result.text}</span>
            )}
          </p>
        )}
        {flow.length > 0 && <FlowList items={flow} />}
      </div>
      {todo.status !== 'verified' && <TodoMenu sessionId={sessionId} todo={todo} />}
    </li>
  );
}

/** 카드 머리 오른쪽에 적는 끝남 표시입니다. 끝나지 않았으면 "검증 수/분모"를 적습니다. */
function PhaseSummary({ phase, steps }: { phase: Phase; steps: number }): ReactNode {
  const verified = phase.todos.filter((todo) => todo.status === 'verified').length;
  const denominator = phase.todos.filter((todo) => todo.status !== 'abandoned').length;
  const abandoned = phase.todos.length - denominator;
  if (!isPhaseDone(phase)) {
    return (
      <span className="font-mono text-xs leading-4 font-medium text-foreground-muted">
        {verified}/{denominator}
      </span>
    );
  }
  const waived = phase.todos.filter(
    (todo) => todo.status === 'verified' && todo.evidence?.waiver !== undefined,
  ).length;
  let icon = <CircleCheck aria-hidden className="size-3.5 text-success" />;
  let label = '통과';
  let labelClass = 'text-success';
  if (denominator === 0) {
    icon = <CircleSlash aria-hidden className="size-3.5 text-foreground-subtle" />;
    label = '모두 포기';
    labelClass = 'text-foreground-muted';
  } else if (abandoned > 0) {
    label = `끝남 · 포기 ${abandoned}`;
    labelClass = 'text-foreground-muted';
  }
  return (
    <>
      {icon}
      <span className={cn('text-xs leading-4 font-medium', labelClass)}>{label}</span>
      {waived > 0 && denominator > 0 && abandoned === 0 && (
        <span className="text-xs leading-4 font-medium text-foreground-muted">· 예외 {waived}</span>
      )}
      {steps > 0 && (
        <span className="text-xs leading-4 text-foreground-subtle">· 스텝 {steps}</span>
      )}
    </>
  );
}

function PhaseCard({
  sessionId,
  phase,
  criterion,
  steps,
  isOpen,
  onToggle,
  currentId,
  isAwaitingApproval,
  flows,
}: {
  sessionId: string;
  phase: Phase;
  criterion: string | undefined;
  steps: number;
  isOpen: boolean;
  onToggle: () => void;
  currentId: string | null;
  isAwaitingApproval: boolean;
  flows: ReadonlyMap<string, FlowItem[]>;
}) {
  const verified = phase.todos.filter((todo) => todo.status === 'verified').length;
  const denominator = phase.todos.filter((todo) => todo.status !== 'abandoned').length;
  const isDone = isPhaseDone(phase);
  const Chevron = isOpen ? ChevronDown : ChevronRight;
  return (
    <section aria-label={phase.name} className="flex flex-col rounded-lg bg-background">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2.5 text-left hover:bg-surface-hover"
      >
        <Chevron aria-hidden className="size-3.5 shrink-0 text-foreground-muted" />
        <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] font-semibold text-foreground">
          {phase.name}
        </span>
        <PhaseSummary phase={phase} steps={steps} />
      </button>
      {!isDone && (
        <div className={cn('flex flex-col gap-1.5 px-2.5', isOpen ? 'pb-1' : 'pb-2.5')}>
          {criterion && (
            <p className="text-xs leading-4 text-foreground-muted">완료 조건 · {criterion}</p>
          )}
          <div
            role="progressbar"
            aria-label={`${phase.name} 검증 진행`}
            aria-valuemin={0}
            aria-valuemax={denominator}
            aria-valuenow={verified}
            className="h-[3px] rounded-[2px] bg-border"
          >
            <div
              className="h-full rounded-[2px] bg-success"
              style={{ width: denominator === 0 ? 0 : `${(verified / denominator) * 100}%` }}
            />
          </div>
        </div>
      )}
      {isOpen && (
        <ul className="flex flex-col gap-0.5 px-1 pb-1.5">
          {phase.todos.map((todo) => (
            <TodoRow
              key={todo.id}
              sessionId={sessionId}
              todo={todo}
              isCurrent={todo.id === currentId}
              isAwaitingApproval={isAwaitingApproval}
              flow={flows.get(todo.id) ?? []}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function Banner({
  icon: Icon,
  color,
  title,
  body,
}: {
  icon: LucideIcon;
  color: string;
  title: string;
  body: string;
}) {
  return (
    <div role="status" className="flex items-start gap-2.5 rounded-lg bg-surface px-3 py-2.5">
      <Icon aria-hidden className={cn('mt-px size-4 shrink-0', color)} />
      <div className="flex flex-col gap-0.5">
        <p className="text-[13px] leading-[18px] font-semibold text-foreground">{title}</p>
        <p className="text-xs leading-4 text-foreground-muted">{body}</p>
      </div>
    </div>
  );
}

const runningStatuses = new Set<SessionRecord['status']>([
  'created',
  'running',
  'awaiting_approval',
  'awaiting_user',
]);

interface TodoPanelProps {
  record: SessionRecord;
  events: readonly OraEvent[];
  todos: readonly Todo[];
}

/**
 * 오른쪽 "할 일" 패널입니다. phase 카드마다 진행과 할 일별 흐름을 보여 줍니다.
 * 사용자가 카드를 펼치거나 접은 선택은 작업 중 할 일이 다른 phase로 옮겨 가면 버립니다.
 */
export function TodoPanel({ record, events, todos }: TodoPanelProps) {
  const [choice, setChoice] = useState<{ anchor: string; open: Record<string, boolean> }>({
    anchor: '',
    open: {},
  });
  const data = readPanelData(events, todos);
  const isRunning = runningStatuses.has(record.status);
  const phases: Phase[] = data.phaseNames
    .map((name) => ({ name, todos: todos.filter((todo) => getPhaseName(todo) === name) }))
    .filter((phase) => phase.todos.length > 0);

  const currentTodo = isRunning ? todos.find((todo) => todo.id === data.current) : undefined;
  const currentId = currentTodo?.id ?? null;
  const currentPhase = currentTodo ? getPhaseName(currentTodo) : undefined;
  const firstUnfinished = phases.find((phase) => !isPhaseDone(phase))?.name;
  const defaultOpen = currentPhase ?? firstUnfinished;
  const anchor = currentPhase ?? '';
  const picked = choice.anchor === anchor ? choice.open : {};
  const isOpen = (name: string): boolean => picked[name] ?? name === defaultOpen;

  const verified = todos.filter((todo) => todo.status === 'verified').length;
  const denominator = todos.filter((todo) => todo.status !== 'abandoned').length;
  const abandoned = todos.length - denominator;
  const blocked = todos.filter((todo) => todo.status === 'blocked').length;
  const isBlockedStop = record.status === 'stopped' && record.endReason === 'blocked';
  const isDoneWithAbandoned = record.status === 'completed' && abandoned > 0;

  return (
    <aside
      id={panelId}
      tabIndex={-1}
      aria-label="할 일"
      className="flex w-[340px] shrink-0 flex-col bg-sidebar outline-none"
    >
      <div className="flex h-12 shrink-0 items-center gap-4 px-4">
        <h2 className="text-[13px] leading-[18px] font-semibold text-foreground">할 일</h2>
        <span className="text-[13px] leading-[18px] font-medium text-foreground-subtle">변경</span>
        <span className="text-[13px] leading-[18px] font-medium text-foreground-subtle">파일</span>
        <span className="ml-auto font-mono text-xs leading-4 font-medium text-foreground-muted">
          검증 {verified}/{denominator}
        </span>
      </div>
      <div className="flex min-h-0 flex-col gap-2.5 overflow-y-auto px-2 pt-1 pb-4">
        {isBlockedStop && (
          <Banner
            icon={OctagonPause}
            color="text-warning"
            title="막혀서 멈췄습니다"
            body={`막힌 할 일 ${blocked}개. 사유를 보고 포기하거나, 메시지로 다른 방법을 알려 주세요.`}
          />
        )}
        {isDoneWithAbandoned && (
          <Banner
            icon={CircleCheck}
            color="text-success"
            title="검증을 통과해 끝났습니다"
            body={`검증 ${verified}개 통과 · 포기 ${abandoned}개`}
          />
        )}
        {data.objective !== '' && (
          <div className="flex flex-col gap-0.5 px-2">
            <p className="text-xs leading-4 font-medium text-foreground-subtle">목표</p>
            <p className="text-[13px] leading-[18px] text-foreground-muted">{data.objective}</p>
          </div>
        )}
        {todos.length === 0 ? (
          <div className="flex flex-col gap-1 px-2 pt-1">
            <p className="text-[13px] leading-[18px] font-medium text-foreground-muted">
              할 일이 아직 없습니다
            </p>
            <p className="w-[300px] text-xs leading-4 text-foreground-subtle">
              Plan 단계에서 Ora가 할 일과 검증 명령을 정하면 여기에 쌓입니다.
            </p>
          </div>
        ) : (
          phases.map((phase) => (
            <PhaseCard
              key={phase.name}
              sessionId={record.id}
              phase={phase}
              criterion={data.criteria.get(phase.name)}
              steps={data.steps.get(phase.name) ?? 0}
              isOpen={isOpen(phase.name)}
              onToggle={() => {
                setChoice({ anchor, open: { ...picked, [phase.name]: !isOpen(phase.name) } });
              }}
              currentId={currentId}
              isAwaitingApproval={record.status === 'awaiting_approval'}
              flows={data.flows}
            />
          ))
        )}
      </div>
    </aside>
  );
}
