import {
  ArrowUpRight,
  Bot,
  CircleCheck,
  CirclePause,
  CircleX,
  GitFork,
  Hammer,
  ListChecks,
  Loader,
  ScanEye,
  ShieldAlert,
  Square,
  Telescope,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
import type { TodoStatus } from '@ora/protocol';
import type { DelegateItem, ReverifyData } from '../events.ts';
import { cn } from '../lib/cn.ts';
import { useNow } from '../lib/now.ts';
import { hashFor } from '../lib/route.ts';
import { runAction, useStore } from '../store.tsx';
import { Button } from '../ui/button.tsx';

const agentIcons: Record<string, LucideIcon> = {
  scout: Telescope,
  task: Hammer,
  reviewer: ScanEye,
};

type RowState = DelegateItem['state'] | 'approval';

/** 상태마다 아이콘 모양과 글자가 달라 색 없이도 구분합니다. */
const stateViews: Record<RowState, { Icon: LucideIcon; label: string; color: string }> = {
  running: { Icon: Loader, label: '실행 중', color: 'text-foreground-muted' },
  approval: { Icon: ShieldAlert, label: '승인 대기', color: 'text-warning' },
  done: { Icon: CircleCheck, label: '끝남', color: 'text-success' },
  stopped: { Icon: CirclePause, label: '중지됨', color: 'text-foreground-muted' },
  failed: { Icon: CircleX, label: '실패', color: 'text-danger' },
  rejected: { Icon: CircleX, label: '시작하지 못함', color: 'text-danger' },
};

const todoStatusLabels: Partial<Record<TodoStatus, string>> = {
  pending: '대기',
  attempted: '시도함',
  claimed_verified: '검증 주장',
  verified: '검증됨',
  failed: '실패',
  interrupted: '중단됨',
  blocked: '막힘',
  abandoned: '포기함',
};

function formatDuration(startedAt: string, endMs: number): string {
  const seconds = Math.max(0, Math.floor((endMs - Date.parse(startedAt)) / 1000));
  if (seconds < 60) return `${String(seconds)}초`;
  const minutes = Math.floor(seconds / 60);
  return seconds < 600 && seconds % 60 > 0
    ? `${String(minutes)}분 ${String(seconds % 60)}초`
    : `${String(minutes)}분`;
}

function DelegateRow({ item, now }: { item: DelegateItem; now: number }) {
  const { getSession, getSteps, actions } = useStore();
  const isWaiting =
    item.childSessionId !== undefined &&
    (getSession(item.sessionId)?.approvals.some(
      (approval) => approval.request.from?.sessionId === item.childSessionId,
    ) ??
      false);
  const state: RowState = item.state === 'running' && isWaiting ? 'approval' : item.state;
  const { Icon: StateIcon, label, color } = stateViews[state];
  const AgentIcon = agentIcons[item.agent] ?? Bot;
  const isLive = state === 'running' || state === 'approval';
  const endMs = item.endedAt === undefined ? now : Date.parse(item.endedAt);
  let scope = `쓰기 ${item.writeScope.join(', ')}`;
  if (item.writeScope.length === 0) scope = '읽기 전용';
  else if (item.state === 'done' && item.changedFiles !== undefined) {
    scope = `파일 ${String(item.changedFiles.length)}개 · +${String(item.added ?? 0)} −${String(item.deleted ?? 0)}`;
  }
  /** 실행 중에는 세션 목록이 알려 준 스텝 수를, 끝난 뒤에는 위임이 남긴 스텝 수를 보입니다. */
  const liveSteps = item.childSessionId === undefined ? undefined : getSteps(item.childSessionId);
  let stepText = '';
  if (item.steps !== undefined) stepText = `스텝 ${String(item.steps)}`;
  else if (liveSteps !== undefined && item.maxSteps !== undefined) {
    stepText = `스텝 ${String(liveSteps)}/${String(item.maxSteps)}`;
  }
  return (
    <li className="flex items-center gap-3 px-3.5 py-[11px]">
      <span className="flex h-6 w-[88px] shrink-0 items-center gap-1.5 rounded-sm bg-surface-hover px-2">
        <AgentIcon aria-hidden className="size-[13px] shrink-0 text-foreground-muted" />
        <span className="truncate font-mono text-xs leading-4 font-semibold text-foreground">
          {item.agent}
        </span>
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="truncate text-[13px] leading-[19px] font-medium text-foreground">
          {item.intent}
        </span>
        <span className="truncate font-mono text-xs leading-4 text-foreground-subtle">
          {item.state === 'rejected' ? (item.reason ?? '') : scope}
        </span>
      </div>
      <div className="flex w-[150px] shrink-0 flex-col items-end gap-0.5">
        <span className={cn('flex items-center gap-[5px] text-xs leading-4 font-medium', color)}>
          <StateIcon
            aria-hidden
            className={cn('size-[13px]', state === 'running' && 'motion-safe:animate-spin')}
          />
          {label}
        </span>
        {item.state !== 'rejected' && (
          <span className="text-xs leading-4 text-foreground-subtle">
            {[formatDuration(item.startedAt, endMs), stepText].filter(Boolean).join(' · ')}
          </span>
        )}
      </div>
      {isLive && item.childSessionId !== undefined && (
        <Button
          variant="ghost"
          aria-label={`${item.agent} 하위 세션 중지`}
          onClick={() => {
            if (item.childSessionId !== undefined) {
              runAction(actions.cancelRun(item.childSessionId, 'soft'));
            }
          }}
        >
          <Square aria-hidden className="size-3" />
          중지
        </Button>
      )}
      {item.childSessionId !== undefined && (
        <a
          href={hashFor('worktree', { sessionId: item.childSessionId })}
          aria-label={`${item.agent} 하위 세션 열기`}
          className="inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-sm bg-surface-hover px-3 text-[13px] leading-[18px] font-medium text-foreground transition-colors duration-(--duration-fast) ease-(--ease-out) hover:bg-surface"
        >
          <ArrowUpRight aria-hidden className="size-3.5" />
          열기
        </a>
      )}
    </li>
  );
}

/** 부모 대화의 위임 카드입니다. 한 응답에서 부른 하위 세션을 한 카드에 모으고, 줄마다 상태와 열기·중지 단추를 둡니다. */
export function DelegateCard({ data }: { data: unknown }) {
  const { items } = data as { items: DelegateItem[] };
  const now = useNow();
  const { getSession } = useStore();
  const waiting = (item: DelegateItem) =>
    item.state === 'running' &&
    (getSession(item.sessionId)?.approvals.some(
      (approval) => approval.request.from?.sessionId === item.childSessionId,
    ) ??
      false);
  const waitingCount = items.filter(waiting).length;
  const runningCount = items.filter((item) => item.state === 'running').length - waitingCount;
  const parts = [
    ...(waitingCount > 0 ? [`${String(waitingCount)}개 승인 대기`] : []),
    ...(runningCount > 0 ? [`${String(runningCount)}개 실행 중`] : []),
  ];
  const summary = parts.length > 0 ? parts.join(' · ') : '모두 끝남';
  return (
    <section className="flex flex-col divide-y divide-border rounded-[10px] border border-border bg-surface">
      <h2 className="flex h-[38px] items-center gap-2 px-3.5 text-[13px] leading-[18px] font-semibold text-foreground">
        <GitFork aria-hidden className="size-3.5 text-foreground-muted" />
        하위 세션 {items.length}개 · {summary}
      </h2>
      <ul className="flex flex-col divide-y divide-border">
        {items.map((item) => (
          <DelegateRow key={item.callId} item={item} now={now} />
        ))}
      </ul>
    </section>
  );
}

/** 위임이 끝난 뒤 부모가 같은 검증 명령을 다시 돌린 결과와, 그 결과로 바뀐 todo 상태를 두 줄로 보입니다. */
export function ReverifyNote({ data }: { data: unknown }) {
  const { command, exitCode, todoContent, from, to } = data as ReverifyData;
  const change = [from, to].flatMap((status) =>
    status === undefined ? [] : [todoStatusLabels[status] ?? status],
  );
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex h-7 items-center gap-2">
        <Terminal aria-hidden className="size-[15px] shrink-0 text-foreground-subtle" />
        <span className="shrink-0 text-[13px] leading-[18px] font-medium text-foreground-muted">
          다시 검증
        </span>
        <span className="min-w-0 truncate font-mono text-[13px] leading-[18px] text-foreground-muted">
          {command}
        </span>
        {exitCode !== undefined && (
          <span
            className={cn(
              'ml-auto font-mono text-xs leading-4 font-medium',
              exitCode === 0 ? 'text-success' : 'text-danger',
            )}
          >
            exit {exitCode}
          </span>
        )}
      </div>
      <div className="flex h-7 items-center gap-2">
        <ListChecks aria-hidden className="size-[15px] shrink-0 text-foreground-subtle" />
        <span className="shrink-0 text-[13px] leading-[18px] font-medium text-foreground-muted">
          할 일
        </span>
        <span className="min-w-0 truncate text-[13px] leading-[18px] text-foreground-muted">
          {todoContent}
          {change.length > 0 && ` · ${change.join(' → ')}`}
        </span>
      </div>
    </div>
  );
}
