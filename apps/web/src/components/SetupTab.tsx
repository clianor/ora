import type { SetupCommandStatus, WorktreeRecord } from '@ora/protocol';
import {
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  Loader,
  MessageSquare,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../lib/cn.ts';
import { runAction, useStore } from '../store.tsx';
import { Button } from '../ui/button.tsx';
import { TerminalTab } from './TerminalTab.tsx';

const stepStyles: Record<SetupCommandStatus, { Icon: LucideIcon; color: string; label: string }> = {
  done: { Icon: CircleCheck, color: 'text-success', label: '끝남' },
  running: { Icon: Loader, color: 'text-foreground-muted', label: '실행 중' },
  pending: { Icon: CircleDashed, color: 'text-foreground-subtle', label: '대기' },
  failed: { Icon: CircleX, color: 'text-danger', label: 'exit' },
  skipped: { Icon: CircleSlash, color: 'text-foreground-subtle', label: '건너뜀' },
};

function StepList({ record }: { record: WorktreeRecord }) {
  return (
    <aside
      aria-label="초기 명령 상태"
      className="flex w-[300px] shrink-0 flex-col gap-0.5 border-l border-border bg-sidebar py-2.5"
    >
      <h2 className="px-3.5 py-1 text-xs leading-4 font-medium text-foreground-subtle">
        초기 명령
      </h2>
      <ol className="flex flex-col">
        {record.commands.map((command, index) => {
          const { Icon, color, label } = stepStyles[command.status];
          const isMuted = command.status === 'pending' || command.status === 'skipped';
          return (
            <li
              key={`${String(index)}-${command.command}`}
              className="flex h-7 items-center gap-2.5 px-3.5"
            >
              <Icon
                aria-hidden
                className={cn(
                  'size-3.5 shrink-0',
                  color,
                  command.status === 'running' && 'motion-safe:animate-spin',
                )}
              />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate font-mono text-[13px] leading-[18px]',
                  isMuted ? 'text-foreground-subtle' : 'text-foreground',
                )}
              >
                {command.command}
              </span>
              <span className={cn('text-xs leading-4 font-medium', color)}>
                {command.status === 'failed' && command.exitCode !== undefined
                  ? `exit ${String(command.exitCode)}`
                  : label}
              </span>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

function Banner({ record, onNewSession }: { record: WorktreeRecord; onNewSession: () => void }) {
  const { actions } = useStore();
  if (record.status === 'setup-failed') {
    const failed = record.commands.find((command) => command.status === 'failed');
    return (
      <div role="alert" className="flex items-center gap-3 bg-danger-subtle px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="flex items-center gap-2 text-sm leading-5 font-semibold text-foreground">
            <CircleX aria-hidden className="size-4 text-danger" />
            초기 명령이 실패했습니다
            <span className="font-mono text-xs leading-4 font-medium text-danger">
              {failed === undefined
                ? record.failure
                : `${failed.command} · exit ${String(failed.exitCode ?? '?')}`}
            </span>
          </p>
          <p className="text-xs leading-[18px] text-foreground-muted">
            {record.failure === '서버가 멈춰 끝까지 돌지 못함'
              ? '서버가 멈춰 끝까지 돌지 못했습니다. '
              : ''}
            워크트리는 만들어졌습니다. 원인을 고친 뒤 다시 실행하거나, 그대로 새 탭에서 세션을 열 수
            있습니다.
          </p>
        </div>
        <Button variant="ghost" onClick={onNewSession}>
          <MessageSquare aria-hidden className="size-3.5" />새 세션
        </Button>
        <Button
          onClick={() => {
            runAction(actions.rerunWorktreeSetup(record.id));
          }}
        >
          <RefreshCw aria-hidden className="size-3.5" />
          실패한 명령부터 다시 실행
        </Button>
      </div>
    );
  }
  const total = record.commands.length;
  const done = record.commands.filter((command) => command.status === 'done').length;
  if (record.status === 'ready') {
    return (
      <p
        role="status"
        className="flex items-center gap-2 bg-surface px-4 py-2.5 text-[13px] leading-[18px] font-semibold text-foreground"
      >
        <CircleCheck aria-hidden className="size-4 text-success" />
        초기 명령을 마쳤습니다
        <span className="text-xs font-normal text-foreground-subtle">
          {total}개 모두 끝났습니다. 새 탭에서 세션을 열 수 있습니다
        </span>
      </p>
    );
  }
  return (
    <p
      role="status"
      className="flex items-center gap-2 bg-surface px-4 py-2.5 text-[13px] leading-[18px] font-semibold text-foreground"
    >
      <Loader aria-hidden className="size-[15px] text-foreground-muted motion-safe:animate-spin" />
      워크트리 생성 중
      <span className="text-xs font-normal text-foreground-subtle">
        초기 명령 {Math.min(done + 1, total)}/{total} · 끝나면 새 탭에서 세션을 열 수 있습니다
      </span>
    </p>
  );
}

/** 새 worktree의 "초기 명령" 터미널 탭입니다. 위에 진행·실패 띠, 왼쪽에 터미널 출력, 오른쪽에 명령 상태 목록을 둡니다. */
export function SetupTab({
  record,
  terminalId,
  onRestart,
  onNewSession,
}: {
  record: WorktreeRecord;
  terminalId: string;
  onRestart: () => void;
  onNewSession: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <Banner record={record} onNewSession={onNewSession} />
      <div className="flex min-h-0 flex-1 border-t border-border">
        <TerminalTab terminalId={terminalId} onRestart={onRestart} />
        <StepList record={record} />
      </div>
    </div>
  );
}
