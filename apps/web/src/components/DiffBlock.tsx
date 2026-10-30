import { Check, Copy } from 'lucide-react';
import { useMemo, useState } from 'react';

import { DiffStat } from '../ui/stat.tsx';

export type DiffRow = readonly [line: string, sign: '+' | '-', text: string];

/** 줄 수천 개를 React 노드로 만들면 느리므로, 글자를 이스케이프한 HTML 한 덩어리로 그립니다. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** 파일 이름과 증감, 복사 단추가 머리에 있는 diff 카드입니다. 복사하는 내용은 변경 뒤 파일의 줄입니다. */
export function DiffBlock({ path, rows }: { path: string; rows: readonly DiffRow[] }) {
  const [isCopied, setIsCopied] = useState(false);
  const add = rows.filter((row) => row[1] === '+').length;
  const del = rows.length - add;
  // 줄이 수천 개일 때 문자열 조립 비용이 커서 rows가 같으면 다시 만들지 않습니다.
  const rowsHtml = useMemo(
    () =>
      rows
        .map(([line, sign, text]) => {
          const isAdd = sign === '+';
          return `<div class="[contain-intrinsic-size:auto_22px] [content-visibility:auto] flex h-[22px] items-center gap-2.5 px-3.5 font-mono text-xs leading-[18px] ${isAdd ? 'bg-success-subtle' : 'bg-danger-subtle'}"><span class="text-foreground-subtle">${escapeHtml(line)}</span><span class="${isAdd ? 'text-success' : 'text-danger'}">${isAdd ? '+' : '−'}</span><span class="text-foreground">${escapeHtml(text)}</span></div>`;
        })
        .join(''),
    [rows],
  );
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
      <div className="py-1.5" dangerouslySetInnerHTML={{ __html: rowsHtml }} />
    </div>
  );
}
