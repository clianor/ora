import { ArrowUpLeft, GitFork, Info, Square } from 'lucide-react';
import type { SessionRecord } from '@ora/protocol';
import { hashFor } from '../lib/route.ts';
import { runAction, useStore } from '../store.tsx';
import { Button } from '../ui/button.tsx';

/** 하위 세션 탭의 머리 띠입니다. 부모 세션, 에이전트, 쓰기 범위, 최대 스텝을 적고 부모로 돌아가는 링크와 중지 단추를 둡니다. */
export function ChildBanner({ record, isRunning }: { record: SessionRecord; isRunning: boolean }) {
  const { getSession, actions } = useStore();
  const link = record.delegatedBy;
  if (link === undefined) return null;
  const parentTitle = getSession(link.sessionId)?.record.title ?? link.sessionId;
  const scope =
    link.writeScope === undefined || link.writeScope.length === 0
      ? '읽기 전용'
      : `쓰기 ${link.writeScope.join(', ')}`;
  const details = [
    `부모: ${parentTitle}`,
    scope,
    ...(link.maxSteps === undefined ? [] : [`최대 스텝 ${String(link.maxSteps)}`]),
  ];
  return (
    <header className="flex items-center gap-2.5 border-b border-border bg-sunken px-5 py-2.5">
      <GitFork aria-hidden className="size-[15px] shrink-0 text-foreground-muted" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h1 className="text-[13px] leading-[18px] font-semibold text-foreground">
          하위 세션 · {link.agent}
        </h1>
        <p className="truncate text-xs leading-4 text-foreground-subtle">{details.join(' · ')}</p>
      </div>
      <a
        href={hashFor('worktree', { sessionId: link.sessionId })}
        className="inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-sm px-3 text-[13px] leading-[18px] font-medium text-foreground-muted transition-colors duration-(--duration-fast) ease-(--ease-out) hover:bg-surface-hover"
      >
        <ArrowUpLeft aria-hidden className="size-3.5" />
        부모 세션으로
      </a>
      {isRunning && (
        <Button
          variant="secondary"
          onClick={() => {
            runAction(actions.cancelRun(record.id, 'soft'));
          }}
        >
          <Square aria-hidden className="size-3" />
          중지
        </Button>
      )}
    </header>
  );
}

/** 하위 세션이 받은 브리프입니다. 엔진이 첫 메시지로 넣은 글에서 제목 줄을 빼고 한 문단으로 보입니다. */
export function BriefBox({ text }: { text: string }) {
  const body = text
    .split('\n')
    .filter((line) => !line.startsWith('## '))
    .join(' ');
  return (
    <section className="flex flex-col gap-1.5 rounded-[10px] border border-border bg-surface px-3.5 py-[11px]">
      <h2 className="text-xs leading-4 font-semibold text-foreground-subtle">브리프</h2>
      <p className="text-sm leading-[22px] text-foreground">{body}</p>
    </section>
  );
}

/** 입력창 자리의 안내 줄입니다. 하위 세션은 브리프로만 일하므로 지시는 부모 세션에서 바꿉니다. */
export function ChildNote() {
  return (
    <p className="mb-4 flex w-[720px] max-w-[calc(100%-var(--s-6)*2)] items-center gap-2 rounded-[10px] border border-border px-3.5 py-3 text-[13px] leading-[18px] text-foreground-muted">
      <Info aria-hidden className="size-3.5 shrink-0 text-foreground-subtle" />
      하위 세션은 브리프로만 일합니다. 지시를 바꾸려면 부모 세션에서 말합니다.
    </p>
  );
}
