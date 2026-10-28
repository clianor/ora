import { RotateCcw, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { runAction, useActions } from '../store.tsx';
import { Button } from '../ui/button.tsx';

interface CrashedNoticeProps {
  sessionId: string;
  stoppedAt: string;
  abortedCalls: number;
  resumeTodo: { id: string; title: string } | null;
  lastVerifiedId: string | null;
}

/** 하드 킬이나 프로세스 사망 뒤 세션을 열면 대화 끝에 놓는 안내입니다. */
export function CrashedNotice({
  sessionId,
  stoppedAt,
  abortedCalls,
  resumeTodo,
  lastVerifiedId,
}: CrashedNoticeProps) {
  const actions = useActions();
  const [isDismissed, setIsDismissed] = useState(false);
  if (isDismissed) return null;
  return (
    <section aria-label="멈춤 안내" className="flex flex-col gap-3 rounded-lg bg-surface p-4">
      <div className="flex items-center gap-2">
        <TriangleAlert aria-hidden className="size-4 text-warning" />
        <h2 className="text-sm leading-5 font-semibold text-foreground">
          작업이 중간에 멈췄습니다
        </h2>
        <span className="ml-auto text-xs leading-4 text-foreground-subtle">{stoppedAt}</span>
      </div>
      <p className="text-[13px] leading-5 text-foreground-muted">
        실행 중이던 도구 호출 {abortedCalls}개를 aborted로 기록했습니다. 작업 폴더의 변경은 그대로
        있습니다.
      </p>
      {resumeTodo && (
        <div className="flex flex-col gap-1 rounded-md bg-background px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-xs leading-4 font-medium text-foreground-subtle">재개 지점</span>
            <span className="text-[13px] leading-[18px] font-medium text-foreground">
              {resumeTodo.id} {resumeTodo.title}
            </span>
          </div>
          <p className="text-xs leading-4 text-foreground-subtle">
            {lastVerifiedId
              ? `마지막 검증 증거가 있는 ${lastVerifiedId} 다음부터 다시 실행합니다.`
              : '처음부터 다시 실행합니다.'}
          </p>
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => {
            setIsDismissed(true);
          }}
        >
          기록만 보기
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            runAction(actions.resumeSession(sessionId));
          }}
        >
          <RotateCcw aria-hidden className="size-3.5" />
          {resumeTodo ? `${resumeTodo.id}부터 재개` : '재개'}
        </Button>
      </div>
    </section>
  );
}
