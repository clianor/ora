import { defaultPhaseName } from '@ora/protocol';
import type { Todo, TodoStatus } from '@ora/protocol';

export interface ModelTodoEntry {
  readonly id: string;
  readonly content?: string;
  readonly status?: TodoStatus;
  readonly phase?: string;
  /** `blocked`로 바꿀 때 적는 사유다. */
  readonly reason?: string;
  /** true면 이 todo를 작업 중으로 바꾼다. */
  readonly current?: true;
  readonly writeScope?: readonly string[];
  readonly verify?: { readonly command: string };
  readonly claim?: { readonly command: string; readonly result: string };
}

export interface TodoUpdateOutcome {
  readonly todo: Todo;
  readonly from?: TodoStatus;
  readonly to: TodoStatus;
  readonly rejected?: string;
}

export interface UserTodoAction {
  readonly todoId: string;
  readonly action: 'abandon' | 'restore';
}

const MODEL_TRANSITIONS: readonly (readonly [TodoStatus, TodoStatus])[] = [
  ['pending', 'attempted'],
  ['failed', 'attempted'],
  ['interrupted', 'attempted'],
  ['attempted', 'claimed_verified'],
  ['pending', 'blocked'],
  ['attempted', 'blocked'],
  ['claimed_verified', 'blocked'],
  ['failed', 'blocked'],
  ['interrupted', 'blocked'],
  ['blocked', 'attempted'],
];

const CANDIDATE_STATUSES: readonly TodoStatus[] = [
  'pending',
  'attempted',
  'claimed_verified',
  'failed',
  'interrupted',
];

/** 작업 중으로 고를 수 있는 todo다: `blocked`가 아닌 남은 todo. */
export function isCandidate(status: TodoStatus): boolean {
  return CANDIDATE_STATUSES.includes(status);
}

/** 끝난 todo다. 세션 완료와 단계 이동 조건이 이 집합을 쓴다. */
export function isDone(status: TodoStatus): boolean {
  return status === 'verified' || status === 'abandoned';
}

export function phaseOf(todo: Todo): string {
  return todo.phase ?? defaultPhaseName;
}

/** 앞뒤 공백을 지운 phase 이름이다. 빈 이름은 기본 phase이고, 40자를 넘으면 `undefined`다. */
export function normalizePhaseName(name: string | undefined): string | undefined {
  const trimmed = (name ?? '').trim();
  if (trimmed === '') return defaultPhaseName;
  return trimmed.length > 40 ? undefined : trimmed;
}

/** phase 순서는 처음 나온 순서다. 비어도 지우지 않는다. */
export function ensurePhase(order: string[], name: string): void {
  if (!order.includes(name)) order.push(name);
}

/**
 * 작업 중으로 옮길 todo ID를 고른다. 순서는 phase 순서, 같은 phase에서는 만든 순서다 (`todos`는 만든 순서).
 * `afterId` 뒤에서 찾기 시작하고, 끝에 후보가 없으면 처음으로 돌아간다.
 */
export function pickNext(
  todos: readonly Todo[],
  order: readonly string[],
  afterId?: string,
): string | undefined {
  const rank = (todo: Todo) => {
    const index = order.indexOf(phaseOf(todo));
    return index === -1 ? order.length : index;
  };
  const sorted = todos
    .map((todo, created) => ({ todo, created }))
    .sort((a, b) => rank(a.todo) - rank(b.todo) || a.created - b.created)
    .map(({ todo }) => todo);
  const start = afterId === undefined ? -1 : sorted.findIndex((todo) => todo.id === afterId);
  const rotated = [...sorted.slice(start + 1), ...sorted.slice(0, start + 1)];
  return rotated.find((todo) => isCandidate(todo.status))?.id;
}

/** 모델의 todo.update 항목 하나를 SPEC 2.3.3절 전이 표로 판정한다. 거부하면 todos를 바꾸지 않는다. */
export function applyModelTodoEntry(
  todos: Map<string, Todo>,
  entry: ModelTodoEntry,
  now: string,
  maxRepairsPerTodo: number,
): TodoUpdateOutcome {
  const existing = todos.get(entry.id);
  if (existing === undefined) return addTodo(todos, entry, now);

  const reject = (reason: string): TodoUpdateOutcome => ({
    todo: existing,
    from: existing.status,
    to: entry.status ?? existing.status,
    rejected: reason,
  });

  if (existing.status === 'verified') {
    return reject('verified todo는 모델이 바꿀 수 없습니다. 쓰기 범위가 바뀌면 엔진이 되돌립니다.');
  }
  if (existing.status === 'abandoned') {
    return reject('abandoned todo는 사용자만 되돌릴 수 있습니다.');
  }
  const requested = entry.status;
  if (requested === 'verified' || requested === 'failed') {
    return reject(`${requested}는 엔진만 쓸 수 있습니다. verify.run으로 검증 명령을 실행합니다.`);
  }
  if (requested === 'abandoned') {
    return reject('abandoned는 사용자만 쓸 수 있습니다. 끝낼 수 없는 todo는 blocked로 표시합니다.');
  }

  let phase = existing.phase;
  if (entry.phase !== undefined) {
    const normalized = normalizePhaseName(entry.phase);
    if (normalized === undefined) return reject('phase 이름은 40자 이하여야 합니다.');
    phase = normalized;
  }

  let attempts = existing.attempts;
  let status = existing.status;
  let blockedReason = existing.blockedReason;
  if (requested !== undefined && requested !== existing.status) {
    if (!MODEL_TRANSITIONS.some(([from, to]) => from === existing.status && to === requested)) {
      return reject(`${existing.status} → ${requested} 전이는 허용하지 않습니다.`);
    }
    if (requested === 'claimed_verified' && entry.claim === undefined) {
      return reject(
        'claimed_verified에는 실행한 검사의 command와 result를 claim으로 붙여야 합니다.',
      );
    }
    if (requested === 'blocked') {
      const reason = (entry.reason ?? '').trim();
      if (reason === '' || reason.length > 300) {
        return reject('blocked에는 1~300자의 사유(reason)가 필요합니다.');
      }
      blockedReason = reason;
    }
    if (existing.status === 'failed' && requested === 'attempted') {
      if (existing.attempts - 1 >= maxRepairsPerTodo) {
        return reject(`고친 횟수가 상한(${maxRepairsPerTodo}회)에 이르렀습니다.`);
      }
    }
    if (requested === 'attempted') attempts += 1;
    if (requested !== 'blocked') blockedReason = undefined;
    status = requested;
  }
  if (entry.current === true && !isCandidate(status)) {
    return reject(`${status} 상태의 todo는 작업 중으로 지정할 수 없습니다.`);
  }

  const updated: Todo = {
    ...existing,
    content: entry.content ?? existing.content,
    writeScope: entry.writeScope === undefined ? existing.writeScope : [...entry.writeScope],
    ...(phase === undefined ? {} : { phase }),
    ...(blockedReason === undefined ? {} : { blockedReason }),
    ...(entry.verify === undefined
      ? {}
      : { verify: { command: entry.verify.command, origin: 'model' as const } }),
    status,
    attempts,
    updatedAt: now,
  };
  if (blockedReason === undefined) delete updated.blockedReason;
  todos.set(updated.id, updated);
  return { todo: updated, from: existing.status, to: status };
}

function addTodo(todos: Map<string, Todo>, entry: ModelTodoEntry, now: string): TodoUpdateOutcome {
  const phase = normalizePhaseName(entry.phase);
  const todo: Todo = {
    id: entry.id,
    content: entry.content ?? entry.id,
    status: 'pending',
    attempts: 0,
    writeScope: entry.writeScope === undefined ? [] : [...entry.writeScope],
    phase: phase ?? defaultPhaseName,
    ...(entry.verify === undefined
      ? {}
      : { verify: { command: entry.verify.command, origin: 'model' as const } }),
    updatedAt: now,
  };
  if (entry.content === undefined) {
    return { todo, to: entry.status ?? 'pending', rejected: '새 todo에는 content가 필요합니다.' };
  }
  if (phase === undefined) {
    return { todo, to: 'pending', rejected: 'phase 이름은 40자 이하여야 합니다.' };
  }
  if (entry.status !== undefined && entry.status !== 'pending') {
    return { todo, to: entry.status, rejected: '새 todo는 pending으로만 추가할 수 있습니다.' };
  }
  todos.set(todo.id, todo);
  return { todo, to: 'pending' };
}

/**
 * 작업 중 todo가 후보가 아니면 다음 후보를 고른다. 바뀌지 않으면 `undefined`이고,
 * 바뀌었으면 `todo_update`의 `current`에 적을 값을 돌려준다(`null`은 작업 중인 todo 없음).
 */
export function reconcileCurrent(
  todos: readonly Todo[],
  order: readonly string[],
  current: string | undefined,
): { current: string | null } | undefined {
  const holder = todos.find((todo) => todo.id === current);
  if (holder !== undefined && isCandidate(holder.status)) return undefined;
  const next = pickNext(todos, order, current);
  return next === current ? undefined : { current: next ?? null };
}

/** 사용자의 포기와 포기 취소를 적용한다. 거부하면 todos를 바꾸지 않는다. */
export function applyUserTodoAction(
  todos: Map<string, Todo>,
  action: UserTodoAction,
  now: string,
): TodoUpdateOutcome | undefined {
  const existing = todos.get(action.todoId);
  if (existing === undefined) return undefined;
  const to: TodoStatus = action.action === 'abandon' ? 'abandoned' : 'pending';
  const reject = (rejected: string): TodoUpdateOutcome => ({
    todo: existing,
    from: existing.status,
    to,
    rejected,
  });
  if (action.action === 'abandon' && isDone(existing.status)) {
    return reject(`${existing.status} todo는 포기할 수 없습니다.`);
  }
  if (action.action === 'restore' && existing.status !== 'abandoned') {
    return reject('abandoned가 아닌 todo는 포기를 취소할 수 없습니다.');
  }
  const updated: Todo = { ...existing, status: to, updatedAt: now };
  delete updated.blockedReason;
  todos.set(updated.id, updated);
  return { todo: updated, from: existing.status, to };
}
