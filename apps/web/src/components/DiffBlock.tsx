import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/cn.ts';
import { DiffStat } from '../ui/stat.tsx';

export type DiffRow = readonly [line: string, sign: '+' | '-', text: string];

/** 파일 이름과 증감, 복사 단추가 머리에 있는 diff 카드입니다. 복사하는 내용은 변경 뒤 파일의 줄입니다. */
export function DiffBlock({ path, rows }: { path: string; rows: readonly DiffRow[] }) {
  const [isCopied, setIsCopied] = useState(false);
  const add = rows.filter((row) => row[1] === '+').length;
  const del = rows.length - add;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex h-9 items-center gap-2 border-b border-border px-3.5">
        <span className="min-w-0 truncate font-mono text-[13px] leading-[18px] font-medium text-foreground-muted">
          {path}
        </span>
        <DiffStat add={add} del={del} />
        <button
          type="button"
          onClick={() => {
            navigator.clipboard
              .writeText(rows.flatMap((row) => (row[1] === '+' ? [row[2]] : [])).join('\n'))
              .then(() => {
                setIsCopied(true);
                setTimeout(() => {
                  setIsCopied(false);
                }, 1500);
              })
              .catch(() => undefined);
          }}
          className="ml-auto flex h-6 items-center gap-1 rounded-sm px-1.5 text-xs leading-4 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
        >
          {isCopied ? (
            <Check aria-hidden className="size-3.5" />
          ) : (
            <Copy aria-hidden className="size-3.5" />
          )}
          {isCopied ? '복사함' : '복사'}
        </button>
      </div>
      <div className="py-1.5">
        {rows.map(([line, sign, text], index) => (
          <div
            key={index}
            className={cn(
              'flex h-[22px] items-center gap-2.5 px-3.5 font-mono text-xs leading-[18px]',
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
    </div>
  );
}
