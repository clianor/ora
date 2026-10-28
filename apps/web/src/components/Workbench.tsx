import { useState } from 'react';
import { buildThread, getStageIndex } from '../events.ts';
import type { SessionView, SidebarData } from '../model.ts';
import { ApprovalCard } from './ApprovalCard.tsx';
import { ChatProvider, Composer, StatusLine, ThreadView } from './Chat.tsx';
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

interface WorkbenchProps {
  sidebar: SidebarData;
  view: SessionView;
}

/** 세션 화면입니다. 왼쪽 사이드바, 가운데 대화, 오른쪽 할 일 패널의 세 열입니다. */
export function Workbench({ sidebar, view }: WorkbenchProps) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const { record } = view;
  const thread = buildThread(view.events, view.approval?.callId);
  const isCrashed = record.status === 'crashed';
  const isRunning = record.status === 'running' || record.status === 'awaiting_approval';

  const resumeTodo = view.todos.find((todo) => todo.status === 'interrupted');
  const lastVerified = view.todos.findLast((todo) => todo.status === 'verified');
  const approvalCall = thread.pendingCommand;

  return (
    <>
      {isSidebarOpen && (
        <Sidebar
          data={sidebar}
          selectedSessionId={record.id}
          initialQuery={view.initialSearch?.query}
        />
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        <Header
          title={record.title}
          repoLabel={view.repoLabel}
          stageIndex={getStageIndex(view.events)}
          diff={view.diff}
          isCrashed={isCrashed}
          onToggleSidebar={() => {
            setIsSidebarOpen(!isSidebarOpen);
          }}
        />
        <ChatProvider messages={thread.messages}>
          <ThreadView>
            {approvalCall && view.approval && (
              <ApprovalCard command={approvalCall} approval={view.approval} />
            )}
            {thread.pendingQuestions && (
              <QuestionCard
                callId={
                  view.events.findLast((event) => event.type === 'tool_call')?.payload.callId ?? ''
                }
                questions={thread.pendingQuestions}
                draft={view.questionDraft}
              />
            )}
            {isCrashed && thread.lastEventAt && (
              <CrashedNotice
                sessionId={record.id}
                stoppedAt={timeFormat.format(new Date(thread.lastEventAt))}
                abortedCalls={thread.abortedCalls}
                resumeTodo={resumeTodo ? { id: resumeTodo.id, title: resumeTodo.content } : null}
                lastVerifiedId={lastVerified?.id ?? null}
              />
            )}
          </ThreadView>
          <div className="flex flex-col items-center pb-3">
            <Composer isRunning={isRunning} placeholder={view.placeholder} />
            <StatusLine items={view.statusLine} />
          </div>
        </ChatProvider>
      </main>
      <TodoPanel todos={view.todos} isAwaitingApproval={record.status === 'awaiting_approval'} />
    </>
  );
}
