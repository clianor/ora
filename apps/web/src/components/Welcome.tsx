import { ChevronDown, Folder, GitBranch } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { navigate } from '../lib/route.ts';
import { useStore } from '../store.tsx';
import type { ComposerChips, Effort, OraStore, RoutingModel, WorktreeContext } from '../model.ts';
import { ChatProvider, Composer, DraftSync } from './Chat.tsx';
import { OverwriteNotice } from './OverwriteNotice.tsx';

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
  subtitle,
  cwd,
  chips,
  isPickerOpen,
  draftKey,
  notice,
  runningCount = 0,
  repoPath,
  onCreated,
}: {
  context?: ReactNode;
  subtitle?: string;
  cwd?: string;
  chips?: ComposerChips;
  isPickerOpen?: boolean;
  /** 이 새 탭의 ID입니다. 보내지 않은 입력창 글을 이 키로 보관합니다. */
  draftKey?: string;
  notice?: string;
  /** 같은 폴더에서 이미 도는 세션 수입니다. 1개 이상이면 덮어쓰기 경고를 보입니다. */
  runningCount?: number;
  repoPath?: string;
  onCreated: (sessionId: string) => void;
}) {
  const { actions, routing } = useStore();
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked>({});
  const base = picked.entry ?? routing?.chain[0];
  const selected = base && { ...base, effort: picked.effort ?? base.effort };
  const isPicked = picked.entry !== undefined || picked.effort !== undefined;
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
      {draftKey !== undefined && <DraftSync draftKey={draftKey} />}
      <div className="flex flex-1 flex-col items-center justify-center gap-5 pb-20">
        <div className="flex w-[720px] max-w-full flex-col gap-1.5">
          <h2 className="text-2xl leading-8 font-semibold text-foreground">무엇을 할까요?</h2>
          <p className="text-sm leading-[22px] text-foreground-subtle">
            {subtitle && `${subtitle} `}Ora는 계획을 세우고, 검증 명령으로 결과를 확인한 뒤 완료를
            보고합니다.
          </p>
        </div>
        <div className="flex w-[720px] max-w-full flex-col gap-2">
          {context && <div className="flex items-center gap-1.5">{context}</div>}
          {notice && (
            <p role="status" className="px-3.5 text-xs leading-4 text-foreground-muted">
              {notice}
            </p>
          )}
          {runningCount >= 1 && <OverwriteNotice count={runningCount} repo={repoPath} />}
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
        </div>
        {context && (
          <div className="flex w-[720px] max-w-full gap-5 px-3.5">
            <Shortcut keys="⌘K" label="명령 팔레트" />
            <Shortcut keys="⌘N" label="새 세션" />
            <Shortcut keys="⌘," label="설정" />
          </div>
        )}
      </div>
    </ChatProvider>
  );
}

/** 워크트리별 새 세션 화면입니다. 부제목이 이 폴더와 브랜치에서 시작한다고 알립니다. */
export function NewSessionWelcome({
  context,
  repoName,
  cwd,
  isPickerOpen,
  onCreated,
  draftKey,
  runningCount,
  repoPath,
}: {
  context: WorktreeContext;
  repoName: string;
  cwd?: string;
  isPickerOpen?: boolean;
  onCreated: (sessionId: string) => void;
  /** 이 새 탭의 ID입니다. 보내지 않은 입력창 글을 이 키로 보관합니다. */
  draftKey?: string;
  runningCount?: number;
  repoPath?: string;
}) {
  const setup = useStore().getWorktreeSetup(cwd ?? '');
  const place =
    context.path === undefined
      ? '서버가 정한 폴더'
      : [repoName, context.branch].filter(Boolean).join(' · ');
  const isSettingUp = setup?.status === 'creating' || setup?.status === 'setup';
  return (
    <Welcome
      cwd={cwd}
      onCreated={onCreated}
      isPickerOpen={isPickerOpen}
      chips={context.chips}
      draftKey={draftKey}
      runningCount={runningCount}
      repoPath={repoPath}
      notice={
        isSettingUp
          ? '초기 명령이 도는 중입니다. 입력은 채워 둔 채로 두고, 초기 명령이 끝난 뒤 보냅니다.'
          : undefined
      }
      subtitle={`${place}에서 시작합니다.`}
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
