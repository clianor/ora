import type { PrChecks, PrInfo, PrState } from '@ora/protocol';
import {
  CircleCheck,
  CircleX,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Loader,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../lib/cn.ts';

export const prStateLabel: Record<PrState, string> = {
  OPEN: 'Open',
  DRAFT: 'Draft',
  MERGED: 'Merged',
  CLOSED: 'Closed',
};

export const prChecksLabel: Record<Exclude<PrChecks, 'none'>, string> = {
  pass: '검사 통과',
  fail: '검사 실패',
  running: '검사 진행 중',
};

const stateIcons: Record<PrState, { Icon: LucideIcon; color: string }> = {
  OPEN: { Icon: GitPullRequest, color: 'text-success' },
  DRAFT: { Icon: GitPullRequestDraft, color: 'text-foreground-subtle' },
  MERGED: { Icon: GitMerge, color: 'text-foreground-muted' },
  CLOSED: { Icon: GitPullRequestClosed, color: 'text-danger' },
};

const checkIcons: Record<Exclude<PrChecks, 'none'>, { Icon: LucideIcon; color: string }> = {
  pass: { Icon: CircleCheck, color: 'text-success' },
  fail: { Icon: CircleX, color: 'text-danger' },
  running: { Icon: Loader, color: 'text-foreground-muted motion-safe:animate-spin' },
};

/** 모양이 서로 다른 아이콘이라 색 없이도 상태를 구분합니다. */
export function PrStateIcon({ state, className }: { state: PrState; className?: string }) {
  const { Icon, color } = stateIcons[state];
  return <Icon aria-hidden className={cn('size-3.5 shrink-0', color, className)} />;
}

export function PrChecksIcon({ checks, className }: { checks: PrChecks; className?: string }) {
  if (checks === 'none') return null;
  const { Icon, color } = checkIcons[checks];
  return <Icon aria-hidden className={cn('size-3.5 shrink-0', color, className)} />;
}

/** 화면 읽기 프로그램과 마우스 툴팁이 쓰는 문장입니다. 예: `#42 Open · 검사 통과`. */
export function describePr(pr: PrInfo): string {
  const checks = pr.checks === 'none' ? '' : ` · ${prChecksLabel[pr.checks]}`;
  return `#${String(pr.number)} ${prStateLabel[pr.state]}${checks}`;
}
