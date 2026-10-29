import { ChevronDown, Folder, GitBranch } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { basename } from '../lib/path.ts';
import { navigate } from '../lib/route.ts';
import { useStore } from '../store.tsx';
import type { ComposerChips, Effort, OraStore, RoutingModel, WorktreeContext } from '../model.ts';
import { DiffStat } from '../ui/stat.tsx';
import { ChatProvider, Composer, RoutingPreview, type PreviewEntry } from './Chat.tsx';

function Shortcut({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs leading-4">
      <kbd className="font-mono font-medium text-foreground-muted">{keys}</kbd>
      <span className="text-foreground-subtle">{label}</span>
    </span>
  );
}

interface Picked {
  entry?: RoutingModel;
  effort?: Effort;
}

/** 첫 입력으로 새 세션을 만들고 만든 세션 ID를 `onCreated`로 알립니다. 사용자가 고른 모델은 세션을 만들 때 `model`로 보냅니다. */
function Welcome({
  context,
  cwd,
  chips,
  isPickerOpen,
  onCreated,
}: {
  context: ReactNode;
  cwd?: string;
  chips?: ComposerChips;
  isPickerOpen?: boolean;
  onCreated: (sessionId: string) => void;
}) {
  const { actions, routing } = useStore();
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked>({});
  const base = picked.entry ?? routing?.chain[0];
  const selected = base && { ...base, effort: picked.effort ?? base.effort };
  const isPicked = picked.entry !== undefined || picked.effort !== undefined;
  let previewChain: PreviewEntry[] = routing?.chain ?? [];
  if (routing && selected && isPicked) {
    previewChain = [
      { ...selected, isPicked: true },
      ...routing.chain.filter(
        (entry) =>
          entry.provider !== selected.provider ||
          entry.model !== selected.model ||
          entry.effort !== selected.effort,
      ),
    ];
  }
  const create = async (task: string) => {
    try {
      setError(null);
      const model =
        isPicked && selected
          ? `${selected.provider}/${selected.model}${selected.effort ? `:${selected.effort}` : ''}`
          : undefined;
      const sessionId = await actions.createSession(task, cwd, model);
      onCreated(sessionId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return (
    <ChatProvider messages={[]} onSend={create}>
      <div className="flex flex-1 flex-col items-center justify-center gap-5 pb-20">
        <div className="flex w-[720px] max-w-full flex-col gap-1.5">
          <h2 className="text-2xl leading-8 font-semibold text-foreground">무엇을 할까요?</h2>
          <p className="text-sm leading-[22px] text-foreground-subtle">
            Ora는 계획을 세우고, 검증 명령으로 결과를 확인한 뒤 완료를 보고합니다.
          </p>
        </div>
        <div className="flex w-[720px] max-w-full flex-col gap-2">
          <div className="flex items-center gap-1.5">{context}</div>
          {error && (
            <p role="alert" className="px-3.5 text-xs leading-4 text-danger">
              {error}
            </p>
          )}
          <Composer
            isRunning={false}
            chips={chips}
            routing={
              routing && selected
                ? {
                    chain: routing.chain,
                    others: routing.others,
                    selected,
                    defaultOpen: isPickerOpen,
                    onPickModel: (entry) => {
                      setPicked({ entry });
                    },
                    onPickEffort: (effort) => {
                      setPicked((previous) => ({ ...previous, effort }));
                    },
                  }
                : undefined
            }
          />
          {previewChain.length > 0 && <RoutingPreview role="default" chain={previewChain} />}
        </div>
        <div className="flex w-[720px] max-w-full gap-5 px-3.5">
          <Shortcut keys="⌘K" label="명령 팔레트" />
          <Shortcut keys="⌘N" label="새 세션" />
          <Shortcut keys="⌘," label="설정" />
        </div>
      </div>
    </ChatProvider>
  );
}

const chipClass = 'flex h-7 items-center gap-1.5 rounded-sm bg-surface px-2.5';

/** 워크트리별 새 세션 화면입니다. 맥락 칩은 고르지 않는 고정 칩이고 워크트리 경로와 변경 통계를 보여 줍니다. */
export function NewSessionWelcome({
  context,
  cwd,
  isPickerOpen,
  onCreated,
}: {
  context: WorktreeContext;
  cwd?: string;
  isPickerOpen?: boolean;
  onCreated: (sessionId: string) => void;
}) {
  return (
    <Welcome
      cwd={cwd}
      onCreated={onCreated}
      isPickerOpen={isPickerOpen}
      chips={context.chips}
      context={
        <>
          <span className={chipClass} title={context.path}>
            <Folder aria-hidden className="size-3.5 text-foreground-muted" />
            <span className="font-mono text-[13px] leading-[18px] font-medium text-foreground-muted">
              {context.path === undefined ? '서버 기본 작업 폴더' : basename(context.path)}
              {context.path !== undefined && context.path !== basename(context.path) && (
                <span className="sr-only"> ({context.path})</span>
              )}
            </span>
          </span>
          {context.branch !== undefined && (
            <span className={chipClass}>
              <GitBranch aria-hidden className="size-3.5 text-foreground-muted" />
              <span className="font-mono text-[13px] leading-[18px] font-medium text-foreground-muted">
                {context.branch}
              </span>
              {context.add !== undefined && context.del !== undefined && (
                <DiffStat add={context.add} del={context.del} />
              )}
            </span>
          )}
          <span className="pl-1.5 text-xs leading-4 text-foreground-subtle">
            {context.path ? '이 폴더에서 시작합니다' : '서버가 정한 폴더에서 시작합니다'}
          </span>
        </>
      }
    />
  );
}

function ContextSelect({
  label,
  icon,
  options,
}: {
  label: string;
  icon: ReactNode;
  options: readonly string[];
}) {
  return (
    <label className="relative flex h-7 items-center rounded-sm bg-surface">
      <span aria-hidden className="pointer-events-none absolute left-2.5 flex">
        {icon}
      </span>
      <select
        aria-label={label}
        defaultValue={options[0]}
        className="h-full appearance-none rounded-sm bg-transparent pr-7 pl-[30px] text-[13px] leading-[18px] font-medium text-foreground-muted outline-none"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-2.5 size-3 text-foreground-subtle"
      />
    </label>
  );
}

/** 첫 화면입니다. 세션이 없을 때 저장소와 브랜치를 고르는 드롭다운을 보여 줍니다. */
export function EmptyWelcome({ empty }: { empty: OraStore['empty'] }) {
  return (
    <Welcome
      chips={empty.chips}
      onCreated={(sessionId) => {
        navigate('worktree', { sessionId });
      }}
      context={
        <>
          <ContextSelect
            label="저장소"
            options={empty.repos}
            icon={<Folder aria-hidden className="size-3.5 text-foreground-muted" />}
          />
          <ContextSelect
            label="브랜치"
            options={empty.branches}
            icon={<GitBranch aria-hidden className="size-3.5 text-foreground-muted" />}
          />
        </>
      }
    />
  );
}
