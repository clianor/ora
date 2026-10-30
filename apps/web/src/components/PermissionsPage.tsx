import type { PermissionSettings } from '@ora/protocol';
import { Plus, Trash2, X } from 'lucide-react';
import { RadioGroup } from 'radix-ui';
import { useId, useState } from 'react';
import { useStore } from '../store.tsx';
import { Button } from '../ui/button.tsx';
import { PageShell, inputClass } from './SettingsPages.tsx';
import { ChoiceCard, LoadedPage, Segmented, SaveBar, SettingsGroup } from './SettingsParts.tsx';

type Mode = PermissionSettings['mode'];
type Policy = PermissionSettings['tools'][string];

const modeOptions: { value: Mode; title: string; description: string }[] = [
  {
    value: 'always-ask',
    title: '항상 묻기',
    description: '파일 쓰기와 명령 실행을 모두 묻습니다.',
  },
  { value: 'write', title: '쓰기 허용', description: '명령 실행만 묻습니다.' },
  { value: 'bypass-permissions', title: '승인 생략', description: '묻지 않고 실행합니다.' },
];

const policyOptions = [
  { value: 'allow', label: '허용' },
  { value: 'prompt', label: '묻기' },
  { value: 'deny', label: '막기' },
] as const;

function countChanged(initial: PermissionSettings, draft: PermissionSettings): number {
  const toolNames = new Set([...Object.keys(initial.tools), ...Object.keys(draft.tools)]);
  const changedTools = [...toolNames].filter((name) => initial.tools[name] !== draft.tools[name]);
  const folders = new Set([...initial.restrictedFolders, ...draft.restrictedFolders]);
  const changedFolders = [...folders].filter(
    (folder) =>
      initial.restrictedFolders.includes(folder) !== draft.restrictedFolders.includes(folder),
  );
  return (initial.mode === draft.mode ? 0 : 1) + changedTools.length + changedFolders.length;
}

function PermissionsForm({
  initial,
  availableTools,
}: {
  initial: PermissionSettings;
  availableTools: readonly string[];
}) {
  const { actions } = useStore();
  const [draft, setDraft] = useState(initial);
  const [pickedTool, setPickedTool] = useState('');
  const [folderText, setFolderText] = useState('');
  const [folderError, setFolderError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const toolSelectId = useId();
  const folderInputId = useId();

  const addableTools = availableTools.filter((name) => !(name in draft.tools));
  const toolToAdd = addableTools.includes(pickedTool) ? pickedTool : (addableTools[0] ?? '');
  const patch = (change: Partial<PermissionSettings>) => {
    setMessage(null);
    setDraft({ ...draft, ...change });
  };
  const addFolder = () => {
    const path = folderText.trim();
    if (!path.startsWith('/') && path !== '~' && !path.startsWith('~/')) {
      setFolderError('폴더는 /나 ~/로 시작하는 경로로 적습니다.');
      return;
    }
    if (draft.restrictedFolders.includes(path)) {
      setFolderError('이미 있는 폴더입니다.');
      return;
    }
    setFolderError(null);
    setFolderText('');
    patch({ restrictedFolders: [...draft.restrictedFolders, path] });
  };

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        setIsSaving(true);
        actions
          .savePermissionSettings(draft)
          .then(() => {
            setMessage({ text: '저장했습니다. 다음 세션부터 적용합니다.', isError: false });
          })
          .catch((error: unknown) => {
            setMessage({
              text: error instanceof Error ? error.message : String(error),
              isError: true,
            });
          })
          .finally(() => {
            setIsSaving(false);
          });
      }}
    >
      <RadioGroup.Root
        aria-label="권한 모드"
        value={draft.mode}
        onValueChange={(mode) => {
          patch({ mode: mode as Mode });
        }}
        className="grid grid-cols-3 gap-2.5"
      >
        {modeOptions.map((option) => (
          <ChoiceCard
            key={option.value}
            value={option.value}
            title={option.title}
            description={option.description}
          />
        ))}
      </RadioGroup.Root>
      <SettingsGroup title="도구별 정책" aside="모드보다 먼저 적용">
        {Object.entries(draft.tools).map(([name, policy]) => (
          <div key={name} className="flex h-11 items-center gap-3 px-4">
            <span className="flex-1 truncate font-mono text-[13px] leading-[18px] font-medium text-foreground">
              {name}
            </span>
            <Segmented
              label={`${name} 정책`}
              value={policy}
              options={policyOptions}
              onChange={(next: Policy) => {
                patch({ tools: { ...draft.tools, [name]: next } });
              }}
            />
            <button
              type="button"
              aria-label={`${name} 정책 지우기`}
              onClick={() => {
                patch({
                  tools: Object.fromEntries(
                    Object.entries(draft.tools).filter(([toolName]) => toolName !== name),
                  ),
                });
              }}
              className="flex size-7 items-center justify-center rounded-sm text-foreground-muted hover:bg-surface-hover"
            >
              <X aria-hidden className="size-3.5" />
            </button>
          </div>
        ))}
        <div className="flex items-center gap-2 px-4 py-2.5">
          <label htmlFor={toolSelectId} className="text-xs leading-4 text-foreground-muted">
            도구 추가
          </label>
          <select
            id={toolSelectId}
            value={toolToAdd}
            disabled={addableTools.length === 0}
            onChange={(event) => {
              setPickedTool(event.target.value);
            }}
            className={`${inputClass} min-w-0 flex-1 font-mono`}
          >
            {addableTools.length === 0 && <option value="">추가할 도구가 없습니다</option>}
            {addableTools.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <Button
            disabled={toolToAdd === ''}
            onClick={() => {
              patch({ tools: { ...draft.tools, [toolToAdd]: 'prompt' } });
            }}
          >
            <Plus aria-hidden className="size-3.5" />
            추가
          </Button>
        </div>
      </SettingsGroup>
      <SettingsGroup
        title="항상 묻는 폴더"
        aside="이 폴더 안의 쓰기와 실행은 어떤 모드에서도 묻습니다"
      >
        {draft.restrictedFolders.map((folder) => (
          <div key={folder} className="flex h-11 items-center gap-3 px-4">
            <span className="flex-1 truncate font-mono text-[13px] leading-[18px] font-medium text-foreground">
              {folder}
            </span>
            <Button
              variant="ghost"
              onClick={() => {
                patch({
                  restrictedFolders: draft.restrictedFolders.filter((item) => item !== folder),
                });
              }}
            >
              <Trash2 aria-hidden className="size-3.5" />
              지우기<span className="sr-only"> {folder}</span>
            </Button>
          </div>
        ))}
        <div className="flex flex-col gap-1.5 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <label htmlFor={folderInputId} className="text-xs leading-4 text-foreground-muted">
              폴더 경로
            </label>
            <input
              id={folderInputId}
              value={folderText}
              placeholder="~/projects/secrets"
              aria-invalid={folderError !== null}
              onChange={(event) => {
                setFolderText(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                addFolder();
              }}
              className={`${inputClass} min-w-0 flex-1 font-mono`}
            />
            <Button onClick={addFolder}>
              <Plus aria-hidden className="size-3.5" />
              폴더 추가
            </Button>
          </div>
          {folderError !== null && (
            <p role="alert" className="text-xs leading-4 text-danger">
              {folderError}
            </p>
          )}
        </div>
      </SettingsGroup>
      <SaveBar
        changedCount={countChanged(initial, draft)}
        isInvalid={false}
        isSaving={isSaving}
        message={message}
        onRevert={() => {
          setMessage(null);
          setFolderError(null);
          setDraft(initial);
        }}
      />
    </form>
  );
}

/** "항상 승인한 명령" 목록입니다. 규칙은 바로 지우고, 파일을 읽지 못하면 지우기를 막고 이유를 보입니다. */
function ApprovalRules() {
  const { engineSettings, actions } = useStore();
  const [error, setError] = useState<string | null>(null);
  const { value, status, errorMessage } = engineSettings.approvalRules;
  const fileError = value?.error ?? (status === 'error' ? errorMessage : undefined);
  const rules = value?.rules ?? [];
  return (
    <SettingsGroup
      title="항상 승인한 명령"
      aside={fileError === undefined ? `${String(rules.length)}개` : undefined}
    >
      {fileError !== undefined && (
        <p role="alert" className="px-4 py-3 text-xs leading-[18px] text-danger">
          승인 기록을 읽을 수 없어 지울 수 없습니다. {fileError}
        </p>
      )}
      {fileError === undefined && rules.length === 0 && (
        <p className="px-4 py-3 text-xs leading-[18px] text-foreground-subtle">
          항상 승인한 명령이 없습니다.
        </p>
      )}
      {rules.map(({ key, rule }) => {
        const main = 'command' in rule ? rule.command : JSON.stringify(rule.args);
        const sub = 'command' in rule ? `${rule.tool} · ${rule.cwd}` : rule.tool;
        return (
          <div key={key} className="flex min-h-11 items-center gap-3 px-4 py-1.5">
            <div className="flex min-w-0 flex-1 flex-col gap-px">
              <span className="truncate font-mono text-[13px] leading-[18px] font-medium text-foreground">
                {main}
              </span>
              <span className="truncate font-mono text-xs leading-4 text-foreground-subtle">
                {sub}
              </span>
            </div>
            <Button
              variant="ghost"
              disabled={fileError !== undefined}
              onClick={() => {
                setError(null);
                actions.deleteApprovalRule(key).catch((failure: unknown) => {
                  setError(failure instanceof Error ? failure.message : String(failure));
                });
              }}
            >
              <Trash2 aria-hidden className="size-3.5" />
              지우기<span className="sr-only"> {main}</span>
            </Button>
          </div>
        );
      })}
      {error !== null && (
        <p role="alert" className="px-4 py-2 text-xs leading-4 text-danger">
          {error}
        </p>
      )}
    </SettingsGroup>
  );
}

/** 설정의 권한 페이지입니다. 설정 파일은 서버 API로만 쓰고, 모델 도구 호출로는 바꿀 수 없습니다. */
export function PermissionsPage() {
  const { engineSettings, actions } = useStore();
  return (
    <PageShell
      title="권한"
      description="모델이 묻지 않고 할 수 있는 일을 정합니다. 비밀정보 가리기, rm 대신 휴지통, 금지 구역 차단은 어느 모드에서나 적용합니다. 바꾼 값은 다음 세션부터 씁니다."
    >
      <LoadedPage
        data={engineSettings.permissions}
        onRetry={() => {
          actions.refreshEngineSettings('permissions').catch(() => undefined);
        }}
      >
        {({ availableTools, ...settings }) => (
          <>
            <PermissionsForm initial={settings} availableTools={availableTools} />
            <ApprovalRules />
          </>
        )}
      </LoadedPage>
    </PageShell>
  );
}
