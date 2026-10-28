import { stageSchema } from '@ora/protocol';
import type { Stage, Todo } from '@ora/protocol';

export const STAGES: readonly Stage[] = stageSchema.options;

const BACKWARD_TARGETS: readonly Stage[] = ['decide', 'plan', 'execute'];

export function isBackwardAllowed(to: Stage): boolean {
  return BACKWARD_TARGETS.includes(to);
}

/** 단계를 떠날 때 SPEC 2.3.2절의 끝나는 조건을 확인하고, 조건을 채우지 못했으면 사유를 돌려준다. */
export function checkStageExit(stage: Stage, todos: readonly Todo[]): string | undefined {
  switch (stage) {
    case 'understand':
      return todos.length === 0
        ? 'todo 초안이 없습니다. todo.update로 목표와 성공 조건을 적습니다.'
        : undefined;
    case 'plan': {
      const missing = todos.filter((todo) => todo.verify === undefined).map((todo) => todo.id);
      if (todos.length === 0) return 'todo가 없습니다.';
      return missing.length > 0
        ? `검증 명령이 없는 todo가 있습니다: ${missing.join(', ')}`
        : undefined;
    }
    case 'execute': {
      const open = todos
        .filter((todo) => ['pending', 'failed', 'interrupted'].includes(todo.status))
        .map((todo) => `${todo.id}(${todo.status})`);
      return open.length > 0
        ? `아직 시도하지 않았거나 실패한 todo가 있습니다: ${open.join(', ')}`
        : undefined;
    }
    case 'verify': {
      const open = todos.filter((todo) => todo.status !== 'verified').map((todo) => todo.id);
      return open.length > 0 ? `verified가 아닌 todo가 있습니다: ${open.join(', ')}` : undefined;
    }
    default:
      return undefined;
  }
}
