import type { Todo, TodoStatus } from '@ora/protocol';

export interface ModelTodoEntry {
  readonly id: string;
  readonly content?: string;
  readonly status?: TodoStatus;
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

const MODEL_TRANSITIONS: readonly (readonly [TodoStatus, TodoStatus])[] = [
  ['pending', 'attempted'],
  ['failed', 'attempted'],
  ['interrupted', 'attempted'],
  ['attempted', 'claimed_verified'],
];

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
  const requested = entry.status;
  if (requested === 'verified' || requested === 'failed') {
    return reject(`${requested}는 엔진만 쓸 수 있습니다. verify.run으로 검증 명령을 실행합니다.`);
  }

  let attempts = existing.attempts;
  let status = existing.status;
  if (requested !== undefined && requested !== existing.status) {
    if (!MODEL_TRANSITIONS.some(([from, to]) => from === existing.status && to === requested)) {
      return reject(`${existing.status} → ${requested} 전이는 허용하지 않습니다.`);
    }
    if (requested === 'claimed_verified' && entry.claim === undefined) {
      return reject(
        'claimed_verified에는 실행한 검사의 command와 result를 claim으로 붙여야 합니다.',
      );
    }
    if (existing.status === 'failed' && existing.attempts - 1 >= maxRepairsPerTodo) {
      return reject(`수리 상한(${maxRepairsPerTodo}회)을 넘었습니다.`);
    }
    if (requested === 'attempted') attempts += 1;
    status = requested;
  }

  const updated: Todo = {
    ...existing,
    content: entry.content ?? existing.content,
    writeScope: entry.writeScope === undefined ? existing.writeScope : [...entry.writeScope],
    ...(entry.verify === undefined
      ? {}
      : { verify: { command: entry.verify.command, origin: 'model' as const } }),
    status,
    attempts,
    updatedAt: now,
  };
  todos.set(updated.id, updated);
  return { todo: updated, from: existing.status, to: status };
}

function addTodo(todos: Map<string, Todo>, entry: ModelTodoEntry, now: string): TodoUpdateOutcome {
  const todo: Todo = {
    id: entry.id,
    content: entry.content ?? entry.id,
    status: 'pending',
    attempts: 0,
    writeScope: entry.writeScope === undefined ? [] : [...entry.writeScope],
    ...(entry.verify === undefined
      ? {}
      : { verify: { command: entry.verify.command, origin: 'model' as const } }),
    updatedAt: now,
  };
  if (entry.content === undefined) {
    return { todo, to: entry.status ?? 'pending', rejected: '새 todo에는 content가 필요합니다.' };
  }
  if (entry.status !== undefined && entry.status !== 'pending') {
    return { todo, to: entry.status, rejected: '새 todo는 pending으로만 추가할 수 있습니다.' };
  }
  todos.set(todo.id, todo);
  return { todo, to: 'pending' };
}
