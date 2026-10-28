import type { ToolCallMessagePartProps } from '@assistant-ui/react';
import {
  CirclePause,
  FilePen,
  FileText,
  LoaderCircle,
  Search,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../lib/cn.ts';
import type { ToolResultView } from '../events.ts';
import { DiffStat } from '../ui/stat.tsx';
import { DiffBlock, type DiffRow } from './DiffBlock.tsx';

const toolStyles: Record<string, { verb: string; icon: LucideIcon }> = {
  read: { verb: '읽기', icon: FileText },
  edit: { verb: '수정', icon: FilePen },
  search: { verb: '검색', icon: Search },
  bash: { verb: '실행', icon: Terminal },
  file_read: { verb: '읽기', icon: FileText },
  file_edit: { verb: '수정', icon: FilePen },
  file_write: { verb: '쓰기', icon: FilePen },
  shell: { verb: '실행', icon: Terminal },
  'verify.run': { verb: '검증', icon: Terminal },
};

const shellTools = new Set(['bash', 'shell', 'verify.run']);
const editTools = new Set(['edit', 'file_edit', 'file_write']);

/** 긴 출력은 첫 줄만 보여 줍니다. 전체 출력은 이 줄에 담지 않습니다. */
function firstLine(text: string): string {
  return text.split(/\n| --- /)[0] ?? '';
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readDiffRows(value: unknown): DiffRow[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).flatMap((row) => {
    if (!Array.isArray(row)) return [];
    const [line, sign, text] = row as unknown[];
    if (typeof line !== 'string' || typeof text !== 'string') return [];
    return sign === '+' || sign === '-' ? [[line, sign, text] as const] : [];
  });
}

function readResult(value: unknown): ToolResultView | null {
  if (typeof value !== 'object' || value === null) return null;
  return value as ToolResultView;
}

/** 도구 호출을 높이 28px 한 줄로 보여 줍니다. 수정이면 diff 블록을 바로 아래에 놓습니다. */
export function ToolLine({ toolName, args, result }: ToolCallMessagePartProps) {
  const style = toolStyles[toolName] ?? { verb: toolName, icon: Terminal };
  const Icon = style.icon;
  const input = args as Record<string, unknown>;
  const diffRows = readDiffRows(input.diff);
  const oldText = readText(input.oldText);
  const newText = readText(input.newText);
  const rows =
    diffRows.length > 0 || toolName !== 'file_edit'
      ? diffRows
      : [
          ...oldText.split('\n').map((text) => ['', '-', text] as const),
          ...newText.split('\n').map((text) => ['', '+', text] as const),
        ];
  const target =
    readText(input.path) ||
    readText(input.command) ||
    readText(input.pattern) ||
    readText(input.intent);
  const add = typeof input.add === 'number' ? input.add : rows.filter((r) => r[1] === '+').length;
  const del = typeof input.del === 'number' ? input.del : rows.filter((r) => r[1] === '-').length;
  const outcome = readResult(result);
  const isAborted = outcome?.status === 'aborted';

  return (
    <>
      <div className="flex h-7 items-center gap-2">
        <Icon aria-hidden className="size-[15px] shrink-0 text-foreground-subtle" />
        <span className="text-[13px] leading-[18px] font-medium text-foreground-muted">
          {style.verb}
        </span>
        <span className="min-w-0 truncate font-mono text-[13px] leading-[18px] text-foreground-muted">
          {target}
        </span>
        {editTools.has(toolName) && (rows.length > 0 || typeof input.add === 'number') && (
          <DiffStat add={add} del={del} />
        )}
        {!outcome && (
          <span className="ml-auto flex items-center gap-1.5 text-xs leading-4 font-medium text-foreground-subtle">
            <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
            실행 중
          </span>
        )}
        {shellTools.has(toolName) && outcome && (
          <span className="ml-auto flex min-w-0 items-center gap-1.5">
            {isAborted && <CirclePause aria-hidden className="size-3.5 text-foreground-subtle" />}
            <span
              className={cn(
                'truncate font-mono text-xs leading-4 font-medium',
                outcome.status === 'ok' && 'text-success',
                (outcome.status === 'error' || outcome.status === 'timeout') && 'text-danger',
                isAborted && 'text-foreground-subtle',
              )}
            >
              {outcome.status === 'ok'
                ? firstLine(outcome.summary)
                : `${outcome.status} ${firstLine(outcome.summary)}`}
            </span>
          </span>
        )}
      </div>
      {rows.length > 0 && <DiffBlock rows={rows} />}
    </>
  );
}
