import { CircleCheck, MessageCircleQuestion, Pencil, Square, SquareCheck } from 'lucide-react';
import { Tabs } from 'radix-ui';
import type { QuestionAnswer, QuestionRequest } from '@ora/protocol';
import { useId, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { Button, KeyHint } from '../ui/button.tsx';

interface QuestionCardProps {
  request: QuestionRequest;
  draft?: { current: number; picks: number[][] };
  onAnswer: (answers: QuestionAnswer[]) => void;
}

/** `ask_user` 질문 카드입니다. 질문 탭으로 오가며 선택지를 하나 또는 여러 개 고르고 직접 입력도 받습니다(SPEC 2.5.1절). */
export function QuestionCard({ request, draft, onAnswer }: QuestionCardProps) {
  const { questions } = request;
  const [current, setCurrent] = useState(draft?.current ?? 0);
  const [picks, setPicks] = useState<number[][]>(
    questions.map((_, index) => draft?.picks[index] ?? []),
  );
  const [texts, setTexts] = useState<string[]>(questions.map(() => ''));
  const headingId = useId();

  const question = questions[current];
  if (!question) return null;
  const selected = picks[current] ?? [];
  const isLast = current === questions.length - 1;

  const togglePick = (optionIndex: number) => {
    setPicks((all) =>
      all.map((list, index) => {
        if (index !== current) return list;
        if (question.multiSelect !== true) return [optionIndex];
        return list.includes(optionIndex)
          ? list.filter((value) => value !== optionIndex)
          : [...list, optionIndex].sort((a, b) => a - b);
      }),
    );
  };

  const submit = () => {
    if (!isLast) {
      setCurrent(current + 1);
      return;
    }
    onAnswer(
      questions.map((item, index) => {
        const text = (texts[index] ?? '').trim();
        return {
          choices: (picks[index] ?? []).flatMap((pick) => item.options[pick] ?? []),
          ...(text === '' ? {} : { text }),
        };
      }),
    );
  };

  return (
    <section
      aria-label="질문"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <Tabs.Root
        value={String(current)}
        onValueChange={(value) => {
          setCurrent(Number(value));
        }}
        className="flex items-center gap-1"
      >
        <MessageCircleQuestion aria-hidden className="mr-1 size-4 text-foreground-muted" />
        <Tabs.List aria-label="질문 목록" className="flex items-center gap-1">
          {questions.map((item, index) => {
            const isCurrent = index === current;
            const isDone = !isCurrent && (picks[index]?.length ?? 0) > 0;
            return (
              <Tabs.Trigger
                key={item.question}
                value={String(index)}
                className={cn(
                  'inline-flex h-[26px] items-center gap-1.5 rounded-[6px] px-2.5 text-xs leading-4',
                  isCurrent
                    ? 'bg-background font-semibold text-foreground'
                    : 'font-medium text-foreground-muted',
                )}
              >
                {isDone && <CircleCheck aria-hidden className="size-[13px] text-success" />}
                {isCurrent && (
                  <span className="font-mono font-semibold text-foreground-subtle">
                    {index + 1}
                  </span>
                )}
                {item.header ?? `질문 ${index + 1}`}
                {isDone && <span className="sr-only">(답함)</span>}
              </Tabs.Trigger>
            );
          })}
        </Tabs.List>
        <span className="ml-auto text-xs leading-4 font-medium text-warning">답변 대기</span>
      </Tabs.Root>
      <div className="flex flex-col gap-0.5">
        <h2 id={headingId} className="text-sm leading-5 font-semibold text-foreground">
          <InlineCode text={question.question} />
        </h2>
        <p className="text-xs leading-[18px] text-foreground-subtle">
          {question.multiSelect === true ? '여러 개를 고를 수 있습니다.' : '하나를 고릅니다.'}
        </p>
      </div>
      <div
        role={question.multiSelect === true ? 'group' : 'radiogroup'}
        aria-labelledby={headingId}
        className="flex flex-col gap-1.5"
      >
        {question.options.map((option, index) => {
          const isChecked = selected.includes(index);
          const Box = isChecked ? SquareCheck : Square;
          return (
            <button
              key={option}
              type="button"
              role={question.multiSelect === true ? 'checkbox' : 'radio'}
              aria-checked={isChecked}
              onClick={() => {
                togglePick(index);
              }}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors duration-(--duration-fast) ease-(--ease-out) focus-visible:outline-offset-[-2px]',
                isChecked ? 'bg-surface-hover' : 'bg-surface hover:bg-surface-hover',
              )}
            >
              {question.multiSelect === true && (
                <Box
                  aria-hidden
                  className={cn(
                    'size-[18px]',
                    isChecked ? 'text-foreground' : 'text-foreground-subtle',
                  )}
                />
              )}
              {question.multiSelect !== true && (
                <span
                  aria-hidden
                  className="w-[18px] text-center font-mono text-xs leading-4 font-medium text-foreground-subtle"
                >
                  {index + 1}
                </span>
              )}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm leading-5 font-medium text-foreground">
                  <InlineCode text={option} />
                </span>
              </span>
              {question.multiSelect === true && (
                <span
                  aria-hidden
                  className="font-mono text-xs leading-4 font-medium text-foreground-subtle"
                >
                  {index + 1}
                </span>
              )}
            </button>
          );
        })}
        <label className="flex h-10 items-center gap-2.5 rounded-md bg-background px-3">
          <Pencil aria-hidden className="size-3.5 shrink-0 text-foreground-subtle" />
          <input
            value={texts[current] ?? ''}
            onChange={(event) => {
              setTexts((all) =>
                all.map((text, index) => (index === current ? event.target.value : text)),
              );
            }}
            placeholder="직접 입력합니다"
            aria-label="직접 입력"
            className="min-w-0 flex-1 bg-transparent text-[13px] leading-[18px] text-foreground outline-none placeholder:text-foreground-subtle"
          />
        </label>
      </div>
      <div className="flex items-center gap-2">
        <p className="text-xs leading-4 text-foreground-subtle">
          {selected.length}개 골랐습니다
          {question.multiSelect === true ? '. Space로 고르고 Enter로 보냅니다' : ''}
        </p>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            disabled={current === 0}
            onClick={() => {
              setCurrent(current - 1);
            }}
          >
            이전 질문
          </Button>
          <Button variant="primary" onClick={submit}>
            {isLast ? '답 보내기' : '다음 질문'}
            <KeyHint>↵</KeyHint>
          </Button>
        </div>
      </div>
    </section>
  );
}

/** 모델이 질문과 선택지에 `코드` 표기를 섞어 씁니다. 백틱 짝이 맞을 때만 그 구간을 코드 글꼴로 그립니다. */
function InlineCode({ text }: { text: string }) {
  const parts = text.split('`');
  if (parts.length % 2 === 0) return text;
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <code key={index} className="font-mono text-[13px]">
        {part}
      </code>
    ) : (
      part
    ),
  );
}
