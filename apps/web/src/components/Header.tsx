import type { Stage } from '@ora/protocol';
import { CirclePause, GitCompare, PanelLeft } from 'lucide-react';
import { stages } from '../events.ts';
import { cn } from '../lib/cn.ts';
import { DiffStat } from '../ui/stat.tsx';

const stageLabel: Record<Stage, string> = {
  understand: 'Understand',
  research: 'Research',
  decide: 'Decide',
  plan: 'Plan',
  execute: 'Execute',
  verify: 'Verify',
  operate: 'Operate',
  learn: 'Learn',
};

function StageChip({ index }: { index: number }) {
  const current = stages[index];
  if (!current) return null;
  return (
    <div
      role="group"
      aria-label={`단계 ${index + 1}/${stages.length}, ${stageLabel[current]}`}
      className="flex h-7 items-center gap-2 rounded-sm bg-surface px-2.5"
    >
      <span aria-hidden className="flex gap-[3px]">
        {stages.map((stage, position) => (
          <span
            key={stage}
            className={cn(
              'size-1.5 rounded-full',
              position < index && 'bg-success',
              position === index && 'bg-foreground',
              position > index && 'bg-foreground-subtle',
            )}
          />
        ))}
      </span>
      <span className="text-xs leading-4 font-medium text-foreground">{stageLabel[current]}</span>
      <span className="text-xs leading-4 text-foreground-subtle">
        {index + 1}/{stages.length}
      </span>
    </div>
  );
}

interface HeaderProps {
  title?: string;
  repoLabel?: string;
  repoTitle?: string;
  stageIndex?: number | null;
  diff?: { add: number; del: number } | null;
  isCrashed?: boolean;
  onToggleSidebar: () => void;
}

export function Header({
  title,
  repoLabel,
  repoTitle,
  stageIndex = null,
  diff = null,
  isCrashed = false,
  onToggleSidebar,
}: HeaderProps) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 px-5">
      <button
        type="button"
        aria-label="사이드바 열고 닫기"
        onClick={onToggleSidebar}
        className="rounded-sm text-foreground-muted hover:text-foreground"
      >
        <PanelLeft aria-hidden className="size-4" />
      </button>
      {title && <h1 className="text-sm leading-5 font-semibold text-foreground">{title}</h1>}
      {repoLabel && (
        <span title={repoTitle} className="text-[13px] leading-[18px] text-foreground-subtle">
          {repoLabel}
          {repoTitle && repoTitle !== repoLabel && <span className="sr-only"> ({repoTitle})</span>}
        </span>
      )}
      {isCrashed && (
        <span className="flex h-6 items-center gap-1 rounded-[6px] bg-surface px-2 text-xs leading-4 font-medium text-foreground-muted">
          <CirclePause aria-hidden className="size-3" />
          멈춤
        </span>
      )}
      <div className="ml-auto flex items-center gap-3">
        {stageIndex !== null && <StageChip index={stageIndex} />}
        {diff && (
          <div className="flex h-7 items-center gap-1.5 rounded-sm bg-surface px-2.5">
            <GitCompare aria-hidden className="size-3.5 text-foreground-muted" />
            <DiffStat add={diff.add} del={diff.del} />
          </div>
        )}
      </div>
    </header>
  );
}
