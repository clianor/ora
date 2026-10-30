import {
  GENERAL_SETTINGS_RANGES,
  type GeneralSettings,
  type IsolationSettings,
} from '@ora/protocol';
import { RadioGroup } from 'radix-ui';
import { useId, useState } from 'react';
import { paletteKeys, shortcuts } from '../lib/shortcuts.ts';
import { useStore } from '../store.tsx';
import { PageShell } from './SettingsPages.tsx';
import {
  ChoiceCard,
  LoadedPage,
  NumberInput,
  SaveBar,
  SettingsGroup,
  SettingsRow,
  Toggle,
} from './SettingsParts.tsx';

const nextSessionNote = '바꾼 값은 다음 세션부터 씁니다. 실행 중인 세션은 지금 값을 계속 씁니다.';
const savedText = '저장했습니다. 다음 세션부터 적용합니다.';

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type NumberField = Exclude<keyof typeof GENERAL_SETTINGS_RANGES, 'compactAtRatio'>;

interface GeneralDraft {
  maxSteps: string;
  maxRepairsPerTodo: string;
  noProgressSteps: string;
  maxConcurrentSessions: string;
  compactAtPercent: string;
  isReviewEnabled: boolean;
  isIdleSummaryEnabled: boolean;
}

const toDraft = (settings: GeneralSettings): GeneralDraft => ({
  maxSteps: String(settings.maxSteps),
  maxRepairsPerTodo: String(settings.maxRepairsPerTodo),
  noProgressSteps: String(settings.noProgressSteps),
  maxConcurrentSessions: String(settings.maxConcurrentSessions),
  compactAtPercent: String(Math.round(settings.compactAtRatio * 100)),
  isReviewEnabled: settings.isReviewEnabled,
  isIdleSummaryEnabled: settings.isIdleSummaryEnabled,
});

/** 정수가 아니거나 범위 밖이면 칸 아래에 보일 이유를 돌려줍니다. */
function checkRange(text: string, min: number, max: number): string | undefined {
  const value = Number(text);
  if (text.trim() === '' || !Number.isInteger(value) || value < min || value > max) {
    return `${String(min)}에서 ${String(max)} 사이의 정수로 적습니다.`;
  }
  return undefined;
}

const percentRange = {
  min: Math.round(GENERAL_SETTINGS_RANGES.compactAtRatio.min * 100),
  max: Math.round(GENERAL_SETTINGS_RANGES.compactAtRatio.max * 100),
};

function GeneralForm({ initial }: { initial: GeneralSettings }) {
  const { actions } = useStore();
  const saved = toDraft(initial);
  const [draft, setDraft] = useState(saved);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const base = useId();

  const errors: Record<NumberField | 'compactAtPercent', string | undefined> = {
    maxSteps: checkRange(
      draft.maxSteps,
      GENERAL_SETTINGS_RANGES.maxSteps.min,
      GENERAL_SETTINGS_RANGES.maxSteps.max,
    ),
    maxRepairsPerTodo: checkRange(
      draft.maxRepairsPerTodo,
      GENERAL_SETTINGS_RANGES.maxRepairsPerTodo.min,
      GENERAL_SETTINGS_RANGES.maxRepairsPerTodo.max,
    ),
    noProgressSteps: checkRange(
      draft.noProgressSteps,
      GENERAL_SETTINGS_RANGES.noProgressSteps.min,
      GENERAL_SETTINGS_RANGES.noProgressSteps.max,
    ),
    maxConcurrentSessions: checkRange(
      draft.maxConcurrentSessions,
      GENERAL_SETTINGS_RANGES.maxConcurrentSessions.min,
      GENERAL_SETTINGS_RANGES.maxConcurrentSessions.max,
    ),
    compactAtPercent: checkRange(draft.compactAtPercent, percentRange.min, percentRange.max),
  };
  const isInvalid = Object.values(errors).some((error) => error !== undefined);
  const changedCount = (Object.keys(saved) as (keyof GeneralDraft)[]).filter(
    (key) => saved[key] !== draft[key],
  ).length;

  const patch = (change: Partial<GeneralDraft>) => {
    setMessage(null);
    setDraft({ ...draft, ...change });
  };
  const numberRow = (
    field: NumberField | 'compactAtPercent',
    title: string,
    description: string | undefined,
    unit: string,
  ) => (
    <SettingsRow
      title={title}
      {...(description === undefined ? {} : { description })}
      controlId={`${base}-${field}`}
      error={errors[field]}
    >
      <NumberInput
        id={`${base}-${field}`}
        value={draft[field]}
        unit={unit}
        hasError={errors[field] !== undefined}
        onChange={(value) => {
          patch({ [field]: value });
        }}
      />
    </SettingsRow>
  );

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (isInvalid) return;
        setIsSaving(true);
        actions
          .saveGeneralSettings({
            maxSteps: Number(draft.maxSteps),
            maxRepairsPerTodo: Number(draft.maxRepairsPerTodo),
            noProgressSteps: Number(draft.noProgressSteps),
            maxConcurrentSessions: Number(draft.maxConcurrentSessions),
            isReviewEnabled: draft.isReviewEnabled,
            compactAtRatio: Number(draft.compactAtPercent) / 100,
            isIdleSummaryEnabled: draft.isIdleSummaryEnabled,
          })
          .then(() => {
            setMessage({ text: savedText, isError: false });
          })
          .catch((error: unknown) => {
            setMessage({ text: toMessage(error), isError: true });
          })
          .finally(() => {
            setIsSaving(false);
          });
      }}
    >
      <SettingsGroup title="세션 한도">
        {numberRow(
          'maxSteps',
          '최대 스텝',
          '이 횟수만큼 모델 요청을 하면 멈추고 보고합니다.',
          '스텝',
        )}
        {numberRow(
          'maxRepairsPerTodo',
          '할 일 하나를 고치는 최대 횟수',
          '넘으면 그 할 일을 막힘으로 바꿉니다.',
          '번',
        )}
        {numberRow(
          'noProgressSteps',
          '진전 없이 멈추는 스텝',
          '할 일이 나아지지 않은 채 이만큼 지나면 멈춥니다.',
          '스텝',
        )}
        {numberRow('maxConcurrentSessions', '동시에 돌리는 세션', undefined, '개')}
      </SettingsGroup>
      <SettingsGroup title="검증">
        <SettingsRow
          title="다른 모델의 검토"
          description="검증을 통과한 할 일을 다른 모델이 한 번 더 검토합니다."
          controlId={`${base}-review`}
        >
          <Toggle
            id={`${base}-review`}
            isOn={draft.isReviewEnabled}
            onChange={(isReviewEnabled) => {
              patch({ isReviewEnabled });
            }}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="대화 길이">
        {numberRow(
          'compactAtPercent',
          '압축을 시작하는 지점',
          '컨텍스트가 이 비율에 닿으면 앞부분을 요약합니다.',
          '%',
        )}
        <SettingsRow
          title="캐시 만료 전 요약"
          description="오래 기다릴 때 캐시가 끝나기 전에 미리 요약해 둡니다. 컨텍스트가 20만 토큰 이상일 때만 합니다."
          controlId={`${base}-idle`}
        >
          <Toggle
            id={`${base}-idle`}
            isOn={draft.isIdleSummaryEnabled}
            onChange={(isIdleSummaryEnabled) => {
              patch({ isIdleSummaryEnabled });
            }}
          />
        </SettingsRow>
      </SettingsGroup>
      <SaveBar
        changedCount={changedCount}
        isInvalid={isInvalid}
        isSaving={isSaving}
        message={message}
        onRevert={() => {
          setMessage(null);
          setDraft(saved);
        }}
      />
    </form>
  );
}

/** 설정의 일반 페이지입니다. 설정 파일은 서버 API로만 쓰고, 모델 도구는 이 값을 바꾸지 못합니다. */
export function GeneralPage() {
  const { engineSettings, actions } = useStore();
  return (
    <PageShell
      title="일반"
      description={`세션이 얼마나 오래, 몇 개까지 돌지와 대화가 길어졌을 때의 처리를 정합니다. ${nextSessionNote}`}
    >
      <LoadedPage
        data={engineSettings.general}
        onRetry={() => {
          actions.refreshEngineSettings('general').catch(() => undefined);
        }}
      >
        {(value) => <GeneralForm initial={value} />}
      </LoadedPage>
    </PageShell>
  );
}

const shortcutGroups = ['이동', '탭', '화면'] as const;

/** 설정의 키보드 단축키 페이지입니다. 실제 키 처리와 같은 목록(`lib/shortcuts.ts`)을 보여 주며, 바꾸는 기능은 없습니다. */
export function KeysPage() {
  const row = (label: string, keys: string) => (
    <div key={label} className="flex h-10 items-center px-4">
      <span className="flex-1 text-sm leading-5 text-foreground">{label}</span>
      <kbd className="rounded-[5px] bg-kbd px-1.5 font-sans text-xs leading-[22px] font-medium text-foreground-muted">
        {keys}
      </kbd>
    </div>
  );
  return (
    <PageShell
      title="키보드 단축키"
      description="마우스 없이 화면을 오갈 수 있습니다. 단축키는 아직 바꿀 수 없습니다."
    >
      {shortcutGroups.map((group) => (
        <SettingsGroup key={group} title={group}>
          {shortcuts
            .filter((shortcut) => shortcut.group === group)
            .map((shortcut) => row(shortcut.label, shortcut.keys))}
        </SettingsGroup>
      ))}
      <SettingsGroup title="명령 팔레트 안에서">
        {paletteKeys.map((item) => row(item.label, item.keys))}
      </SettingsGroup>
    </PageShell>
  );
}

const isolationOptions: {
  value: IsolationSettings['isolation'];
  title: string;
  description: string;
  badge?: string;
}[] = [
  { value: 'none', title: '없음', description: '홈 폴더와 환경변수를 그대로 물려받습니다.' },
  {
    value: 'harness',
    title: '하네스',
    description:
      'Ora가 다른 에이전트 도구의 설정을 읽지 않고, 명령마다 필요한 설정만 덮어씁니다. 홈 폴더는 그대로입니다.',
    badge: '기본값',
  },
  {
    value: 'clean-home',
    title: '깨끗한 홈',
    description:
      '하네스에 더해 따로 만든 홈 폴더를 쓰고, 허용한 환경변수만 넘깁니다. 작업 폴더에 다른 에이전트의 설정이 있으면 그 도구의 CLI 실행을 막습니다.',
  },
];

function IsolationForm({
  initial,
  unreadDirectories,
}: {
  initial: IsolationSettings['isolation'];
  unreadDirectories: readonly string[];
}) {
  const { actions } = useStore();
  const [draft, setDraft] = useState(initial);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const changedCount = draft === initial ? 0 : 1;
  const paths = unreadDirectories.map((name) => `~/${name}`);
  const rows = [paths.slice(0, 3), paths.slice(3)].filter((row) => row.length > 0);
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        setIsSaving(true);
        actions
          .saveIsolationSettings({ isolation: draft })
          .then(() => {
            setMessage({ text: savedText, isError: false });
          })
          .catch((error: unknown) => {
            setMessage({ text: toMessage(error), isError: true });
          })
          .finally(() => {
            setIsSaving(false);
          });
      }}
    >
      <RadioGroup.Root
        aria-label="격리 옵션"
        value={draft}
        onValueChange={(value) => {
          setMessage(null);
          setDraft(value as IsolationSettings['isolation']);
        }}
        className="flex flex-col gap-2"
      >
        {isolationOptions.map((option) => (
          <ChoiceCard
            key={option.value}
            value={option.value}
            title={option.title}
            description={option.description}
            {...(option.badge === undefined ? {} : { badge: option.badge })}
          />
        ))}
      </RadioGroup.Root>
      <SettingsGroup title="어느 옵션에서도 읽지 않는 경로">
        {rows.map((row) => (
          <p
            key={row.join()}
            className="px-4 py-2 font-mono text-[13px] leading-[18px] text-foreground-muted"
          >
            {row.join('  ·  ')}
          </p>
        ))}
      </SettingsGroup>
      <p className="text-xs leading-[18px] text-foreground-subtle">
        작업 폴더의 AGENTS.md, CLAUDE.md, AGENTS.local.md, CLAUDE.local.md는 모든 옵션에서 읽습니다.
      </p>
      <SaveBar
        changedCount={changedCount}
        isInvalid={false}
        isSaving={isSaving}
        message={message}
        onRevert={() => {
          setMessage(null);
          setDraft(initial);
        }}
      />
    </form>
  );
}

/** 설정의 격리 페이지입니다. 세션이 사용자 환경을 얼마나 물려받는지 정합니다. */
export function IsolationPage() {
  const { engineSettings, actions } = useStore();
  const running = engineSettings.isolation.value?.runningSessionCount ?? 0;
  return (
    <PageShell
      title="격리"
      description={`세션이 내 컴퓨터의 홈 폴더와 환경변수를 얼마나 물려받을지 정합니다. 바꾸면 다음 세션부터 적용하고, ${
        running > 0
          ? `실행 중인 세션 ${String(running)}개는 지금 값을 계속 씁니다.`
          : '실행 중인 세션은 없습니다.'
      }`}
    >
      <LoadedPage
        data={engineSettings.isolation}
        onRetry={() => {
          actions.refreshEngineSettings('isolation').catch(() => undefined);
        }}
      >
        {(value) => (
          <IsolationForm initial={value.isolation} unreadDirectories={value.unreadDirectories} />
        )}
      </LoadedPage>
    </PageShell>
  );
}
