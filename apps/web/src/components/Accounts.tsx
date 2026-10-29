import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clock,
  Ellipsis,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  LogIn,
  type LucideIcon,
} from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useId, useState } from 'react';
import type { AccountProvider, AccountView, LoginState, ProviderAccounts } from '@ora/protocol';
import { cn } from '../lib/cn.ts';
import { useNow } from '../lib/now.ts';
import { useActions, useStore } from '../store.tsx';
import { Button } from '../ui/button.tsx';

const providerOrder: AccountProvider[] = ['claude', 'codex', 'grok'];
const providerLabels: Record<AccountProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  grok: 'Grok',
};
const envNamePattern = /^[A-Z_][A-Z0-9_]*$/;

const statusViews: Record<
  AccountView['status'],
  { icon: LucideIcon; className: string; label: (account: AccountView) => string }
> = {
  inUse: { icon: CircleCheck, className: 'text-success', label: () => '사용 중' },
  limited: {
    icon: Clock,
    className: 'text-warning',
    label: (account) =>
      account.limitedUntil === undefined
        ? '한도'
        : `한도 · ${formatResetTime(account.limitedUntil)}에 풀림`,
  },
  expired: { icon: CircleAlert, className: 'text-danger', label: () => '만료 · 다시 로그인' },
  idle: { icon: CircleDashed, className: 'text-foreground-muted', label: () => '대기' },
};

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 오늘이면 시각만, 다른 날이면 월/일과 시각을 적습니다. */
function formatResetTime(iso: string): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

function formatRemaining(account: AccountView): string {
  const parts = [
    account.fiveHour && `5시간 ${Math.round(account.fiveHour.remainingPct)}%`,
    account.sevenDay && `7일 ${Math.round(account.sevenDay.remainingPct)}%`,
  ].filter((part): part is string => typeof part === 'string');
  return parts.length === 0 ? '측정 안 함' : parts.join(' · ');
}

function Countdown({ expiresAt }: { expiresAt: string }) {
  const now = useNow();
  const seconds = Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000));
  const text = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  return <span className="font-mono text-xs leading-4 text-foreground-subtle">{text} 남음</span>;
}

function openInNewTab(url: string): void {
  window.open(url, '_blank', 'noopener');
}

function AccountRow({ provider, account }: { provider: AccountProvider; account: AccountView }) {
  const actions = useActions();
  const [mode, setMode] = useState<'view' | 'priority' | 'logout'>('view');
  const [priority, setPriority] = useState(String(account.priority));
  const priorityId = useId();
  const [error, setError] = useState<string | null>(null);
  const status = statusViews[account.status];
  const StatusIcon = status.icon;

  const submit = (request: Promise<void>) => {
    setError(null);
    request
      .then(() => {
        setMode('view');
      })
      .catch((failure: unknown) => {
        setError(toMessage(failure));
      });
  };

  if (mode === 'logout') {
    return (
      <div className="flex items-center gap-3 px-4 py-3">
        <p className="flex-1 text-[13px] leading-[18px] text-foreground">
          {account.name} 계정에서 로그아웃합니다. 저장한 로그인 정보를 삭제합니다.
        </p>
        <Button
          variant="primary"
          onClick={() => {
            submit(actions.logoutAccount(provider, account.name));
          }}
        >
          로그아웃
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setMode('view');
          }}
        >
          취소
        </Button>
        {error && (
          <p role="alert" className="basis-full text-xs leading-4 text-danger">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm leading-5 font-medium text-foreground">{account.name}</span>
          <span className="rounded-[6px] bg-surface-hover px-1.5 text-[11px] leading-5 font-medium text-foreground-muted">
            {account.kind === 'oauth' ? '구독' : 'API 키'}
          </span>
        </div>
        {account.detail !== undefined && (
          <span className="truncate font-mono text-xs leading-4 text-foreground-subtle">
            {account.detail}
          </span>
        )}
        {account.envPresent === false && (
          <span className="flex items-start gap-1 text-xs leading-4 text-warning">
            <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
            서버 환경에 없음
          </span>
        )}
      </div>
      <div className="flex w-[150px] flex-col gap-0.5">
        <span className="text-xs leading-4 text-foreground-subtle">남은 한도</span>
        <span
          className={cn(
            'text-xs leading-4 font-medium text-foreground-muted',
            (account.fiveHour ?? account.sevenDay) && 'font-mono',
          )}
        >
          {formatRemaining(account)}
        </span>
      </div>
      <div className={cn('flex w-[150px] items-center gap-1.5', status.className)}>
        <StatusIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="text-xs leading-4 font-medium">{status.label(account)}</span>
      </div>
      <div className="flex w-[52px] flex-col gap-0.5">
        <label htmlFor={priorityId} className="text-xs leading-4 text-foreground-subtle">
          우선순위
        </label>
        {mode === 'priority' ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit(actions.setAccountPriority(provider, account.name, Number(priority)));
            }}
          >
            <input
              id={priorityId}
              type="number"
              step={1}
              min={-99}
              max={99}
              value={priority}
              autoFocus
              aria-label={`${account.name} 우선순위`}
              onChange={(event) => {
                setPriority(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setMode('view');
              }}
              className="h-5 w-full rounded-[4px] bg-background px-1 font-mono text-xs leading-4 text-foreground"
            />
          </form>
        ) : (
          <span className="font-mono text-xs leading-4 font-medium text-foreground-muted">
            {account.priority}
          </span>
        )}
      </div>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          aria-label={`${account.name} 계정 메뉴`}
          className="flex size-7 items-center justify-center rounded-sm text-foreground-subtle hover:bg-surface-hover"
        >
          <Ellipsis aria-hidden className="size-4" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className="z-50 min-w-40 rounded-md bg-popover p-1 outline-1 -outline-offset-1 outline-border-strong"
          >
            {(
              [
                ['우선순위 바꾸기', 'priority'],
                ['로그아웃', 'logout'],
              ] as const
            ).map(([label, next]) => (
              <DropdownMenu.Item
                key={next}
                onSelect={() => {
                  setPriority(String(account.priority));
                  setError(null);
                  setMode(next);
                }}
                className="flex h-8 cursor-default items-center rounded-sm px-2.5 text-[13px] leading-[18px] text-foreground outline-none data-[highlighted]:bg-surface-hover"
              >
                {label}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {error && (
        <p role="alert" className="basis-full text-xs leading-4 text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function WaitingRow({
  prompt,
  onCancel,
}: {
  prompt: NonNullable<LoginState['prompt']>;
  onCancel: () => void;
}) {
  return (
    <div aria-live="polite" className="flex items-center gap-3 px-4 py-3.5">
      <LoaderCircle
        aria-hidden
        className="size-4 shrink-0 text-foreground-muted motion-safe:animate-spin"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {prompt.kind === 'url' ? (
          <>
            <p className="text-sm leading-5 font-medium text-foreground">
              브라우저에서 승인을 기다립니다
            </p>
            <p className="text-xs leading-4 text-foreground-subtle">
              승인하면 이 화면에 계정이 나타납니다. 5분 안에 끝내야 합니다.
            </p>
          </>
        ) : (
          <>
            <p className="text-sm leading-5 font-medium text-foreground">
              {new URL(prompt.url).hostname}에서 아래 코드를 입력합니다
            </p>
            <div className="flex items-center gap-3">
              <span className="font-mono text-[22px] leading-[30px] font-semibold tracking-[2px] text-foreground">
                {prompt.code}
              </span>
              <Countdown expiresAt={prompt.expiresAt} />
            </div>
          </>
        )}
      </div>
      <Button
        variant={prompt.kind === 'url' ? 'ghost' : 'secondary'}
        onClick={() => {
          openInNewTab(prompt.url);
        }}
      >
        <ExternalLink aria-hidden className="size-3.5" />
        {prompt.kind === 'url' ? '주소 다시 열기' : '주소 열기'}
      </Button>
      <Button variant="ghost" onClick={onCancel}>
        취소
      </Button>
    </div>
  );
}

function ApiKeyForm({ provider, onDone }: { provider: AccountProvider; onDone: () => void }) {
  const actions = useActions();
  const [envName, setEnvName] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-2 px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        const name = envName.trim();
        if (!envNamePattern.test(name)) {
          setError('환경변수 이름은 대문자, 숫자, 밑줄로 적습니다. 키 값을 붙여 넣지 않습니다.');
          return;
        }
        setError(null);
        actions
          .addApiKey(provider, name)
          .then(onDone)
          .catch((failure: unknown) => {
            setError(toMessage(failure));
          });
      }}
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-xs leading-4 text-foreground-muted">API 키를 담은 환경변수 이름</span>
        <input
          value={envName}
          autoFocus
          placeholder={`${providerLabels[provider].toUpperCase()}_API_KEY`}
          onChange={(event) => {
            setEnvName(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onDone();
          }}
          className="h-8 rounded-sm bg-background px-2.5 font-mono text-[13px] leading-[18px] text-foreground placeholder:text-foreground-subtle"
        />
      </label>
      <p className="text-xs leading-4 text-foreground-subtle">
        값은 저장하지 않고 서버가 실행할 때 읽습니다.
      </p>
      {error && (
        <p role="alert" className="text-xs leading-4 text-danger">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" variant="secondary">
          저장
        </Button>
        <Button variant="ghost" onClick={onDone}>
          취소
        </Button>
      </div>
    </form>
  );
}

function ProviderCard({
  provider,
  entry,
}: {
  provider: AccountProvider;
  entry?: ProviderAccounts;
}) {
  const actions = useActions();
  const [isAddingKey, setIsAddingKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accounts = entry?.accounts ?? [];
  const login = entry?.login;
  const pending = login?.status === 'pending' ? login.prompt : undefined;
  const failure =
    login?.status === 'failed' || login?.status === 'timeout'
      ? (login.error ?? '로그인에 실패했습니다.')
      : null;
  let note = accounts.length > 0 ? `계정 ${accounts.length}개` : '';
  if (pending) note = pending.kind === 'device' ? '코드 입력 대기' : '로그인 중';

  const startLogin = () => {
    setError(null);
    // 로그인 주소는 서버 응답 뒤에 알 수 있어서, 팝업 차단을 피하려고 클릭 안에서 빈 탭을 먼저 엽니다.
    const tab = provider === 'grok' ? null : window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    actions
      .startLogin(provider)
      .then((state) => {
        if (state.prompt?.url !== undefined && tab) tab.location.href = state.prompt.url;
        else tab?.close();
      })
      .catch((cause: unknown) => {
        tab?.close();
        setError(toMessage(cause));
      });
  };

  return (
    <section className="flex flex-col gap-2.5" aria-label={providerLabels[provider]}>
      <div className="flex items-center gap-2">
        <h2 className="text-[13px] leading-[18px] font-medium text-foreground-muted">
          {providerLabels[provider]}
        </h2>
        <span className="ml-auto text-xs leading-4 text-foreground-subtle">{note}</span>
      </div>
      <div className="flex flex-col divide-y divide-border overflow-hidden rounded-lg bg-surface">
        {accounts.map((account) => (
          <AccountRow key={account.name} provider={provider} account={account} />
        ))}
        {accounts.length === 0 && !pending && (
          <p className="px-4 py-3 text-[13px] leading-[18px] text-foreground-subtle">
            로그인한 계정이 없습니다
          </p>
        )}
        {pending && (
          <WaitingRow
            prompt={pending}
            onCancel={() => {
              actions.cancelLogin(provider).catch((cause: unknown) => {
                setError(toMessage(cause));
              });
            }}
          />
        )}
        {isAddingKey && (
          <ApiKeyForm
            provider={provider}
            onDone={() => {
              setIsAddingKey(false);
            }}
          />
        )}
        {!pending && !isAddingKey && (
          <div className="flex flex-col gap-2 px-4 py-3">
            {(failure ?? error) && (
              <p role="alert" className="text-xs leading-4 text-danger">
                {failure ?? error}
              </p>
            )}
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={startLogin}>
                <LogIn aria-hidden className="size-3.5" />
                구독으로 로그인
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setIsAddingKey(true);
                }}
              >
                <KeyRound aria-hidden className="size-3.5" />
                API 키 추가
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/** 설정의 계정 페이지입니다. 프로바이더마다 로그인한 계정, 남은 한도, 우선순위를 보여 주고 로그인과 로그아웃을 받습니다. */
export function AccountsPage() {
  const { accounts } = useStore();
  const actions = useActions();
  return (
    <div className="flex flex-1 flex-col items-center overflow-y-auto pt-[72px] pb-12">
      <div className="flex w-[640px] max-w-full flex-col gap-6">
        <header className="flex flex-col gap-1.5">
          <h1 className="text-2xl leading-8 font-semibold text-foreground">계정</h1>
          <p className="text-[13px] leading-[18px] text-foreground-subtle">
            새 세션은 순위가 높은 계정부터 씁니다. 한도에 걸리거나 남은 한도가 예비분 아래로
            내려가면 다음 계정으로 넘어갑니다.
          </p>
        </header>
        {accounts.status === 'loading' && (
          <p className="text-[13px] leading-[18px] text-foreground-subtle">
            계정을 불러오는 중입니다
          </p>
        )}
        {accounts.status === 'error' && (
          <div role="alert" className="flex items-center gap-3">
            <p className="text-[13px] leading-[18px] text-danger">
              계정을 불러오지 못했습니다. {accounts.errorMessage}
            </p>
            <Button
              variant="secondary"
              onClick={() => {
                actions.refreshAccounts().catch(() => undefined);
              }}
            >
              다시 시도
            </Button>
          </div>
        )}
        {accounts.status !== 'loading' &&
          providerOrder.map((provider) => (
            <ProviderCard
              key={provider}
              provider={provider}
              entry={accounts.providers.find((item) => item.provider === provider)}
            />
          ))}
      </div>
    </div>
  );
}
