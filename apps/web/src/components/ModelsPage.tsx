import type { ModelSettings } from '@ora/protocol';
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  CircleX,
  Gauge,
  GripVertical,
  Plus,
  ServerCrash,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useId, useState } from 'react';
import { useStore } from '../store.tsx';
import { Button } from '../ui/button.tsx';
import { PageShell, inputClass } from './SettingsPages.tsx';
import { LoadedPage, Segmented, SaveBar, SettingsGroup, SettingsRow } from './SettingsParts.tsx';

type Effort = 'low' | 'medium' | 'high';
type Roles = ModelSettings['roles'];

/** 기본 역할 다섯 개입니다. 화면 이름은 한국어, id는 설정의 `roles` 키입니다. */
const defaultRoles = [
  { id: 'default', title: '기본 작업', description: '세션에서 쓰는 모델' },
  { id: 'compaction', title: '압축 요약', description: '대화가 길 때' },
  { id: 'memory', title: '메모리', description: '저장과 다듬기' },
  { id: 'review', title: '검토', description: '검토 에이전트' },
  { id: 'fast', title: '빠른 조사', description: '조사 에이전트' },
] as const;

const fallbackRules: { icon: LucideIcon; title: string; description: string }[] = [
  {
    icon: Gauge,
    title: '사용 한도(429)',
    description: '다음 계정으로 바꾸고, 모든 계정이 한도면 다음 모델로 넘어갑니다',
  },
  {
    icon: ServerCrash,
    title: '서버 오류(5xx)·연결 오류',
    description: '같은 계정으로 다시 시도하고, 그래도 안 되면 다음 모델로 넘어갑니다',
  },
  { icon: CircleX, title: '그 밖의 오류', description: '넘어가지 않고 오류를 보입니다' },
];

const effortOptions = [
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
] as const;

/** 체인 항목 `<프로바이더>/<모델>[:<추론 강도>]`를 나눕니다. */
function splitEntry(text: string): { model: string; effort: Effort | undefined } {
  const match = /^(.*):(low|medium|high)$/.exec(text);
  return match === null
    ? { model: text, effort: undefined }
    : { model: match[1] ?? text, effort: match[2] as Effort };
}

const joinEntry = (model: string, effort: Effort | undefined) =>
  effort === undefined ? model : `${model}:${effort}`;

function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return [...list];
  const next = [...list];
  const [picked] = next.splice(from, 1);
  if (picked !== undefined) next.splice(to, 0, picked);
  return next;
}

/** 비어 있는 체인을 뺀 역할 목록입니다. 저장되는 값이고, 바꾼 값 수를 셀 때 서로 비교합니다. */
const nonEmptyRoles = (roles: Roles): Roles =>
  Object.fromEntries(Object.entries(roles).filter(([, chain]) => chain.length > 0));

function countChangedRoles(before: Roles, after: Roles): number {
  const a = nonEmptyRoles(before);
  const b = nonEmptyRoles(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (role) => JSON.stringify(a[role] ?? []) !== JSON.stringify(b[role] ?? []),
  ).length;
}

function ChainView({ chain }: { chain: readonly string[] }) {
  if (chain.length === 0) {
    return (
      <span className="text-[13px] leading-[18px] text-foreground-subtle">기본 작업과 같음</span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {chain.map((text, index) => {
        const { model, effort } = splitEntry(text);
        return (
          <span key={`${text}-${String(index)}`} className="flex items-center gap-1.5">
            {index > 0 && <ArrowRight aria-hidden className="size-3 text-foreground-subtle" />}
            <span className="flex h-[26px] items-center gap-1.5 rounded-md bg-surface-hover px-2 text-xs leading-4">
              <span className="font-mono font-medium text-foreground">{model.split('/')[1]}</span>
              {effort !== undefined && <span className="text-foreground-subtle">{effort}</span>}
            </span>
          </span>
        );
      })}
    </span>
  );
}

function ChainEditor({
  role,
  title,
  chain,
  catalog,
  onChange,
  onDone,
}: {
  role: string;
  title: string;
  chain: readonly string[];
  catalog: readonly string[];
  onChange: (chain: string[]) => void;
  onDone: () => void;
}) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [pick, setPick] = useState('');
  const selectId = useId();
  const used = new Set(chain.map((text) => splitEntry(text).model));
  const candidates = catalog.filter((model) => !used.has(model));
  const target = candidates.includes(pick) ? pick : (candidates[0] ?? '');
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <p className="flex items-baseline gap-2 text-sm leading-5 font-medium text-foreground">
        {title}
        <span className="font-mono text-xs leading-4 font-normal text-foreground-subtle">
          ({role})
        </span>
      </p>
      <p className="text-xs leading-4 text-foreground-subtle">
        위에서부터 쓰고, 쓸 수 없을 때만 다음 모델로 넘어갑니다. 끌어서 순서를 바꾸거나 위·아래
        단추를 누릅니다.
      </p>
      {chain.map((text, index) => {
        const { model, effort } = splitEntry(text);
        return (
          <div
            key={`${text}-${String(index)}`}
            draggable
            onDragStart={() => {
              setDragFrom(index);
            }}
            onDragOver={(event) => {
              event.preventDefault();
            }}
            onDrop={() => {
              if (dragFrom !== null) onChange(moveItem(chain, dragFrom, index));
              setDragFrom(null);
            }}
            className="flex h-9 items-center gap-2 rounded-md bg-surface-sunken px-2.5"
          >
            <GripVertical aria-hidden className="size-3.5 shrink-0 text-foreground-subtle" />
            <span className="w-3 font-mono text-xs leading-4 text-foreground-subtle">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[13px] leading-[18px] font-medium text-foreground">
              {model}
            </span>
            <Segmented
              label={`${model} 추론 강도`}
              value={effort}
              options={effortOptions}
              onChange={(next) => {
                onChange(
                  chain.map((item, position) =>
                    position === index ? joinEntry(model, next) : item,
                  ),
                );
              }}
            />
            <button
              type="button"
              aria-label={`${model.split('/')[1] ?? model} 위로 옮기기`}
              disabled={index === 0}
              onClick={() => {
                onChange(moveItem(chain, index, index - 1));
              }}
              className="flex size-7 items-center justify-center rounded-sm text-foreground-muted hover:bg-surface-hover disabled:opacity-40"
            >
              <ChevronUp aria-hidden className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label={`${model.split('/')[1] ?? model} 아래로 옮기기`}
              disabled={index === chain.length - 1}
              onClick={() => {
                onChange(moveItem(chain, index, index + 1));
              }}
              className="flex size-7 items-center justify-center rounded-sm text-foreground-muted hover:bg-surface-hover disabled:opacity-40"
            >
              <ChevronDown aria-hidden className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label={`${model.split('/')[1] ?? model} 빼기`}
              onClick={() => {
                onChange(chain.filter((_, position) => position !== index));
              }}
              className="flex size-7 items-center justify-center rounded-sm text-foreground-muted hover:bg-surface-hover"
            >
              <X aria-hidden className="size-3.5" />
            </button>
          </div>
        );
      })}
      <div className="flex items-center gap-2">
        <label htmlFor={selectId} className="text-xs leading-4 text-foreground-muted">
          모델 추가
        </label>
        <select
          id={selectId}
          value={target}
          disabled={candidates.length === 0}
          onChange={(event) => {
            setPick(event.target.value);
          }}
          className={`${inputClass} min-w-0 flex-1 font-mono`}
        >
          {candidates.length === 0 && <option value="">추가할 모델이 없습니다</option>}
          {candidates.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
        <Button
          disabled={target === ''}
          onClick={() => {
            onChange([...chain, target]);
          }}
        >
          <Plus aria-hidden className="size-3.5" />
          추가
        </Button>
        <Button variant="secondary" onClick={onDone}>
          완료
        </Button>
      </div>
    </div>
  );
}

function ModelsForm({ initial }: { initial: ModelSettings }) {
  const { actions, routing } = useStore();
  const [roles, setRoles] = useState<Roles>(initial.roles);
  const [revertPolicy, setRevertPolicy] = useState(initial.revertPolicy);
  const [editing, setEditing] = useState<string | null>(null);
  const [newRole, setNewRole] = useState('');
  const [roleError, setRoleError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const roleInputId = useId();

  const catalog =
    routing === null
      ? []
      : [...routing.chain, ...routing.others].map((entry) => `${entry.provider}/${entry.model}`);
  const customRoles = Object.keys(roles).filter(
    (role) => !defaultRoles.some((known) => known.id === role),
  );
  const changedCount =
    countChangedRoles(initial.roles, roles) + (revertPolicy === initial.revertPolicy ? 0 : 1);

  const setChain = (role: string, chain: string[]) => {
    setMessage(null);
    setRoles({ ...roles, [role]: chain });
  };
  const roleRow = (id: string, title: string, description: string | undefined) => {
    const chain = roles[id] ?? [];
    if (editing === id) {
      return (
        <ChainEditor
          key={id}
          role={id}
          title={title}
          chain={chain}
          catalog={catalog}
          onChange={(next) => {
            setChain(id, next);
          }}
          onDone={() => {
            setEditing(null);
          }}
        />
      );
    }
    return (
      <div key={id} className="flex items-center gap-3 px-4 py-2">
        <div className="flex w-[190px] shrink-0 flex-col gap-0.5">
          <span className="flex items-baseline gap-1.5 text-sm leading-5 font-medium text-foreground">
            {title}
            <span className="font-mono text-xs leading-4 font-normal text-foreground-subtle">
              ({id})
            </span>
          </span>
          {description !== undefined && (
            <span className="text-xs leading-4 text-foreground-subtle">{description}</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <ChainView chain={chain} />
        </div>
        <Button
          variant="ghost"
          aria-label={`${title} 모델 바꾸기`}
          onClick={() => {
            setEditing(id);
          }}
        >
          바꾸기
        </Button>
      </div>
    );
  };
  const addRole = () => {
    const name = newRole.trim();
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
      setRoleError('역할 이름은 영어 소문자로 시작하고 소문자, 숫자, -, _만 씁니다.');
      return;
    }
    if (name in roles || defaultRoles.some((known) => known.id === name)) {
      setRoleError('같은 이름의 역할이 있습니다.');
      return;
    }
    setRoleError(null);
    setNewRole('');
    setRoles({ ...roles, [name]: [] });
    setEditing(name);
  };

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        setIsSaving(true);
        actions
          .saveModelSettings({ roles: nonEmptyRoles(roles), revertPolicy })
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
      <SettingsGroup title="역할별 모델">
        {defaultRoles.map((role) => roleRow(role.id, role.title, role.description))}
        {customRoles.map((role) => roleRow(role, role, undefined))}
        <div className="flex flex-col gap-1.5 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <label htmlFor={roleInputId} className="text-xs leading-4 text-foreground-muted">
              역할 이름
            </label>
            <input
              id={roleInputId}
              value={newRole}
              placeholder="예: translate"
              aria-invalid={roleError !== null}
              onChange={(event) => {
                setNewRole(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                addRole();
              }}
              className={`${inputClass} w-[200px] font-mono`}
            />
            <Button onClick={addRole}>
              <Plus aria-hidden className="size-3.5" />
              역할 추가
            </Button>
          </div>
          {roleError !== null && (
            <p role="alert" className="text-xs leading-4 text-danger">
              {roleError}
            </p>
          )}
        </div>
      </SettingsGroup>
      <SettingsGroup title="다음 모델로 넘어가는 경우">
        <ul className="flex flex-col gap-1.5 px-4 py-3">
          {fallbackRules.map(({ icon: Icon, title, description }) => (
            <li key={title} className="flex items-center gap-2.5 text-xs leading-[18px]">
              <Icon aria-hidden className="size-[15px] shrink-0 text-foreground-muted" />
              <span className="w-[170px] shrink-0 text-[13px] font-medium text-foreground">
                {title}
              </span>
              <span className="text-foreground-muted">{description}</span>
            </li>
          ))}
        </ul>
        <SettingsRow
          title="첫 모델로 돌아가기"
          description="한도가 풀리는 시각을 알면 그때 돌아갑니다."
        >
          <Segmented
            label="첫 모델로 돌아가기"
            value={revertPolicy}
            options={[
              { value: 'cooldown-expiry', label: '한도가 풀리면' },
              { value: 'never', label: '돌아가지 않음' },
            ]}
            onChange={(next) => {
              setMessage(null);
              setRevertPolicy(next);
            }}
          />
        </SettingsRow>
      </SettingsGroup>
      <SaveBar
        changedCount={changedCount}
        isInvalid={false}
        isSaving={isSaving}
        message={message}
        onRevert={() => {
          setMessage(null);
          setRoles(initial.roles);
          setRevertPolicy(initial.revertPolicy);
          setEditing(null);
        }}
      />
    </form>
  );
}

/** 설정의 모델 페이지입니다. 역할마다 쓸 모델의 순서와 추론 강도를 정합니다. */
export function ModelsPage() {
  const { engineSettings, actions } = useStore();
  return (
    <PageShell
      title="모델"
      description="역할마다 쓸 모델을 순서대로 정합니다. 세션 화면에는 지금 쓰는 모델만 보입니다. 바꾼 값은 다음 세션부터 씁니다."
    >
      <LoadedPage
        data={engineSettings.models}
        onRetry={() => {
          actions.refreshEngineSettings('models').catch(() => undefined);
        }}
      >
        {(value) => <ModelsForm initial={value} />}
      </LoadedPage>
    </PageShell>
  );
}
