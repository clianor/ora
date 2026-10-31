import { worktreeNameSchema, type WorktreeOptionsResponse } from '@ora/protocol';
import { ChevronDown, GitBranch, GitBranchPlus, X } from 'lucide-react';
import { Suspense, use, useId, useState } from 'react';
import { navigate, setCreateWorktree } from '../lib/route.ts';
import {
  clearComposerDraft,
  getComposerDraft,
  pendingWorktreeKey,
  setComposerDraft,
} from '../lib/composerDraft.ts';
import type { OraActions } from '../model.ts';
import { useStore } from '../store.tsx';
import { Button, KeyHint } from '../ui/button.tsx';
import { inputClass } from './SettingsPages.tsx';

type OptionsResult = { options: WorktreeOptionsResponse } | { error: string };

const optionsByRepo = new Map<string, Promise<OptionsResult>>();

/** 저장소마다 부모 브랜치 목록을 한 번만 읽습니다. 창을 닫거나 만들면 비워 다음에 새로 읽습니다. */
function readOptions(actions: OraActions, repo: string): Promise<OptionsResult> {
  const cached = optionsByRepo.get(repo);
  if (cached) return cached;
  const loaded = actions.loadWorktreeOptions(repo).then(
    (options): OptionsResult => ({ options }),
    (error: unknown): OptionsResult => ({
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  optionsByRepo.set(repo, loaded);
  return loaded;
}

function close(repo: string): void {
  optionsByRepo.delete(repo);
  setCreateWorktree(undefined);
}

function DialogBody({ repo }: { repo: string }) {
  const { actions } = useStore();
  const result = use(readOptions(actions, repo));
  const base = useId();
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string>();
  const [serverError, setServerError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  if ('error' in result) {
    return (
      <p role="alert" className="text-[13px] leading-5 text-danger">
        {result.error}
      </p>
    );
  }
  const { options } = result;
  const parent = picked ?? options.current ?? options.branches[0] ?? '';
  const parsed = worktreeNameSchema.safeParse(name);
  const nameError =
    parsed.success || name === '' ? undefined : (parsed.error.issues[0]?.message ?? '');
  const canSubmit = parsed.success && parent !== '' && !isSubmitting;
  const shownName = parsed.success ? name : '<이름>';

  const submit = () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    setServerError(undefined);
    actions
      .createWorktree({ repo, name, parent })
      .then(async (created) => {
        const draft = getComposerDraft(pendingWorktreeKey);
        clearComposerDraft(pendingWorktreeKey);
        optionsByRepo.delete(repo);
        if (draft === '') {
          setCreateWorktree(undefined);
          navigate('worktree', { cwd: created.path });
          return;
        }
        const tabId = await actions.openNewTab(created.path);
        setComposerDraft(tabId, draft);
        setCreateWorktree(undefined);
        navigate('worktree', { cwd: created.path, tabId, isSessionMode: true });
      })
      .catch((error: unknown) => {
        setServerError(error instanceof Error ? error.message : String(error));
        setIsSubmitting(false);
      });
  };

  const error = nameError ?? serverError;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label
            htmlFor={`${base}-name`}
            className="text-xs leading-4 font-medium text-foreground-muted"
          >
            이름
          </label>
          <input
            id={`${base}-name`}
            value={name}
            autoFocus
            spellCheck={false}
            aria-invalid={error !== undefined}
            aria-describedby={`${base}-name-hint`}
            onChange={(event) => {
              setServerError(undefined);
              setName(event.target.value);
            }}
            placeholder="fix-negative-add"
            className={`${inputClass} h-[34px] font-mono`}
          />
          <p
            id={`${base}-name-hint`}
            role={error === undefined ? undefined : 'alert'}
            className={
              error === undefined
                ? 'text-xs leading-4 text-foreground-subtle'
                : 'text-xs leading-4 text-danger'
            }
          >
            {error ?? '소문자, 숫자, 하이픈, /만 씁니다'}
          </p>
        </div>
        <div className="flex w-[170px] shrink-0 flex-col gap-1.5">
          <label
            htmlFor={`${base}-parent`}
            className="text-xs leading-4 font-medium text-foreground-muted"
          >
            부모 브랜치
          </label>
          <div className="relative">
            <GitBranch
              aria-hidden
              className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-foreground-subtle"
            />
            <select
              id={`${base}-parent`}
              value={parent}
              onChange={(event) => {
                setPicked(event.target.value);
              }}
              className={`${inputClass} h-[34px] w-full appearance-none pr-7 pl-8 font-mono`}
            >
              {options.branches.map((branch) => (
                <option key={branch} value={branch}>
                  {branch}
                </option>
              ))}
            </select>
            <ChevronDown
              aria-hidden
              className="pointer-events-none absolute top-2.5 right-2.5 size-3.5 text-foreground-subtle"
            />
          </div>
        </div>
      </div>
      <dl className="flex flex-col gap-1.5 rounded-md bg-surface px-3 py-2.5 text-xs leading-4">
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-foreground-subtle">브랜치</dt>
          <dd className="font-mono font-medium text-foreground-muted">ora/{shownName}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-foreground-subtle">폴더</dt>
          <dd className="min-w-0 font-mono font-medium break-all text-foreground-muted">
            {options.folder}/{shownName}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-foreground-subtle">초기 명령</dt>
          <dd className="flex min-w-0 flex-col gap-0.5">
            {options.setupCommands.length === 0 ? (
              <span className="text-foreground-subtle">없음</span>
            ) : (
              options.setupCommands.map((command, index) => (
                <span key={`${String(index)}-${command}`} className="flex gap-2 font-mono">
                  <span className="w-3 text-foreground-subtle">{index + 1}</span>
                  <span className="font-medium text-foreground-muted">{command}</span>
                </span>
              ))
            )}
          </dd>
        </div>
        <p className="pl-[72px] text-foreground-subtle">
          만든 뒤 &quot;초기 명령&quot; 탭에서 차례로 돌립니다 · 설정 › 저장소에서 바꿉니다
        </p>
      </dl>
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => {
            close(repo);
          }}
        >
          취소
        </Button>
        <Button variant="primary" type="submit" disabled={!canSubmit}>
          만들기
          <KeyHint>↵</KeyHint>
        </Button>
      </div>
    </form>
  );
}

/** 새 worktree 만들기 창입니다. worktree만 만들고 세션은 시작하지 않습니다. 주소의 `createWorktree`가 저장소를 가리킵니다. */
export function CreateWorktreeDialog({ repo }: { repo: string }) {
  const titleId = useId();
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onKeyDown={(event) => {
        if (event.key === 'Escape') close(repo);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex w-[520px] max-w-[calc(100%-32px)] flex-col gap-4 rounded-xl border border-border-strong bg-popover p-5"
      >
        <div className="flex items-center gap-2">
          <GitBranchPlus aria-hidden className="size-[18px] text-foreground" />
          <h2 id={titleId} className="text-[17px] leading-6 font-semibold text-foreground">
            새 워크트리
          </h2>
          <span className="ml-auto truncate text-xs leading-4 text-foreground-subtle">
            {repo.split('/').at(-1)}
          </span>
          <button
            type="button"
            aria-label="닫기"
            onClick={() => {
              close(repo);
            }}
            className="flex size-6 items-center justify-center rounded-sm text-foreground-subtle hover:text-foreground"
          >
            <X aria-hidden className="size-[15px]" />
          </button>
        </div>
        <Suspense
          fallback={
            <p className="text-[13px] leading-5 text-foreground-muted">불러오는 중입니다.</p>
          }
        >
          <DialogBody repo={repo} />
        </Suspense>
      </div>
    </div>
  );
}
