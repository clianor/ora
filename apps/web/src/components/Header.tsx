import { CirclePause, GitCompare, PanelLeft } from 'lucide-react';
import { DiffStat } from '../ui/stat.tsx';

interface HeaderProps {
  title?: string;
  repoLabel?: string;
  repoTitle?: string;
  diff?: { add: number; del: number } | null;
  isCrashed?: boolean;
  onToggleSidebar: () => void;
}

export function Header({
  title,
  repoLabel,
  repoTitle,
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
        className="shrink-0 rounded-sm text-foreground-muted hover:text-foreground"
      >
        <PanelLeft aria-hidden className="size-4" />
      </button>
      {title && (
        <h1
          title={title}
          className="min-w-0 truncate text-sm leading-5 font-semibold text-foreground"
        >
          {title}
        </h1>
      )}
      {repoLabel && (
        <span
          title={repoTitle}
          className="shrink-0 text-[13px] leading-[18px] whitespace-nowrap text-foreground-subtle"
        >
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
      <div className="ml-auto flex shrink-0 items-center gap-3">
        {diff && (diff.add > 0 || diff.del > 0) && (
          <div className="flex h-7 items-center gap-1.5 rounded-sm bg-surface px-2.5">
            <GitCompare aria-hidden className="size-3.5 text-foreground-muted" />
            <DiffStat add={diff.add} del={diff.del} />
          </div>
        )}
      </div>
    </header>
  );
}
