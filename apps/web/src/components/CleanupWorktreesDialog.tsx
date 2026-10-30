import type { CleanupCandidate, CleanupListResponse } from '@ora/protocol';
import {
  GitMerge,
  GitPullRequestClosed,
  Square,
  SquareCheck,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { Suspense, use, useId, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { formatElapsed, useNow } from '../lib/now.ts';
import { navigate, setCleanupWorktrees, useRouteState } from '../lib/route.ts';
import type { OraActions } from '../model.ts';
import { useStore } from '../store.tsx';
import { Button } from '../ui/button.tsx';

type ListResult = { list: CleanupListResponse } | { error: string };

const listByRepo = new Map<string, Promise<ListResult>>();

/** 창을 열 때마다 서버가 PR 상태와 막는 조건을 새로 판정하므로, 창을 닫으면 결과를 버립니다. */
function readList(actions: OraActions, repo: string): Promise<ListResult> {
  const cached = listByRepo.get(repo);
  if (cached) return cached;
  const loaded = actions.loadCleanup(repo).then(
    (list): ListResult => ({ list }),
    (error: unknown): ListResult => ({
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  listByRepo.set(repo, loaded);
  return loaded;
}

function close(repo: string): void {
  listByRepo.delete(repo);
  setCleanupWorktrees(undefined);
}

function describeWhen(candidate: CleanupCandidate, now: number): string {
  const verb = candidate.group === 'merged' ? '머지했습니다' : '닫았습니다';
  if (candidate.at === undefined) return verb;
  const when = formatElapsed(candidate.at, now);
  return `${when}${when.endsWith('전') ? '에' : ''} ${verb}`;
}

function CandidateRow({
  candidate,
  isChecked,
  now,
  onToggle,
}: {
  candidate: CleanupCandidate;
  isChecked: boolean;
  now: number;
  onToggle: () => void;
}) {
  const id = useId();
  const isBlocked = candidate.blocked !== undefined;
  const Mark = isChecked ? SquareCheck : Square;
  const Kind = candidate.group === 'merged' ? GitMerge : GitPullRequestClosed;
  const note =
    candidate.group === 'closed' && !isBlocked
      ? `${describeWhen(candidate, now)} · 커밋은 원격 브랜치에 남아 있습니다`
      : describeWhen(candidate, now);
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex items-center gap-2.5 rounded-md px-3 py-[9px]',
        isChecked && 'bg-surface',
        isBlocked ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-surface-hover',
      )}
    >
      <input
        id={id}
        type="checkbox"
        className="peer sr-only"
        checked={isChecked}
        disabled={isBlocked}
        onChange={onToggle}
      />
      <Mark
        aria-hidden
        className={cn(
          'size-4 shrink-0 peer-focus-visible:ring-2 peer-focus-visible:ring-ring',
          isBlocked ? 'text-foreground-subtle' : 'text-foreground',
        )}
      />
      <Kind
        aria-hidden
        className={cn(
          'size-3.5 shrink-0',
          isBlocked ? 'text-foreground-subtle' : 'text-foreground-muted',
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            'truncate font-mono text-[13px] leading-[18px] font-medium',
            isBlocked ? 'text-foreground-subtle' : 'text-foreground',
          )}
        >
          {candidate.branch}
        </span>
        {isBlocked ? (
          <span className="flex items-center gap-[5px] text-xs leading-4 font-medium text-foreground-muted">
            <TriangleAlert aria-hidden className="size-3 shrink-0 text-warning" />
            {candidate.blocked}
          </span>
        ) : (
          <span className="text-xs leading-4 text-foreground-subtle">{note}</span>
        )}
      </span>
      <span className="font-mono text-xs leading-4 text-foreground-subtle">
        #{candidate.number}
      </span>
    </label>
  );
}

function Group({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-0.5">
      <h3 className="flex h-[26px] items-center gap-2 px-1 text-xs leading-4">
        <span className="font-semibold text-foreground-muted">{title}</span>
        <span className="text-foreground-subtle">{note}</span>
      </h3>
      {children}
    </section>
  );
}

function DialogBody({ repo }: { repo: string }) {
  const { actions, getPrStatus } = useStore();
  const route = useRouteState();
  const home = getPrStatus(repo)?.worktrees.find((item) => item.isDefault)?.path ?? repo;
  const result = use(readList(actions, repo));
  const now = useNow();
  const [picked, setPicked] = useState<Set<string>>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [failures, setFailures] = useState<{ path: string; reason: string }[]>([]);
  const [serverError, setServerError] = useState<string>();

  if ('error' in result) {
    return (
      <p role="alert" className="text-[13px] leading-5 text-danger">
        {result.error}
      </p>
    );
  }
  const { candidates } = result.list;
  const selected =
    picked ??
    new Set(
      candidates
        .filter((item) => item.group === 'merged' && item.blocked === undefined)
        .map((item) => item.path),
    );
  const merged = candidates.filter((item) => item.group === 'merged');
  const closed = candidates.filter((item) => item.group === 'closed');
  const toggle = (path: string) => {
    const next = new Set(selected);
    if (!next.delete(path)) next.add(path);
    setPicked(next);
  };
  const submit = () => {
    setIsSubmitting(true);
    setServerError(undefined);
    actions
      .runCleanup(repo, [...selected])
      .then((outcome) => {
        if (route.cwd !== undefined && outcome.removed.includes(route.cwd)) {
          navigate('worktree', { cwd: home });
          if (outcome.failed.length > 0) setCleanupWorktrees(repo);
        }
        if (outcome.failed.length === 0) {
          close(repo);
          return;
        }
        listByRepo.delete(repo);
        setFailures(outcome.failed);
        setPicked(new Set());
        setIsSubmitting(false);
      })
      .catch((error: unknown) => {
        setServerError(error instanceof Error ? error.message : String(error));
        setIsSubmitting(false);
      });
  };
  const row = (candidate: CleanupCandidate) => (
    <CandidateRow
      key={candidate.path}
      candidate={candidate}
      isChecked={selected.has(candidate.path)}
      now={now}
      onToggle={() => {
        toggle(candidate.path);
      }}
    />
  );
  return (
    <>
      {merged.length === 0 && closed.length === 0 && (
        <p className="text-[13px] leading-5 text-foreground-muted">지울 워크트리가 없습니다.</p>
      )}
      {merged.length > 0 && (
        <Group title="Merged" note="PR을 머지한 워크트리">
          {merged.map(row)}
        </Group>
      )}
      {closed.length > 0 && (
        <Group title="Closed" note="머지하지 않고 닫은 PR">
          {closed.map(row)}
        </Group>
      )}
      {(serverError !== undefined || failures.length > 0) && (
        <div role="alert" className="flex flex-col gap-1 text-xs leading-4 text-danger">
          {serverError}
          {failures.map((item) => (
            <p key={item.path}>
              <span className="font-mono">{item.path.split('/').at(-1)}</span>: {item.reason}
            </p>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs leading-4 text-foreground-subtle">
          {selected.size}개 선택
        </span>
        <Button
          variant="ghost"
          onClick={() => {
            close(repo);
          }}
        >
          취소
        </Button>
        <Button
          className="bg-danger-subtle font-semibold text-danger hover:bg-danger-subtle"
          disabled={selected.size === 0 || isSubmitting}
          title={selected.size === 0 ? '지울 워크트리를 고릅니다' : undefined}
          onClick={submit}
        >
          <Trash2 aria-hidden className="size-3.5" />
          {selected.size}개 삭제
        </Button>
      </div>
    </>
  );
}

/** 머지된 worktree 삭제 창입니다. 주소의 `cleanup`이 저장소를 가리킵니다. 삭제 가능 여부는 서버가 판정한 값을 그대로 보입니다. */
export function CleanupWorktreesDialog({ repo }: { repo: string }) {
  const titleId = useId();
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay"
      onKeyDown={(event) => {
        if (event.key === 'Escape') close(repo);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[calc(100%-32px)] w-[560px] max-w-[calc(100%-32px)] flex-col gap-3 overflow-y-auto rounded-xl border border-border-strong bg-popover p-5"
      >
        <div className="flex items-center gap-2">
          <Trash2 aria-hidden className="size-[18px] text-foreground" />
          <h2 id={titleId} className="text-[17px] leading-6 font-semibold text-foreground">
            머지된 워크트리 삭제
          </h2>
          <span className="ml-auto truncate text-xs leading-4 text-foreground-subtle">
            {repo.split('/').at(-1)}
          </span>
          <button
            type="button"
            aria-label="닫기"
            onClick={() => {
              close(repo);
            }}
            className="flex size-6 items-center justify-center rounded-sm text-foreground-subtle hover:text-foreground"
          >
            <X aria-hidden className="size-[15px]" />
          </button>
        </div>
        <p className="text-[13px] leading-5 text-foreground-muted">
          워크트리마다 브랜치의 가장 최근 PR을 보고 목록을 만들었습니다. 고른 워크트리의 폴더와 로컬
          브랜치를 지웁니다. 원격 브랜치와 세션 기록은 그대로 둡니다.
        </p>
        <Suspense
          fallback={
            <p className="text-[13px] leading-5 text-foreground-muted">불러오는 중입니다.</p>
          }
        >
          <DialogBody repo={repo} />
        </Suspense>
      </div>
    </div>
  );
}
