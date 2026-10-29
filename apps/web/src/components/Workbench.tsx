import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getStageIndex } from '../events.ts';
import type { SessionView, SidebarData } from '../model.ts';
import { runAction, useStore } from '../store.tsx';
import { ApprovalCard } from './ApprovalCard.tsx';
import { ChatProvider, Composer, StatusLine, SteerRestore, ThreadView } from './Chat.tsx';
import { CrashedNotice } from './CrashedNotice.tsx';
import { Header } from './Header.tsx';
import { QuestionCard } from './QuestionCard.tsx';
import { Sidebar } from './Sidebar.tsx';
import { TodoPanel } from './TodoPanel.tsx';

const timeFormat = new Intl.DateTimeFormat('ko-KR', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Asia/Seoul',
});

const runningStatuses = new Set(['created', 'running', 'awaiting_approval', 'awaiting_user']);

interface WorkbenchProps {
  sidebar: SidebarData;
  view: SessionView;
}

/** 세션 화면입니다. 왼쪽 사이드바, 가운데 대화, 오른쪽 할 일 패널의 세 열입니다. */
export function Workbench({ sidebar, view }: WorkbenchProps) {
  const store = useStore();
  const { actions, watchSession } = store;
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const { record, thread } = view;
  const sessionId = record.id;

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

  return (
    <>
      {isSidebarOpen && (
        <Sidebar
          data={sidebar}
          selectedSessionId={sessionId}
          initialQuery={view.initialSearch?.query}
        />
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        <Header
          title={record.title}
          repoLabel={view.repoLabel}
          repoTitle={view.repoTitle}
          stageIndex={getStageIndex(view.events)}
          diff={view.diff}
          isCrashed={isCrashed}
          onToggleSidebar={() => {
            setIsSidebarOpen(!isSidebarOpen);
          }}
        />
        <ChatProvider
          messages={thread.messages}
          onSend={(text) => actions.sendMessage(sessionId, text)}
        >
          <SteerRestore failure={view.steerFailure} />
          <ThreadView>
            {approval && (
              <ApprovalCard
                key={approval.requestId}
                request={approval.request}
                onDecide={(decision) => {
                  runAction(actions.decideApproval(sessionId, approval.requestId, decision));
                }}
              />
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
          </ThreadView>
          <div className="flex flex-col items-center pb-3">
            {errorText && (
              <div
                role="alert"
                className="mb-2 flex w-[720px] max-w-full items-start gap-2 rounded-md bg-danger-subtle px-3 py-2 text-xs leading-[18px] text-danger"
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
            <Composer
              isRunning={isRunning}
              isStopping={view.isStopping}
              placeholder={view.placeholder}
              chips={view.chips}
              onStop={() => {
                runAction(actions.cancelRun(sessionId, view.isStopping ? 'hard' : 'soft'));
              }}
            />
            <StatusLine items={view.statusLine} context={view.context} cache={view.cache} />
          </div>
        </ChatProvider>
      </main>
      <TodoPanel key={sessionId} record={record} events={view.events} todos={view.todos} />
    </>
  );
}
