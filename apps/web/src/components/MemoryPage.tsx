import { Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { MemoryItem, MemoryPassSummary } from '@ora/protocol';
import { formatElapsed, useNow } from '../lib/now.ts';
import { useStore } from '../store.tsx';
import { Button } from '../ui/button.tsx';
import { PageShell } from './SettingsPages.tsx';

const cardClass = 'flex flex-col divide-y divide-border rounded-lg border border-border bg-surface';

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
    detail = `합침 ${String(pass.merged)} · 문장 고침 ${String(pass.rewritten)} · 틀린 메모리 보관 ${String(pass.archived)} · 다음은 내일, 또는 새 메모리 20개가 쌓이면`;
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
                setError(reason instanceof Error ? reason.message : String(reason));
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
  const origin =
    item.sessionTitle === undefined
      ? formatElapsed(item.savedAt, now)
      : `${item.sessionTitle}에서 · ${formatElapsed(item.savedAt, now)}`;
  return (
    <li className="group flex items-center gap-3 px-4 py-3 hover:bg-surface-hover focus-within:bg-surface-hover">
      <div className="flex min-w-0 flex-1 flex-col gap-[5px]">
        <p className="text-sm leading-[21px] text-foreground">{item.text}</p>
        <div className="flex items-center gap-2">
          {item.isUnsourced && (
            <span className="rounded-sm bg-surface-hover px-1.5 text-[11px] leading-[18px] text-warning">
              출처 없음
            </span>
          )}
          {item.isStale && (
            <span className="rounded-sm bg-surface-hover px-1.5 text-[11px] leading-[18px] text-foreground-muted">
              오래 안 씀
            </span>
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
      <Button
        variant="ghost"
        className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
        onClick={() => {
          setError(undefined);
          actions.deleteMemory(item.id).catch((reason: unknown) => {
            setError(reason instanceof Error ? reason.message : String(reason));
          });
        }}
      >
        <Trash2 aria-hidden className="size-3.5" />
        지우기
      </Button>
    </li>
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
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] leading-[18px] font-medium text-foreground-muted">{title}</h2>
        <span className="text-xs leading-4 text-foreground-subtle">{String(items.length)}개</span>
      </div>
      {items.length === 0 ? (
        <p className="text-[13px] leading-5 text-foreground-muted">{empty}</p>
      ) : (
        <ul className={cardClass}>
          {items.map((item) => (
            <MemoryRow key={item.id} item={item} now={now} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** 설정의 메모리 페이지입니다. 엔진이 메모리를 자동으로 저장하고, 사람은 목록을 보고 틀린 항목을 지웁니다. */
export function MemoryPage({ cwd }: { cwd: string | undefined }) {
  const { memory, actions } = useStore();
  const now = useNow();

  /** 프로젝트 메모리는 고른 워크트리의 프로젝트 키로 갈리므로, 페이지를 열 때와 워크트리가 바뀔 때 서버에서 다시 읽어야 합니다. */
  useEffect(() => {
    actions.refreshMemory(cwd).catch(() => undefined);
  }, [actions, cwd]);

  const list = memory.list;
  return (
    <PageShell
      title="메모리"
      description="Ora가 작업하면서 알게 된 사실과 선호입니다. 작업이 끝나면 알아서 저장하고, 모델이 하루 한 번 다듬습니다. 틀린 메모리는 지우면 됩니다."
    >
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
      {list !== undefined && (
        <>
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
        </>
      )}
    </PageShell>
  );
}
