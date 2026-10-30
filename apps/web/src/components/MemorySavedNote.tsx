import { Brain, Trash2 } from 'lucide-react';
import { runAction, useStore } from '../store.tsx';
import { Button } from '../ui/button.tsx';

/** 대화에 남는 "메모리에 저장했습니다" 줄입니다. 마우스를 올리거나 포커스를 주면 지우기 단추가 나옵니다. */
export function MemorySavedNote({ data }: { data: unknown }) {
  const { lessonId, text } = data as { lessonId: string; text: string };
  const { memory, actions } = useStore();
  const isDeleted = memory.list?.deletedIds.includes(lessonId) ?? false;
  const isArchived = memory.list?.archivedIds.includes(lessonId) ?? false;
  return (
    <p
      role="status"
      data-memory-note=""
      className="group flex min-h-[30px] items-center gap-2 rounded-md px-2.5 text-[13px] leading-[18px] hover:bg-surface focus-within:bg-surface [[data-memory-note]+&]:-mt-3.5"
    >
      <Brain aria-hidden className="size-3.5 shrink-0 text-foreground-muted" />
      {isDeleted ? (
        <span className="font-medium text-foreground-muted">지웠습니다</span>
      ) : (
        <span className="shrink-0 font-medium text-foreground-muted">메모리에 저장했습니다</span>
      )}
      <span aria-hidden className="shrink-0 text-foreground-subtle">
        ·
      </span>
      <span
        title={text}
        className={
          isDeleted
            ? 'min-w-0 flex-1 truncate text-foreground-subtle line-through'
            : 'min-w-0 flex-1 truncate text-foreground'
        }
      >
        {text}
      </span>
      {!isDeleted && !isArchived && (
        <Button
          variant="ghost"
          className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={() => {
            runAction(actions.deleteMemory(lessonId));
          }}
        >
          <Trash2 aria-hidden className="size-3.5" />
          지우기
        </Button>
      )}
    </p>
  );
}
