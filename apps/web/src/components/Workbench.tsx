import { Gauge, X } from 'lucide-react';
import { useEffect } from 'react';
import { getStageIndex, stageLabels, stages } from '../events.ts';
import { formatCostRatio, getCostView } from '../lib/cost.ts';
import { runningStatuses } from '../lib/status.ts';
import type { SessionView, StatusItem } from '../model.ts';
import { runAction, useStore } from '../store.tsx';
import { ApprovalCard } from './ApprovalCard.tsx';
import {
  ChatProvider,
  Composer,
  DraftSync,
  StatusLine,
  SteerRestore,
  ThreadView,
} from './Chat.tsx';
import { CostStopCard } from './CostStopCard.tsx';
import { CrashedNotice } from './CrashedNotice.tsx';
import { QuestionCard } from './QuestionCard.tsx';
import { scrollIfRequested } from '../lib/notify.ts';
import { ModelSwitchToast } from './ModelSwitchToast.tsx';
import { findWorktreeOfSession } from '../lib/worktrees.ts';
import { OverwriteNotice } from './OverwriteNotice.tsx';

const timeFormat = new Intl.DateTimeFormat('ko-KR', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Asia/Seoul',
});

interface WorkbenchProps {
  view: SessionView;
  /** 같은 워크트리에서 실행 중인 세션 수입니다. 2개 이상이면 입력창 위에 덮어쓰기 경고를 보입니다. */
  sameFolderRunningCount: number;
  /** 이 탭의 ID입니다. 보내지 않은 입력창 글을 이 키로 보관합니다. */
  draftKey: string;
}

/** 세션 탭의 내용입니다. 가운데 대화와 오른쪽 할 일 패널의 두 열입니다. */
export function Workbench({ view, sameFolderRunningCount, draftKey }: WorkbenchProps) {
  const store = useStore();
  const { actions, watchSession } = store;
  const { record, thread } = view;
  const sessionId = record.id;
  const repoPath = findWorktreeOfSession(store.sidebar.repos, sessionId)?.repo.path;

  /** 세션의 실시간 이벤트(SSE)는 브라우저 밖 서버 연결이라 화면에 보이는 동안만 구독합니다. */
  useEffect(() => watchSession(sessionId), [watchSession, sessionId]);

  const isRunning = runningStatuses.has(record.status);
  const isStopping = view.isStopping;

  /** Esc는 포커스 위치와 상관없이 세션 화면 어디서나 중지로 동작해야 해서 window 이벤트를 구독합니다. */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !isRunning) return;
      // 명령 팔레트 같은 대화상자가 열려 있으면 Esc는 그 대화상자를 닫는 데 씁니다.
      if (document.querySelector('[role="dialog"]')) return;
      // 카드 안의 입력(직접 입력, 명령 편집)을 고치는 중이면 Esc를 가로채지 않습니다.
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('section') && target.matches('input, textarea')) return;
      event.preventDefault();
      runAction(actions.cancelRun(sessionId, isStopping ? 'hard' : 'soft'));
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [actions, sessionId, isRunning, isStopping]);

  const isCrashed = record.status === 'crashed';
  const resumeTodo = view.todos.find((todo) => todo.status === 'interrupted');
  const lastVerified = view.todos.findLast((todo) => todo.status === 'verified');
  // 컨텍스트 창을 넘어 멈췄을 때는 별도 카드 없이 기존 오류 줄에 session_end의 요약 문구를 보여 줍니다.
  const lastEnd = view.events.findLast((event) => event.type === 'session_end');
  const overflowText =
    !isRunning && lastEnd?.payload.endReason === 'context_overflow'
      ? lastEnd.payload.summary
      : null;
  const errorText = view.error ?? overflowText;
  const approval = view.approvals[0];
  const question = view.questions[0];
  const cost = getCostView(view.events, record.status);
  const stageIndex = getStageIndex(view.events);
  const isDone = record.status === 'completed' || record.status === 'archived';
  const costText =
    cost.ratioPct === undefined ? undefined : `비용 상한 ${formatCostRatio(cost.ratioPct)}`;
  const statusItems: StatusItem[] = [
    ...(stageIndex === null ? [] : [`단계 ${stageLabels[stages[stageIndex] ?? 'understand']}`]),
    ...(cost.stop ? [{ text: '멈춤 · 비용 상한', isWarning: true as const }] : []),
    ...view.statusLine,
    ...(costText === undefined
      ? []
      : [cost.isWarned || cost.stop ? { text: costText, isWarning: true as const } : costText]),
  ];
  const remainingTodos = view.todos.filter(
    (todo) => todo.status !== 'verified' && todo.status !== 'abandoned',
  ).length;

  return (
    <>
      <main className="relative flex min-w-0 flex-1 flex-col">
        <ModelSwitchToast events={view.events} />
        <ChatProvider
          messages={thread.messages}
          onSend={(text) => actions.sendMessage(sessionId, text)}
        >
          <SteerRestore failure={view.steerFailure} />
          <DraftSync draftKey={draftKey} />
          <ThreadView>
            {approval && (
              <div key={approval.requestId} ref={scrollIfRequested}>
                <ApprovalCard
                  request={approval.request}
                  onDecide={(decision) => {
                    runAction(actions.decideApproval(sessionId, approval.requestId, decision));
                  }}
                />
              </div>
            )}
            {question && (
              <QuestionCard
                key={question.requestId}
                request={question.request}
                draft={view.questionDraft}
                onAnswer={(answers) => {
                  runAction(actions.answerQuestions(sessionId, question.requestId, answers));
                }}
              />
            )}
            {isCrashed && thread.lastEventAt && (
              <CrashedNotice
                sessionId={sessionId}
                stoppedAt={timeFormat.format(new Date(thread.lastEventAt))}
                abortedCalls={thread.abortedCalls}
                resumeTodo={resumeTodo ? { id: resumeTodo.id, title: resumeTodo.content } : null}
                lastVerifiedId={lastVerified?.id ?? null}
              />
            )}
            {cost.stop && (
              <CostStopCard
                stop={cost.stop}
                {...(cost.ratioPct === undefined ? {} : { ratioPct: cost.ratioPct })}
                remainingTodos={remainingTodos}
              />
            )}
          </ThreadView>
          <div className="flex flex-col items-center pb-3">
            {errorText && (
              <div
                role="alert"
                className="mb-2 flex w-[720px] max-w-[calc(100%-var(--s-6)*2)] items-start gap-2 rounded-md bg-danger-subtle px-3 py-2 text-xs leading-[18px] text-danger"
              >
                <p className="flex-1">{errorText}</p>
                {view.error && (
                  <button
                    type="button"
                    aria-label="오류 닫기"
                    onClick={() => {
                      actions.dismissError(sessionId);
                    }}
                  >
                    <X aria-hidden className="size-3.5" />
                  </button>
                )}
              </div>
            )}
            {isRunning && sameFolderRunningCount >= 2 && (
              <OverwriteNotice count={sameFolderRunningCount} repo={repoPath} />
            )}
            {cost.isWarned && !cost.stop && cost.ratioPct !== undefined && !isDone && (
              <p className="mb-2 flex w-[720px] max-w-[calc(100%-var(--s-6)*2)] items-center gap-2 px-3.5 text-xs leading-4 text-foreground-muted">
                <Gauge aria-hidden className="size-3.5 text-warning" />
                비용 상한의 {formatCostRatio(cost.ratioPct)}를 썼습니다 · 상한에 닿으면 다음 요청을
                보내지 않고 멈춥니다
              </p>
            )}
            <Composer
              isRunning={isRunning}
              isStopping={view.isStopping}
              placeholder={
                view.placeholder ??
                (cost.stop ? '지시를 바꿔 보내면 멈춘 곳에서 이어 갑니다' : undefined)
              }
              chips={view.chips}
              onStop={() => {
                runAction(actions.cancelRun(sessionId, view.isStopping ? 'hard' : 'soft'));
              }}
            />
            <StatusLine items={statusItems} context={view.context} cache={view.cache} />
          </div>
        </ChatProvider>
      </main>
    </>
  );
}
