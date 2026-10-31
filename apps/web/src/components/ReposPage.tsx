import type { ReposSettingsResponse } from '@ora/protocol';
import { ArrowDown, ArrowUp, FolderGit2, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useStore } from '../store.tsx';
import { Button } from '../ui/button.tsx';
import { PageShell, inputClass } from './SettingsPages.tsx';
import { LoadedPage, SaveBar, SettingsGroup } from './SettingsParts.tsx';

type Repo = ReposSettingsResponse['repos'][number];

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const iconButtonClass =
  'flex size-7 shrink-0 items-center justify-center rounded-sm text-foreground-subtle hover:bg-surface-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40';

function ReposForm({ initial }: { initial: Repo[] }) {
  const { actions } = useStore();
  const [draft, setDraft] = useState<Record<string, string[]>>(
    Object.fromEntries(initial.map((repo) => [repo.path, repo.setupCommands])),
  );
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);

  const commandsOf = (repo: Repo) => draft[repo.path] ?? [];
  const changedCount = initial.filter(
    (repo) => JSON.stringify(commandsOf(repo)) !== JSON.stringify(repo.setupCommands),
  ).length;
  const hasBlank = initial.some((repo) =>
    commandsOf(repo).some((command) => command.trim() === ''),
  );
  const change = (repo: Repo, next: string[]) => {
    setMessage(null);
    setDraft({ ...draft, [repo.path]: next });
  };

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        setIsSaving(true);
        actions
          .saveReposSettings({
            repos: initial.map((repo) => ({
              path: repo.path,
              setupCommands: commandsOf(repo).map((command) => command.trim()),
            })),
          })
          .then(() => {
            setMessage({
              text: '저장했습니다. 다음에 만드는 워크트리부터 적용합니다.',
              isError: false,
            });
          })
          .catch((error: unknown) => {
            setMessage({ text: toMessage(error), isError: true });
          })
          .finally(() => {
            setIsSaving(false);
          });
      }}
    >
      <SettingsGroup title="저장소" aside={`${String(initial.length)}개`}>
        {initial.length === 0 && (
          <p className="px-4 py-3 text-[13px] leading-5 text-foreground-muted">
            아직 알려진 저장소가 없습니다. git 저장소에서 세션을 시작하면 여기에 나타납니다.
          </p>
        )}
        {initial.map((repo) => {
          const commands = commandsOf(repo);
          return (
            <section key={repo.path} className="flex flex-col gap-2.5 px-4 py-3.5">
              <h3 className="flex items-center gap-2 text-sm leading-5 font-semibold text-foreground">
                <FolderGit2 aria-hidden className="size-[15px] text-foreground-muted" />
                {repo.name}
                <span className="min-w-0 flex-1 truncate font-mono text-xs leading-4 font-normal text-foreground-subtle">
                  {repo.path}
                </span>
                <span className="text-xs leading-4 font-normal text-foreground-subtle">
                  워크트리 {repo.worktreeCount}개
                </span>
              </h3>
              <div className="flex gap-3">
                <p className="w-[90px] shrink-0 pt-1.5 text-[13px] leading-[18px] font-medium text-foreground-muted">
                  초기 명령
                </p>
                <ol className="flex min-w-0 flex-1 flex-col gap-1.5">
                  {commands.map((command, index) => (
                    // 순서가 곧 실행 순서라서 줄 번호를 키로 씁니다.
                    <li key={index} className="flex items-center gap-1">
                      <input
                        value={command}
                        spellCheck={false}
                        aria-label={`${repo.name} 초기 명령 ${String(index + 1)}`}
                        onChange={(event) => {
                          change(
                            repo,
                            commands.map((item, at) => (at === index ? event.target.value : item)),
                          );
                        }}
                        className={`${inputClass} h-[34px] flex-1 font-mono`}
                      />
                      <button
                        type="button"
                        disabled={index === 0}
                        onClick={() => {
                          const next = [...commands];
                          [next[index - 1], next[index]] = [
                            next[index] ?? '',
                            next[index - 1] ?? '',
                          ];
                          change(repo, next);
                        }}
                        className={iconButtonClass}
                      >
                        <ArrowUp aria-hidden className="size-3.5" />
                        <span className="sr-only">위로</span>
                      </button>
                      <button
                        type="button"
                        disabled={index === commands.length - 1}
                        onClick={() => {
                          const next = [...commands];
                          [next[index], next[index + 1]] = [
                            next[index + 1] ?? '',
                            next[index] ?? '',
                          ];
                          change(repo, next);
                        }}
                        className={iconButtonClass}
                      >
                        <ArrowDown aria-hidden className="size-3.5" />
                        <span className="sr-only">아래로</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          change(
                            repo,
                            commands.filter((_, at) => at !== index),
                          );
                        }}
                        className={iconButtonClass}
                      >
                        <X aria-hidden className="size-3.5" />
                        <span className="sr-only">명령 빼기</span>
                      </button>
                    </li>
                  ))}
                  {commands.length === 0 && (
                    <li>
                      <input
                        value=""
                        spellCheck={false}
                        aria-label={`${repo.name} 초기 명령 1`}
                        placeholder="비워 두면 아무것도 돌리지 않습니다"
                        onChange={(event) => {
                          change(repo, [event.target.value]);
                        }}
                        className={`${inputClass} h-[34px] w-full font-mono`}
                      />
                    </li>
                  )}
                  <li>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        change(repo, [...commands, '']);
                      }}
                    >
                      <Plus aria-hidden className="size-3.5" />
                      명령 추가
                    </Button>
                  </li>
                </ol>
              </div>
              <div className="flex items-center gap-3">
                <p className="w-[90px] shrink-0 text-[13px] leading-[18px] font-medium text-foreground-muted">
                  워크트리 폴더
                </p>
                <p className="min-w-0 flex-1 truncate font-mono text-xs leading-4 text-foreground-subtle">
                  {repo.folder}/
                </p>
              </div>
            </section>
          );
        })}
      </SettingsGroup>
      <SaveBar
        changedCount={changedCount}
        isInvalid={hasBlank}
        isSaving={isSaving}
        message={message}
        onRevert={() => {
          setMessage(null);
          setDraft(Object.fromEntries(initial.map((repo) => [repo.path, repo.setupCommands])));
        }}
      />
    </form>
  );
}

/** 설정의 저장소 페이지입니다. 저장소마다 새 worktree를 만든 뒤 돌릴 초기 명령을 정합니다. */
export function ReposPage() {
  const { engineSettings, actions } = useStore();
  return (
    <PageShell
      title="저장소"
      description='새 워크트리를 만들 때 쓰는 설정입니다. 초기 명령은 만든 뒤 "초기 명령" 탭에서 위에서부터 차례로 돌고, 하나가 실패하면 멈춥니다.'
    >
      <LoadedPage
        data={engineSettings.repos}
        onRetry={() => {
          actions.refreshEngineSettings('repos').catch(() => undefined);
        }}
      >
        {(value) => <ReposForm initial={value.repos} />}
      </LoadedPage>
    </PageShell>
  );
}
