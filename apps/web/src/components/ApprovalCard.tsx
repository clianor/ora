import type { ApprovalDecision, ApprovalRequest, RiskLevel } from '@ora/protocol';
import { Pencil, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Button, KeyHint } from '../ui/button.tsx';

const riskLabel: Record<RiskLevel, string> = {
  low: '위험도 낮음',
  medium: '위험도 보통',
  high: '위험도 높음',
};

const titles = {
  shell: '이 명령을 실행할까요?',
  file: '이 파일을 쓸까요?',
  arguments: '이 도구 호출을 실행할까요?',
} as const;

interface ApprovalCardProps {
  request: ApprovalRequest;
  onDecide: (decision: ApprovalDecision) => void;
}

/** 실행 전 승인 카드입니다. 셸 명령은 연필 아이콘으로 고쳐서 실행할 수 있고, 엔진은 원본과 고친 명령을 함께 기록합니다(SPEC 5.1절). */
export function ApprovalCard({ request, onDecide }: ApprovalCardProps) {
  const { detail } = request;
  const original = detail.kind === 'shell' ? detail.command : '';
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(original);

  const approve = (scope: 'once' | 'session' | 'always', editedCommand?: string) => {
    onDecide({ outcome: 'approved', scope, ...(editedCommand ? { editedCommand } : {}) });
  };

  return (
    <section aria-label="실행 승인" className="flex flex-col gap-3 rounded-lg bg-surface p-4">
      <div className="flex items-center gap-2">
        <ShieldCheck aria-hidden className="size-4 text-warning" />
        <h2 className="text-sm leading-5 font-semibold text-foreground">{titles[detail.kind]}</h2>
        {detail.kind === 'shell' && (
          <span className="ml-auto text-xs leading-4 font-medium text-warning">
            {riskLabel[detail.risk]}
          </span>
        )}
      </div>
      <div
        className={
          isEditing
            ? 'flex items-start gap-2 rounded-md bg-background px-3 py-2.5 outline-2 -outline-offset-2 outline-ring'
            : 'flex items-start gap-2 rounded-md bg-background px-3 py-2.5'
        }
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {detail.kind === 'shell' &&
            (isEditing ? (
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
              <p className="font-mono text-[13px] leading-5 break-all text-foreground">
                $ {detail.command}
              </p>
            ))}
          {detail.kind === 'shell' && (
            <p className="font-mono text-xs leading-[18px] break-all text-foreground-subtle">
              {isEditing ? `원본: ${detail.command}` : `cwd ${detail.cwd}`}
            </p>
          )}
          {detail.kind === 'file' && (
            <>
              <p className="font-mono text-[13px] leading-5 break-all text-foreground">
                {detail.path}
              </p>
              <pre className="max-h-40 overflow-auto font-mono text-xs leading-[18px] whitespace-pre-wrap text-foreground-subtle">
                {detail.content}
              </pre>
            </>
          )}
          {detail.kind === 'arguments' && (
            <>
              <p className="font-mono text-[13px] leading-5 text-foreground">{request.tool}</p>
              <pre className="max-h-40 overflow-auto font-mono text-xs leading-[18px] whitespace-pre-wrap text-foreground-subtle">
                {JSON.stringify(detail.args, null, 2)}
              </pre>
            </>
          )}
        </div>
        {detail.kind === 'shell' && !isEditing && (
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
      {request.reason !== '' && (
        <p className="text-xs leading-[18px] text-foreground-subtle">
          {request.todo ? `${request.todo.id} ${request.todo.content}: ` : ''}
          {request.reason}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {isEditing ? (
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setIsEditing(false);
                setDraft(original);
              }}
            >
              취소
            </Button>
            <Button
              variant="primary"
              disabled={draft.trim() === ''}
              onClick={() => {
                approve('once', draft === original ? undefined : draft);
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
                onDecide({ outcome: 'denied' });
              }}
            >
              거부
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                approve('always');
              }}
            >
              항상 허용
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                approve('session');
              }}
            >
              이 세션 동안 허용
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                approve('once');
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
