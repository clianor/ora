import { Brain, Check, ChevronDown, ChevronRight, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { useStore } from '../store.tsx';

function ChoiceButton({
  isPicked,
  label,
  onClick,
  children,
}: {
  isPicked: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={isPicked}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs leading-4 transition-colors duration-(--duration-fast) ease-(--ease-out) hover:bg-surface-hover',
        isPicked
          ? 'bg-surface-hover font-semibold text-foreground outline-1 -outline-offset-1 outline-border-strong'
          : 'font-medium text-foreground-muted',
      )}
    >
      {isPicked ? <Check aria-hidden className="size-3.5" /> : children}
      {label}
    </button>
  );
}

/**
 * 세션이 끝난 뒤 완료 보고 아래에 두는 "이번 작업에 쓴 메모리 N개" 줄입니다. 접힌 채로 시작하고, 펼치면 메모리마다 도움 여부를 고릅니다.
 * 고른 단추를 다시 누르면 선택을 해제합니다. 이 세션이 회상 팩에 넣은 메모리가 없으면 아무것도 그리지 않습니다.
 */
export function MemoryFeedback({ sessionId }: { sessionId: string }) {
  const { memory, actions } = useStore();
  const [isOpen, setIsOpen] = useState(false);
  const [error, setError] = useState<string>();

  /** 회상 팩에 넣은 메모리와 고른 값은 서버의 usage.jsonl에 있어서, 세션 화면이 열릴 때 읽어야 합니다. */
  useEffect(() => {
    actions.refreshSessionFeedback(sessionId).catch(() => undefined);
  }, [actions, sessionId]);

  const items = memory.feedback?.[sessionId]?.items ?? [];
  if (items.length === 0) return null;
  const Chevron = isOpen ? ChevronDown : ChevronRight;
  const pick = (lessonId: string, current: boolean | null, value: boolean) => {
    setError(undefined);
    actions
      .setMemoryFeedback(sessionId, lessonId, current === value ? null : value)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  };
  return (
    <section className="flex flex-col rounded-lg border border-border">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => {
          setIsOpen(!isOpen);
        }}
        className="flex h-9 items-center gap-2 px-3 text-left"
      >
        <Chevron aria-hidden className="size-3.5 text-foreground-muted" />
        <span className="text-[13px] leading-[18px] font-medium text-foreground-muted">
          이번 작업에 쓴 메모리 {String(items.length)}개
        </span>
        <span className="flex-1" />
        <span className="text-xs leading-4 text-foreground-subtle">고르지 않아도 됩니다</span>
      </button>
      {isOpen && (
        <ul className="flex flex-col divide-y divide-border border-t border-border">
          {items.map((item) => (
            <li key={item.lessonId} className="flex items-center gap-2.5 px-3 py-2">
              <Brain aria-hidden className="size-3.5 shrink-0 text-foreground-subtle" />
              <span
                title={item.text}
                className="min-w-0 flex-1 truncate text-[13px] leading-[19px] text-foreground"
              >
                {item.text}
              </span>
              <ChoiceButton
                isPicked={item.helpful === true}
                label="도움 됨"
                onClick={() => {
                  pick(item.lessonId, item.helpful, true);
                }}
              >
                <ThumbsUp aria-hidden className="size-3.5" />
              </ChoiceButton>
              <ChoiceButton
                isPicked={item.helpful === false}
                label="도움 안 됨"
                onClick={() => {
                  pick(item.lessonId, item.helpful, false);
                }}
              >
                <ThumbsDown aria-hidden className="size-3.5" />
              </ChoiceButton>
            </li>
          ))}
        </ul>
      )}
      {error !== undefined && (
        <p role="alert" className="px-3 pb-2 text-xs leading-4 text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
