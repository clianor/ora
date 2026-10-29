import type { ThreadMessageLike } from '@assistant-ui/react';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/cn.ts';
import { formatElapsed, useNow } from '../lib/now.ts';
import { navigate } from '../lib/route.ts';
import {
  getShortStatusText,
  historyFilters,
  matchesHistoryFilter,
  statusKindOf,
  statusLabel,
  type HistoryFilter,
  type StatusKind,
} from '../lib/status.ts';
import { openSessionTab } from '../lib/tabs.ts';
import { listWorktrees } from '../lib/worktrees.ts';
import { runAction, useStore } from '../store.tsx';
import { Sidebar } from './Sidebar.tsx';
import { StatusIcon } from './StatusIcon.tsx';

const statusColor: Record<StatusKind, string> = {
  '실행 중': 'text-foreground-muted',
  '승인 대기': 'text-warning',
  완료: 'text-success',
  실패: 'text-danger',
  멈춤: 'text-warning',
};

function readMessageText(message: ThreadMessageLike): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map((part) => ('text' in part ? part.text : '')).join(' ');
}

/** 모든 워크트리의 세션을 갱신 순으로 보이는 화면입니다. 줄을 누르면 그 세션을 해당 워크트리의 탭으로 엽니다. */
export function HistoryScreen() {
  const store = useStore();
  const now = useNow();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<HistoryFilter>('전체');

  const needle = query.trim().toLowerCase();
  const rows = [
    ...listWorktrees(store.sidebar.repos).flatMap((ref) =>
      ref.node.sessions.map((session) => ({ ref, session })),
    ),
    ...store.sessionsWithoutFolder.map((session) => ({ ref: undefined, session })),
  ]
    .toSorted((a, b) => b.session.record.updatedAt.localeCompare(a.session.record.updatedAt))
    .filter(({ session }) => matchesHistoryFilter(filter, session.record.status))
    .filter(({ session }) => {
      if (needle === '') return true;
      const body = (store.getSession(session.record.id)?.thread.messages ?? [])
        .map(readMessageText)
        .join(' ');
      return [session.record.title, body, ...session.todoTitles]
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });

  return (
    <>
      <Sidebar data={store.sidebar} isHistorySelected />
      <main className="flex min-w-0 flex-1 flex-col items-center overflow-y-auto">
        <div className="flex w-[676px] max-w-full flex-col gap-4 px-5 pt-8 pb-10">
          <h1 className="text-xl leading-7 font-semibold text-foreground">기록</h1>
          <label className="flex h-10 items-center gap-2 rounded-md border border-border bg-surface px-3">
            <Search aria-hidden className="size-3.5 shrink-0 text-foreground-subtle" />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              placeholder="제목, 본문, 할 일로 찾기"
              aria-label="기록 검색어"
              className="min-w-0 flex-1 bg-transparent text-[13px] leading-[18px] text-foreground outline-none placeholder:text-foreground-subtle"
            />
          </label>
          <div role="group" aria-label="상태 필터" className="flex flex-wrap gap-1">
            {historyFilters.map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={item === filter}
                onClick={() => {
                  setFilter(item);
                }}
                className={cn(
                  'h-7 rounded-sm px-2.5 text-xs leading-4',
                  item === filter
                    ? 'bg-surface-hover font-semibold text-foreground'
                    : 'font-medium text-foreground-subtle hover:bg-surface-hover',
                )}
              >
                {item}
              </button>
            ))}
          </div>
          {rows.length === 0 ? (
            <p role="status" className="px-1 text-[13px] leading-[18px] text-foreground-subtle">
              찾은 세션이 없습니다.
            </p>
          ) : (
            <ul className="flex flex-col">
              {rows.map(({ ref, session }) => (
                <li key={session.record.id}>
                  <button
                    type="button"
                    onClick={() => {
                      if (!ref) {
                        navigate('worktree', { sessionId: session.record.id });
                        return;
                      }
                      runAction(
                        store.actions.loadTabs(ref.cwd).then(() => {
                          openSessionTab(
                            {
                              actions: store.actions,
                              cwd: ref.cwd,
                              tabs: store.getTabs(ref.cwd) ?? { tabs: [] },
                            },
                            session.record.id,
                          );
                        }),
                      );
                    }}
                    className="flex w-full items-center gap-3 rounded-sm px-3 py-2 text-left hover:bg-surface-hover"
                  >
                    <StatusIcon status={session.record.status} className="size-4" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[13px] leading-[18px] font-medium text-foreground">
                        {session.record.title}
                      </span>
                      <span className="truncate font-mono text-xs leading-4 text-foreground-subtle">
                        {ref ? `${ref.repo.name} · ${ref.node.name}` : '작업 폴더 없음'}
                      </span>
                    </span>
                    <span
                      title={statusLabel[session.record.status]}
                      className={cn(
                        'w-24 shrink-0 text-xs leading-4 whitespace-nowrap',
                        statusColor[statusKindOf[session.record.status]],
                      )}
                    >
                      {getShortStatusText(session.record.status, session.record.endReason)}
                    </span>
                    <span className="w-14 shrink-0 text-xs leading-4 text-foreground-subtle">
                      {formatElapsed(session.record.updatedAt, now)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </>
  );
}
