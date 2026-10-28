import { cn } from '../lib/cn.ts';

export type DiffRow = readonly [line: string, sign: '+' | '-', text: string];

export function DiffBlock({ rows }: { rows: readonly DiffRow[] }) {
  return (
    <div className="overflow-hidden rounded-md bg-surface-sunken py-1.5">
      {rows.map(([line, sign, text], index) => (
        <div
          key={index}
          className={cn(
            'flex h-[22px] items-center gap-2.5 px-3 font-mono text-xs leading-[18px]',
            sign === '+' ? 'bg-success-subtle' : 'bg-danger-subtle',
          )}
        >
          <span className="text-foreground-subtle">{line}</span>
          <span className={sign === '+' ? 'text-success' : 'text-danger'}>
            {sign === '+' ? '+' : '−'}
          </span>
          <span className="text-foreground">{text}</span>
        </div>
      ))}
    </div>
  );
}
