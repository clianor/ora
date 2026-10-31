import {
  Brain,
  ChartNoAxesColumn,
  History,
  Minus,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Undo2,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type {
  MemoryItem,
  MemoryLogEntry,
  MemoryPassSummary,
  MemoryUsageResponse,
} from '@ora/protocol';
import { cn } from '../lib/cn.ts';
import { formatElapsed, useNow } from '../lib/now.ts';
import { useStore } from '../store.tsx';
import { Button } from '../ui/button.tsx';
import { PageShell } from './SettingsPages.tsx';

const cardClass = 'flex flex-col divide-y divide-border rounded-lg border border-border bg-surface';
const badgeClass = 'rounded-sm bg-surface-hover px-1.5 text-[11px] leading-[18px]';

function describePassTime(at: string, now: number): string {
  const time = new Date(at).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const dayStart = (ms: number) => new Date(new Date(ms).setHours(0, 0, 0, 0)).getTime();
  const days = Math.round((dayStart(now) - dayStart(Date.parse(at))) / 86_400_000);
  if (days === 0) return `오늘 ${time}`;
  return days === 1 ? `어제 ${time}` : `${String(days)}일 전 ${time}`;
}

function toErrorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function TidyBar({ pass, isTidying }: { pass: MemoryPassSummary | undefined; isTidying: boolean }) {
  const { actions } = useStore();
  const now = useNow();
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string>();
  const busy = isRunning || isTidying;
  let title = '아직 메모리를 다듬은 적이 없습니다';
  let detail = '하루에 한 번, 또는 새 메모리가 20개 넘게 쌓이면 모델이 다듬습니다';
  if (busy) {
    title = '메모리를 다듬는 중입니다';
    detail = '끝나면 이 목록이 바뀝니다';
  } else if (pass?.outcome === 'failed') {
    title = `${describePassTime(pass.at, now)}에 메모리를 다듬지 못했습니다`;
    detail = pass.reason ?? '모델 요청이 실패했습니다';
  } else if (pass !== undefined) {
    title = `${describePassTime(pass.at, now)}에 모델이 메모리를 다듬었습니다`;
    detail = `합침 ${String(pass.merged)} · 문장 고침 ${String(pass.rewritten)} · 틀린 메모리 보관 ${String(pass.archived)} · 반성 ${String(pass.reflected)} · 오래 안 씀 보관 ${String(pass.decayed)} · 다음은 내일, 또는 새 메모리 20개가 쌓이면`;
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3.5 py-3">
        <Sparkles aria-hidden className="size-4 shrink-0 text-foreground-muted" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-[13px] leading-[18px] font-medium text-foreground">{title}</p>
          <p className="text-xs leading-4 text-foreground-subtle">{detail}</p>
        </div>
        <Button
          disabled={busy}
          onClick={() => {
            setIsRunning(true);
            setError(undefined);
            actions
              .tidyMemory()
              .catch((reason: unknown) => {
                setError(toErrorMessage(reason));
              })
              .finally(() => {
                setIsRunning(false);
              });
          }}
        >
          지금 다듬기
        </Button>
      </div>
      {error !== undefined && (
        <p role="alert" className="text-xs leading-4 text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function MemoryRow({ item, now }: { item: MemoryItem; now: number }) {
  const { actions } = useStore();
  const [error, setError] = useState<string>();
  const elapsed = formatElapsed(item.savedAt, now);
  let origin = elapsed;
  if (item.reflectedSessionCount !== undefined) {
    origin = `세션 ${String(item.reflectedSessionCount)}개에서 · ${elapsed}`;
  } else if (item.sessionTitle !== undefined) {
    origin = `${item.sessionTitle}에서 · ${elapsed}`;
  }
  if (item.isStale) origin = `${origin} · 다음 다듬기에서 보관합니다`;
  return (
    <li className="group flex items-center gap-3 px-4 py-3 hover:bg-surface-hover focus-within:bg-surface-hover">
      <div className="flex min-w-0 flex-1 flex-col gap-[5px]">
        <p className="text-sm leading-[21px] text-foreground">{item.text}</p>
        <div className="flex items-center gap-2">
          {item.isUnsourced && <span className={cn(badgeClass, 'text-warning')}>출처 없음</span>}
          {item.reflectedSessionCount !== undefined && (
            <span className={cn(badgeClass, 'text-foreground-muted')}>반성으로 만듦</span>
          )}
          {item.isStale && (
            <span className={cn(badgeClass, 'text-foreground-muted')}>오래 안 씀</span>
          )}
          <span className="truncate text-xs leading-4 text-foreground-subtle">{origin}</span>
        </div>
        {error !== undefined && (
          <p role="alert" className="text-xs leading-4 text-danger">
            {error}
          </p>
        )}
      </div>
      <div className="flex w-[72px] shrink-0 flex-col gap-0.5">
        <span className="text-xs leading-4 text-foreground-subtle">쓴 횟수</span>
        <span className="text-xs leading-4 font-medium text-foreground-muted">
          {String(item.useCount)}회
        </span>
      </div>
      <div className="flex w-[72px] shrink-0 flex-col gap-0.5">
        <span className="text-xs leading-4 text-foreground-subtle">도움 됨</span>
        <span className="text-xs leading-4 font-medium text-foreground-muted">
          {item.helpfulCount === 0 ? '—' : `${String(item.helpfulCount)}회`}
        </span>
      </div>
      <Button
        variant="ghost"
        className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
        onClick={() => {
          setError(undefined);
          actions.deleteMemory(item.id).catch((reason: unknown) => {
            setError(toErrorMessage(reason));
          });
        }}
      >
        <Trash2 aria-hidden className="size-3.5" />
        지우기
      </Button>
    </li>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="min-w-0 truncate text-[13px] leading-[18px] font-medium text-foreground-muted">
          {title}
        </h2>
        <span className="shrink-0 text-xs leading-4 text-foreground-subtle">{aside}</span>
      </div>
      {children}
    </section>
  );
}

function MemoryGroup({
  title,
  items,
  empty,
  now,
}: {
  title: string;
  items: readonly MemoryItem[];
  empty: string;
  now: number;
}) {
  return (
    <Section title={title} aside={`${String(items.length)}개`}>
      {items.length === 0 ? (
        <p className="text-[13px] leading-5 text-foreground-muted">{empty}</p>
      ) : (
        <ul className={cardClass}>
          {items.map((item) => (
            <MemoryRow key={item.id} item={item} now={now} />
          ))}
        </ul>
      )}
    </Section>
  );
}

const operationLabels: Record<string, string> = {
  merge: '합침',
  rewrite: '고침',
  archive: '보관',
  decay: '오래 안 씀',
  reflect: '반성',
  delete: '지움',
  revert: '변경 취소',
};
const revertibleOperations = new Set(['merge', 'rewrite', 'archive', 'decay', 'delete', 'reflect']);

function describePass(passId: string): string {
  if (passId === 'user') return '사용자';
  if (passId.startsWith('pass-light-')) return '가벼운 패스';
  if (/^pass-\d{14}$/.test(passId)) return '전체 패스';
  return '세션이 끝난 뒤 가벼운 패스';
}

/** 로그를 패스 단위로 묶는다. 사용자가 한 변경은 줄마다 따로 묶는다. 입력은 최신 줄이 먼저다. */
function groupLog(
  entries: readonly MemoryLogEntry[],
): { key: string; entries: MemoryLogEntry[] }[] {
  const groups: { key: string; entries: MemoryLogEntry[] }[] = [];
  for (const entry of entries) {
    const key = entry.passId === 'user' ? `user-${String(entry.line)}` : entry.passId;
    const last = groups.at(-1);
    if (last?.key === key) last.entries.push(entry);
    else groups.push({ key, entries: [entry] });
  }
  return groups;
}

function LogRow({ entry, entries }: { entry: MemoryLogEntry; entries: readonly MemoryLogEntry[] }) {
  const { actions } = useStore();
  const [error, setError] = useState<string>();
  const [isRunning, setIsRunning] = useState(false);
  const label = operationLabels[entry.operation] ?? entry.operation;
  const target = entry.text ?? entry.ids.join(', ');
  let headline = target;
  let why = entry.reason.replace(/^이전 문장: "(.*)" · 사유: (.*)$/, '$2 · 이전 문장: "$1"');
  if (entry.operation === 'revert') {
    const reverted = entries.find((item) => item.line === entry.revertsLine);
    const revertedLabel = operationLabels[reverted?.operation ?? ''] ?? '변경';
    headline = `${revertedLabel} 변경(로그 ${String(entry.revertsLine ?? '')}번 줄)을 취소했습니다.`;
    why = `"${target}"`;
  }
  const canRevert = revertibleOperations.has(entry.operation) && !entry.isReverted;
  return (
    <li className="group flex items-center gap-3 px-4 py-[11px] hover:bg-surface-hover focus-within:bg-surface-hover">
      <span className="flex w-[84px] shrink-0">
        <span className={cn(badgeClass, 'font-medium text-foreground')}>{label}</span>
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p
          className={cn(
            'text-[13px] leading-5',
            entry.isReverted ? 'text-foreground-subtle' : 'text-foreground',
          )}
        >
          {headline}
        </p>
        <p className="text-xs leading-4 text-foreground-subtle">{why}</p>
        {error !== undefined && (
          <p role="alert" className="text-xs leading-4 text-danger">
            {error}
          </p>
        )}
      </div>
      <div className="flex min-w-[92px] shrink-0 justify-end">
        {entry.isReverted && (
          <span className={cn(badgeClass, 'font-medium text-foreground-muted')}>취소함</span>
        )}
        {canRevert && (
          <Button
            disabled={isRunning}
            className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => {
              setError(undefined);
              setIsRunning(true);
              actions
                .revertMemory(entry.line)
                .catch((reason: unknown) => {
                  setError(toErrorMessage(reason));
                })
                .finally(() => {
                  setIsRunning(false);
                });
            }}
          >
            <Undo2 aria-hidden className="size-3.5" />
            변경 취소
          </Button>
        )}
      </div>
    </li>
  );
}

function LogTab({ entries, now }: { entries: readonly MemoryLogEntry[]; now: number }) {
  if (entries.length === 0) {
    return (
      <p className="text-[13px] leading-5 text-foreground-muted">아직 변경 기록이 없습니다.</p>
    );
  }
  return groupLog(entries).map((group) => {
    const first = group.entries[0];
    if (first === undefined) return null;
    return (
      <Section
        key={group.key}
        title={`${describePassTime(first.at, now)} · ${describePass(first.passId)}`}
        aside={group.entries.length > 1 ? `${String(group.entries.length)}개 변경` : ''}
      >
        <ul className={cardClass}>
          {group.entries.map((entry) => (
            <LogRow key={entry.line} entry={entry} entries={entries} />
          ))}
        </ul>
      </Section>
    );
  });
}

function formatPercent(part: number, total: number): string {
  return `${String(Math.round((part / total) * 100))}%`;
}

const helpfulViews = {
  true: { icon: ThumbsUp, label: '도움 됨', color: 'text-success' },
  false: { icon: ThumbsDown, label: '도움 안 됨', color: 'text-danger' },
  null: { icon: Minus, label: '답 없음', color: 'text-foreground-subtle' },
} as const;

function UsageTab({ usage, now }: { usage: MemoryUsageResponse; now: number }) {
  const total = usage.injectedCount;
  return (
    <>
      <div className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3.5 py-3">
        <ChartNoAxesColumn aria-hidden className="size-4 shrink-0 text-foreground-muted" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-[13px] leading-[18px] font-medium text-foreground">
            {total === 0
              ? `최근 ${String(usage.windowDays)}일 동안 회상 팩에 넣은 메모리가 없습니다`
              : `최근 ${String(usage.windowDays)}일 동안 메모리를 회상 팩에 ${String(total)}번 넣었습니다`}
          </p>
          {total > 0 && (
            <p className="text-xs leading-4 text-foreground-subtle">
              {`도움 됨 ${String(usage.helpfulCount)}번(${formatPercent(usage.helpfulCount, total)}) · 도움 안 됨 ${String(usage.unhelpfulCount)}번(${formatPercent(usage.unhelpfulCount, total)}) · 답 없음 ${String(usage.unansweredCount)}번`}
            </p>
          )}
        </div>
      </div>
      {usage.items.map((item) => (
        <Section
          key={item.id}
          title={item.text}
          aside={`${String(item.useCount)}회 · 도움 됨 ${String(item.helpfulCount)}`}
        >
          <ul className={cardClass}>
            {item.sessions.map((session) => {
              const view = helpfulViews[String(session.helpful) as keyof typeof helpfulViews];
              return (
                <li
                  key={`${session.sessionId}-${session.at}`}
                  className="flex items-center gap-3 px-4 py-2.5"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] text-foreground">
                    {session.sessionTitle ?? session.sessionId}
                  </span>
                  <span className="shrink-0 text-xs leading-4 text-foreground-subtle">
                    {formatElapsed(session.at, now)}
                  </span>
                  <span className={cn('flex w-24 shrink-0 items-center gap-1.5', view.color)}>
                    <view.icon aria-hidden className="size-3.5" />
                    <span className="text-xs leading-4 font-medium">{view.label}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </Section>
      ))}
    </>
  );
}

type MemoryTab = 'memory' | 'log' | 'usage';

/** 설정의 메모리 페이지입니다. 엔진이 메모리를 자동으로 저장하고, 사람은 목록을 보고 틀린 항목을 지우거나 모델의 변경을 취소합니다. */
export function MemoryPage({ cwd }: { cwd: string | undefined }) {
  const { memory, actions } = useStore();
  const now = useNow();
  const [tab, setTab] = useState<MemoryTab>('memory');
  const [tabError, setTabError] = useState<string>();

  /** 프로젝트 메모리는 고른 워크트리의 프로젝트 키로 갈리므로, 페이지를 열 때와 워크트리가 바뀔 때 서버에서 다시 읽어야 합니다. */
  useEffect(() => {
    actions.refreshMemory(cwd).catch(() => undefined);
  }, [actions, cwd]);

  const openTab = (next: MemoryTab) => {
    setTab(next);
    setTabError(undefined);
    const loads: Record<MemoryTab, () => Promise<void>> = {
      memory: () => Promise.resolve(),
      log: actions.refreshMemoryLog,
      usage: actions.refreshMemoryUsage,
    };
    loads[next]().catch((reason: unknown) => {
      setTabError(toErrorMessage(reason));
    });
  };

  const list = memory.list;
  const tabs: { id: MemoryTab; label: string; icon: typeof Brain; count: string }[] = [
    {
      id: 'memory',
      label: '메모리',
      icon: Brain,
      count: list === undefined ? '' : String(list.project.length + list.global.length),
    },
    {
      id: 'log',
      label: '변경 기록',
      icon: History,
      count: memory.log === undefined ? '' : String(memory.log.entries.length),
    },
    { id: 'usage', label: '사용 기록', icon: ChartNoAxesColumn, count: '' },
  ];
  return (
    <PageShell
      title="메모리"
      description="Ora가 작업하면서 알게 된 사실과 선호입니다. 작업이 끝나면 알아서 저장하고, 모델이 하루 한 번 다듬습니다. 다듬은 내용은 변경 기록에서 취소할 수 있습니다."
    >
      <div role="tablist" aria-label="메모리 보기" className="flex items-center gap-1">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => {
              openTab(item.id);
            }}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] leading-[18px] transition-colors duration-(--duration-fast) ease-(--ease-out) hover:bg-surface-hover',
              tab === item.id
                ? 'bg-surface-hover font-semibold text-foreground'
                : 'font-medium text-foreground-muted',
            )}
          >
            <item.icon aria-hidden className="size-[15px]" />
            {item.label}
            {item.count !== '' && (
              <span className="font-mono text-xs leading-4 font-medium text-foreground-subtle">
                {item.count}
              </span>
            )}
          </button>
        ))}
      </div>
      {tabError !== undefined && (
        <p role="alert" className="text-xs leading-4 text-danger">
          {tabError}
        </p>
      )}
      {memory.status === 'error' && (
        <p role="alert" className="text-xs leading-4 text-danger">
          {memory.errorMessage}{' '}
          <Button
            variant="ghost"
            onClick={() => {
              actions.refreshMemory(cwd).catch(() => undefined);
            }}
          >
            다시 시도
          </Button>
        </p>
      )}
      {memory.status === 'loading' && (
        <p className="text-[13px] leading-5 text-foreground-muted">불러오는 중입니다.</p>
      )}
      {tab === 'memory' && list !== undefined && (
        <div role="tabpanel" className="flex flex-col gap-6">
          <TidyBar pass={list.lastPass} isTidying={list.isTidying} />
          <MemoryGroup
            title={cwd === undefined ? '이 프로젝트' : `이 프로젝트 · ${list.projectName}`}
            items={list.project}
            empty={
              cwd === undefined
                ? '워크트리를 고르면 보입니다.'
                : '이 프로젝트에 저장한 메모리가 없습니다.'
            }
            now={now}
          />
          <MemoryGroup
            title="모든 프로젝트"
            items={list.global}
            empty="모든 프로젝트에 적용하는 메모리가 없습니다."
            now={now}
          />
        </div>
      )}
      {tab === 'log' && (
        <div role="tabpanel" className="flex flex-col gap-6">
          {memory.log === undefined ? (
            <p className="text-[13px] leading-5 text-foreground-muted">불러오는 중입니다.</p>
          ) : (
            <LogTab entries={memory.log.entries} now={now} />
          )}
        </div>
      )}
      {tab === 'usage' && (
        <div role="tabpanel" className="flex flex-col gap-6">
          {memory.usage === undefined ? (
            <p className="text-[13px] leading-5 text-foreground-muted">불러오는 중입니다.</p>
          ) : (
            <UsageTab usage={memory.usage} now={now} />
          )}
        </div>
      )}
    </PageShell>
  );
}
