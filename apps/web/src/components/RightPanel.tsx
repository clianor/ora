import type { OraEvent, SessionRecord, Todo } from '@ora/protocol';
import {
  FileDiff,
  Files,
  GitBranch,
  ListChecks,
  PanelRightClose,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../lib/cn.ts';
import { pickPanelTab, setPanelOpen, usePanelState, type PanelTab } from '../lib/panel.ts';
import { runAction, useStore } from '../store.tsx';
import { DiffStat } from '../ui/stat.tsx';
import { getVerifiedProgress, TodoPanelBody } from './TodoPanel.tsx';

const panelId = 'right-panel';

/** `⌘1`과 명령 팔레트가 패널을 열고 포커스를 옮깁니다. 패널이 접혀 있을 수 있어 렌더 뒤에 찾습니다. */
export function focusTodoPanel(): void {
  setPanelOpen(true);
  pickPanelTab('todo');
  /** `⌘1`과 명령 팔레트는 패널 밖에서 부르므로 패널의 ref를 넘길 길이 없어 id로 찾습니다. */
  requestAnimationFrame(() => document.getElementById(panelId)?.focus());
}

const pillClass =
  'flex h-[30px] items-center gap-1.5 rounded-sm whitespace-nowrap px-2.5 text-[13px] leading-[18px] transition-colors duration-(--duration-fast) ease-(--ease-out)';

function Pill({
  icon: Icon,
  label,
  isActive,
  onPick,
}: {
  icon: LucideIcon;
  label: string;
  isActive: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      onClick={onPick}
      className={cn(
        pillClass,
        isActive
          ? 'bg-surface-hover font-medium text-foreground'
          : 'text-foreground-muted hover:bg-surface-hover',
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      {label}
    </button>
  );
}

function ChangesTab({ cwd }: { cwd: string }) {
  const { actions, getBranch, getChanges } = useStore();
  const changes = getChanges(cwd);
  const branch = getBranch(cwd);

  if (changes === undefined) {
    return <p className="px-4 pt-2 text-xs leading-4 text-foreground-subtle">불러오는 중입니다</p>;
  }
  if (!changes.isRepo) {
    return (
      <p className="px-4 pt-2 text-xs leading-4 text-foreground-subtle">git 저장소가 아닙니다</p>
    );
  }
  const add = changes.files.reduce((sum, file) => sum + file.add, 0);
  const del = changes.files.reduce((sum, file) => sum + file.del, 0);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {branch && (
        <div className="flex h-10 shrink-0 items-center gap-1.5 px-3.5">
          <GitBranch aria-hidden className="size-3.5 text-foreground-subtle" />
          <span className="truncate font-mono text-[13px] leading-[18px] font-medium text-foreground-muted">
            {branch}
          </span>
        </div>
      )}
      <div className="flex h-9 shrink-0 items-center gap-2 px-3.5">
        <span className="text-[13px] leading-[18px] font-medium text-foreground-muted">
          모든 변경 사항
        </span>
        <DiffStat add={add} del={del} />
        <button
          type="button"
          aria-label="변경 목록 다시 읽기"
          onClick={() => {
            runAction(actions.loadChanges(cwd));
          }}
          className="ml-auto flex size-7 items-center justify-center rounded-sm text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
        >
          <RefreshCw aria-hidden className="size-3.5" />
        </button>
      </div>
      {changes.files.length === 0 ? (
        <p className="px-4 pt-1 text-xs leading-4 text-foreground-subtle">바뀐 파일이 없습니다</p>
      ) : (
        <ul className="flex min-h-0 flex-col gap-0.5 overflow-y-auto px-1.5 pb-3">
          {changes.files.map((file) => (
            <li key={file.path} className="flex h-8 items-center gap-2 px-2.5">
              <FileDiff aria-hidden className="size-3.5 shrink-0 text-foreground-subtle" />
              <span
                title={file.path}
                className="min-w-0 flex-1 truncate font-mono text-[13px] leading-[18px] text-foreground"
              >
                {file.path}
              </span>
              <DiffStat add={file.add} del={file.del} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface RightPanelProps {
  cwd: string;
  /** 세션 탭을 보고 있을 때만 있습니다. 없으면 "할 일" 탭을 쓸 수 없습니다. */
  session?: { record: SessionRecord; events: readonly OraEvent[]; todos: readonly Todo[] };
}

/**
 * 오른쪽 패널입니다. "할 일 · 변경 · 파일" 알약 탭이 머리에 있고, 접기 단추가 그 끝에 있습니다.
 * 세션 탭이 아니면 할 일이 없으므로 "변경" 탭을 엽니다. 사용자가 접은 상태는 `usePanelState`가 기억합니다.
 */
export function RightPanel({ cwd, session }: RightPanelProps) {
  const { pickedTab } = usePanelState();
  const tab: PanelTab = session === undefined ? 'changes' : (pickedTab ?? 'todo');
  const progress = session ? getVerifiedProgress(session.todos) : undefined;
  return (
    <aside
      id={panelId}
      tabIndex={-1}
      aria-label="오른쪽 패널"
      className="flex w-[340px] shrink-0 flex-col border-l border-border bg-sidebar outline-none"
    >
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-border bg-titlebar px-2">
        <div role="tablist" aria-label="패널 탭" className="flex items-center gap-0.5">
          {session ? (
            <Pill
              icon={ListChecks}
              label="할 일"
              isActive={tab === 'todo'}
              onPick={() => {
                pickPanelTab('todo');
              }}
            />
          ) : (
            <span
              role="tab"
              aria-selected="false"
              aria-disabled="true"
              title="세션 탭에서 보입니다"
              className={cn(pillClass, 'text-foreground-subtle')}
            >
              <ListChecks aria-hidden className="size-3.5" />할 일
            </span>
          )}
          <Pill
            icon={FileDiff}
            label="변경"
            isActive={tab === 'changes'}
            onPick={() => {
              pickPanelTab('changes');
            }}
          />
          <span
            role="tab"
            aria-selected="false"
            aria-disabled="true"
            title="곧 지원"
            className={cn(pillClass, 'text-foreground-subtle')}
          >
            <Files aria-hidden className="size-3.5" />
            파일
          </span>
        </div>
        {progress && (
          <span className="mr-1 ml-auto font-mono text-xs leading-4 font-medium text-foreground-muted">
            검증 {progress.verified}/{progress.denominator}
          </span>
        )}
        <button
          type="button"
          aria-label="오른쪽 패널 접기 (⌥⌘B)"
          title="오른쪽 패널 접기 (⌥⌘B)"
          onClick={() => {
            setPanelOpen(false);
          }}
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-sm text-foreground-muted hover:bg-surface-hover hover:text-foreground',
            !progress && 'ml-auto',
          )}
        >
          <PanelRightClose aria-hidden className="size-4" />
        </button>
      </div>
      {tab === 'todo' && session ? (
        <TodoPanelBody record={session.record} events={session.events} todos={session.todos} />
      ) : (
        <ChangesTab cwd={cwd} />
      )}
    </aside>
  );
}
