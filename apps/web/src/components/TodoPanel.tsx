import type { Todo, TodoStatus } from '@ora/protocol';
import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CirclePause,
  CircleX,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../lib/cn.ts';

const statusStyle: Record<TodoStatus, { label: string; icon: LucideIcon; color: string }> = {
  pending: { label: '대기', icon: Circle, color: 'text-foreground-subtle' },
  attempted: { label: '시도함', icon: CircleDashed, color: 'text-warning' },
  claimed_verified: { label: '모델 확인', icon: CircleDot, color: 'text-foreground-muted' },
  verified: { label: '검증됨', icon: CircleCheck, color: 'text-success' },
  failed: { label: '실패', icon: CircleX, color: 'text-danger' },
  interrupted: { label: '중단됨', icon: CirclePause, color: 'text-foreground-subtle' },
};

const panelId = 'todo-panel';

/** `⌘1`과 명령 팔레트가 할 일 패널로 포커스를 옮깁니다. 패널이 없는 화면에서는 아무 일도 하지 않습니다. */
export function focusTodoPanel(): void {
  document.getElementById(panelId)?.focus();
}

/** 검증 명령 줄 오른쪽에 적는 결과입니다. 아직 결과가 없으면 null입니다. */
function getResult(
  todo: Todo,
  isAwaitingApproval: boolean,
): { text: string; isOk: boolean } | null {
  if (todo.status === 'verified' && todo.evidence?.exitCode !== undefined) {
    return { text: `exit ${todo.evidence.exitCode}`, isOk: true };
  }
  if (todo.status === 'interrupted') return { text: 'aborted', isOk: false };
  if (todo.status === 'attempted' && isAwaitingApproval) return { text: '승인 대기', isOk: false };
  return null;
}

function TodoRow({
  todo,
  isCurrent,
  isAwaitingApproval,
}: {
  todo: Todo;
  isCurrent: boolean;
  isAwaitingApproval: boolean;
}) {
  const style = statusStyle[todo.status];
  const Icon = style.icon;
  const result = getResult(todo, isAwaitingApproval);
  return (
    <li
      aria-current={isCurrent ? 'step' : undefined}
      className={cn('flex items-start gap-2.5 rounded-md p-2.5', isCurrent && 'bg-surface-hover')}
    >
      <span className="flex h-5 w-4 shrink-0 items-center">
        <Icon aria-hidden className={cn('size-4', style.color)} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-[13px] leading-5 font-medium text-foreground">{todo.content}</p>
        <p className="flex items-center gap-1.5 text-xs leading-4">
          <span className={cn('font-medium', style.color)}>{style.label}</span>
          {todo.verify && <span className="text-foreground-subtle">출처 {todo.verify.origin}</span>}
        </p>
        {todo.verify ? (
          <p className="flex items-center gap-1.5 pt-0.5 font-mono text-xs leading-4">
            <span className="min-w-0 flex-1 truncate text-foreground-muted">
              $ {todo.verify.command}
            </span>
            {result && (
              <span
                className={cn(
                  'font-medium',
                  result.isOk ? 'text-success' : 'text-foreground-subtle',
                )}
              >
                {result.text}
              </span>
            )}
          </p>
        ) : (
          <p className="text-xs leading-4 text-foreground-subtle">
            검증 명령을 아직 선언하지 않았습니다
          </p>
        )}
      </div>
    </li>
  );
}

interface TodoPanelProps {
  todos: readonly Todo[];
  isAwaitingApproval: boolean;
}

/** 오른쪽 "할 일" 패널입니다. 각 할 일의 증거(검증 명령, 종료 코드, 출처)를 행 안에 보여 줍니다. */
export function TodoPanel({ todos, isAwaitingApproval }: TodoPanelProps) {
  const verified = todos.filter((todo) => todo.status === 'verified').length;
  const current = todos.find(
    (todo) => todo.status === 'attempted' || todo.status === 'interrupted',
  );
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
          {verified}/{todos.length}
        </span>
      </div>
      <div className="px-4 pb-2">
        <div
          role="progressbar"
          aria-label="검증 진행"
          aria-valuemin={0}
          aria-valuemax={todos.length}
          aria-valuenow={verified}
          className="h-[3px] rounded-[2px] bg-border"
        >
          <div
            className="h-full rounded-[2px] bg-success"
            style={{ width: todos.length === 0 ? 0 : `${(verified / todos.length) * 100}%` }}
          />
        </div>
      </div>
      {todos.length === 0 ? (
        <div className="flex flex-col gap-1 px-4 pt-2">
          <p className="text-[13px] leading-[18px] font-medium text-foreground-muted">
            할 일이 아직 없습니다
          </p>
          <p className="w-[300px] text-xs leading-4 text-foreground-subtle">
            Plan 단계에서 Ora가 할 일과 검증 명령을 정하면 여기에 쌓입니다.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-0.5 overflow-y-auto px-2">
          {todos.map((todo) => (
            <TodoRow
              key={todo.id}
              todo={todo}
              isCurrent={todo.id === current?.id}
              isAwaitingApproval={isAwaitingApproval}
            />
          ))}
        </ul>
      )}
    </aside>
  );
}
