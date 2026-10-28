import { Pencil, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { runAction, useActions } from '../store.tsx';
import type { PendingCommand } from '../events.ts';
import type { PendingApproval } from '../model.ts';
import { Button, KeyHint } from '../ui/button.tsx';

interface ApprovalCardProps {
  command: PendingCommand;
  approval: PendingApproval;
}

/** 실행 전 승인 카드입니다. 연필 아이콘으로 명령을 고치면 원본과 고친 명령을 함께 엔진에 보냅니다(SPEC 5.1절). */
export function ApprovalCard({ command, approval }: ApprovalCardProps) {
  const actions = useActions();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(command.command);

  const decide = (
    decision: 'approved' | 'denied',
    options?: { scope?: 'once' | 'session'; editedCommand?: string },
  ) => {
    runAction(actions.decideApproval(command.callId, decision, options));
  };

  return (
    <section aria-label="명령 승인" className="flex flex-col gap-3 rounded-lg bg-surface p-4">
      <div className="flex items-center gap-2">
        <ShieldCheck aria-hidden className="size-4 text-warning" />
        <h2 className="text-sm leading-5 font-semibold text-foreground">이 명령을 실행할까요?</h2>
        <span className="ml-auto text-xs leading-4 font-medium text-warning">{approval.risk}</span>
      </div>
      <div
        className={
          isEditing
            ? 'flex items-start gap-2 rounded-md bg-background px-3 py-2.5 outline-2 -outline-offset-2 outline-ring'
            : 'flex items-start gap-2 rounded-md bg-background px-3 py-2.5'
        }
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {isEditing ? (
            <div className="flex gap-2 font-mono text-[13px] leading-5 text-foreground">
              <span aria-hidden>$</span>
              <input
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                }}
                aria-label="실행할 명령"
                className="min-w-0 flex-1 bg-transparent outline-none"
              />
            </div>
          ) : (
            <p className="font-mono text-[13px] leading-5 text-foreground">$ {command.command}</p>
          )}
          <p className="font-mono text-xs leading-[18px] text-foreground-subtle">
            {isEditing ? `원본: ${command.command}` : `cwd ${command.cwd}`}
          </p>
        </div>
        {!isEditing && (
          <button
            type="button"
            aria-label="명령 편집"
            onClick={() => {
              setIsEditing(true);
            }}
            className="rounded-sm p-0.5 text-foreground-subtle transition-colors duration-(--duration-fast) ease-(--ease-out) hover:text-foreground"
          >
            <Pencil aria-hidden className="size-3.5" />
          </button>
        )}
      </div>
      <p className="text-xs leading-[18px] text-foreground-subtle">{approval.explanation}</p>
      <div className="flex items-center justify-end gap-2">
        {isEditing ? (
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setIsEditing(false);
                setDraft(command.command);
              }}
            >
              취소
            </Button>
            <Button
              variant="primary"
              disabled={draft.trim() === ''}
              onClick={() => {
                decide('approved', { scope: 'once', editedCommand: draft });
              }}
            >
              고친 명령으로 실행
              <KeyHint>↵</KeyHint>
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              onClick={() => {
                decide('denied');
              }}
            >
              거부
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                decide('approved', { scope: 'session' });
              }}
            >
              이 세션 동안 허용
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                decide('approved', { scope: 'once' });
              }}
            >
              실행
              <KeyHint>↵</KeyHint>
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
