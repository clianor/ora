import { Gauge, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
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
import { MemoryFeedback } from './MemoryFeedback.tsx';
import { QuestionCard } from './QuestionCard.tsx';
import { scrollIfRequested } from '../lib/notify.ts';
import { ModelSwitchToast } from './ModelSwitchToast.tsx';
import { findWorktreeOfSession } from '../lib/worktrees.ts';
import { OverwriteNotice } from './OverwriteNotice.tsx';
import { LastRewindButton, RewindProvider, UndoNotice } from './Rewind.tsx';
import { BriefBox, ChildBanner, ChildNote } from './ChildSession.tsx';

const timeFormat = new Intl.DateTimeFormat('ko-KR', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Asia/Seoul',
});

/** 처음 그리는 대화 조각 수입니다. 스크롤로 창 끝에 닿을 때마다 같은 수만큼 이어 그립니다. */
const initialShownMessages = 10;

/** 한꺼번에 그려 두는 대화 조각 수의 상한입니다. 이 값이면 한 번 이어 그리는 시간이 최대 약 120ms였습니다(10만 줄 세션 실측). */
const maxWindowMessages = 60;

/** 그리지 않은 조각 하나가 차지하는 높이로 어림하는 값(px)입니다. 조각 20개 파트 기준 실측 약 840px입니다. */
const estimatedMessagePx = 840;

/** 그린 조각의 위·아래 끝이 화면 경계에서 이 값(px) 안이면 다음 조각을 이어 그립니다. */
const loadMoreThresholdPx = 400;

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
  const isChild = record.delegatedBy !== undefined;
  const briefMessage =
    isChild && thread.messages[0]?.role === 'user' ? thread.messages[0] : undefined;
  const threadMessages = briefMessage === undefined ? thread.messages : thread.messages.slice(1);
  let briefText: string | undefined;
  if (briefMessage !== undefined) {
    const { content } = briefMessage;
    briefText =
      typeof content === 'string'
        ? content
        : content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
  }
  const isRangePending = useRef(false);
  const [range, setRange] = useState<{ start: number; end: number | null }>({
    start: -1,
    end: null,
  });
  const [firstMessage, ...laterMessages] = threadMessages;
  const total = laterMessages.length;
  const effectiveEnd = Math.min(range.end ?? total, total);
  let effectiveStart = Math.min(range.start, effectiveEnd);
  if (range.start < 0) effectiveStart = Math.max(0, effectiveEnd - initialShownMessages);
  else if (range.end === null) {
    effectiveStart = Math.max(range.start, effectiveEnd - maxWindowMessages);
  }
  const shownMessages =
    firstMessage === undefined
      ? threadMessages
      : [firstMessage, ...laterMessages.slice(effectiveStart, effectiveEnd)];
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
        {isChild && <ChildBanner record={record} isRunning={isRunning} />}
        <ModelSwitchToast events={view.events} />
        <ChatProvider
          messages={shownMessages}
          onSend={(text) => actions.sendMessage(sessionId, text)}
        >
          <RewindProvider sessionId={sessionId} isRunning={isRunning}>
            <SteerRestore failure={view.steerFailure} />
            <DraftSync draftKey={draftKey} />
            <ThreadView
              header={briefText === undefined ? undefined : <BriefBox text={briefText} />}
              topSpacerPx={effectiveStart * estimatedMessagePx}
              bottomSpacerPx={(total - effectiveEnd) * estimatedMessagePx}
              onScroll={(event) => {
                const viewport = event.currentTarget;
                const next = getNextRange(viewport, {
                  start: effectiveStart,
                  end: effectiveEnd,
                  total,
                });
                if (next === undefined || isRangePending.current) return;
                // 스크롤 이벤트 안에서 바로 그리면 읽던 위치가 어긋났습니다(위로 400번 이어 그릴 때 최대 약 5만 px 실측). 그래서 다음 프레임에 그립니다.
                isRangePending.current = true;
                requestAnimationFrame(() => {
                  flushSync(() => {
                    setRange(next);
                  });
                  requestAnimationFrame(() => {
                    isRangePending.current = false;
                  });
                });
              }}
            >
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
              {isDone &&
                view.events.some(
                  (event) => event.type === 'recall' && event.payload.lessonIds.length > 0,
                ) && <MemoryFeedback sessionId={sessionId} />}
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
                  비용 상한의 {formatCostRatio(cost.ratioPct)}를 썼습니다 · 상한에 닿으면 다음
                  요청을 보내지 않고 멈춥니다
                </p>
              )}
              {!isRunning && <UndoNotice sessionId={sessionId} events={view.events} />}
              {isChild ? (
                <ChildNote />
              ) : (
                <>
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
                  <StatusLine
                    items={statusItems}
                    context={view.context}
                    cache={view.cache}
                    trailing={<LastRewindButton lastSeq={thread.lastUserSeq} />}
                  />
                </>
              )}
            </div>
          </RewindProvider>
        </ChatProvider>
      </main>
    </>
  );
}

/** 위로 올라가며 이어 그리는 창에서 뒤쪽 조각은 버려 DOM과 위젯 수가 넘치지 않게 합니다. */
function getNextRange(
  viewport: HTMLElement,
  range: { start: number; end: number; total: number },
): { start: number; end: number | null } | undefined {
  const { start, end, total } = range;
  const viewportRect = viewport.getBoundingClientRect();
  const topSpacer = viewport.querySelector('[data-window-spacer="top"]');
  const bottomSpacer = viewport.querySelector('[data-window-spacer="bottom"]');
  let next: { start: number; end: number } | undefined;
  if (start > 0 && topSpacer !== null) {
    // 그린 조각의 맨 위가 화면 위쪽 경계에서 이 값 안이면 앞쪽을 더 그립니다. 스페이서 안이면 그 위치의 조각으로 건너뜁니다.
    const gap = topSpacer.getBoundingClientRect().bottom - viewportRect.top;
    if (gap >= -loadMoreThresholdPx) {
      const inside =
        gap > 0 ? Math.floor((start * estimatedMessagePx - gap) / estimatedMessagePx) : start;
      const newStart = Math.max(0, Math.min(start, inside) - initialShownMessages);
      next = { start: newStart, end: Math.min(end, newStart + maxWindowMessages) };
    }
  }
  if (next === undefined && end < total && bottomSpacer !== null) {
    const gap = viewportRect.bottom - bottomSpacer.getBoundingClientRect().top;
    if (gap >= -loadMoreThresholdPx) {
      const inside = gap > 0 ? end + Math.floor(gap / estimatedMessagePx) : end;
      const newEnd = Math.min(total, Math.max(end, inside) + initialShownMessages);
      next = { start: Math.max(start, newEnd - maxWindowMessages), end: newEnd };
    }
  }
  if (next === undefined) return undefined;
  return { start: next.start, end: next.end >= total ? null : next.end };
}
