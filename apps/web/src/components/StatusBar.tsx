import type { AccountProvider, AccountView } from '@ora/protocol';
import { Loader, SquareTerminal } from 'lucide-react';
import { cn } from '../lib/cn.ts';
import { runningStatuses } from '../lib/status.ts';
import { listWorktrees } from '../lib/worktrees.ts';
import { useStore } from '../store.tsx';

const providerName: Record<AccountProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  grok: 'Grok',
};

/** 사용량 막대 하나입니다. 남은 한도(`remainingPct`)를 쓴 비율로 바꿔 퍼센트 글자와 함께 보입니다. */
function UsageBar({ label, remainingPct }: { label: string; remainingPct: number }) {
  const used = 100 - Math.round(remainingPct);
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden className="h-1 w-12 overflow-hidden rounded-full bg-surface-hover">
        <span
          className="block h-full rounded-full bg-foreground-muted"
          style={{ width: `${used}%` }}
        />
      </span>
      <span>
        {label} {used}%
      </span>
    </span>
  );
}

function AccountUsage({ name, account }: { name: string; account: AccountView }) {
  const windows = [
    { label: '5시간', window: account.fiveHour },
    { label: '7일', window: account.sevenDay },
  ].flatMap(({ label, window }) => (window ? [{ label, remainingPct: window.remainingPct }] : []));
  return (
    <div className="flex items-center gap-2 border-r border-border pr-4.5 last:border-r-0">
      <span className="font-medium">{name}</span>
      {account.status === 'expired' && <span>다시 로그인 필요</span>}
      {account.status !== 'expired' && windows.length === 0 && (
        <span className="text-foreground-subtle">측정 안 함</span>
      )}
      {account.status !== 'expired' &&
        windows.map(({ label, remainingPct }) => (
          <UsageBar key={label} label={label} remainingPct={remainingPct} />
        ))}
    </div>
  );
}

/**
 * 창 전체 폭의 하단 상태 줄입니다. 왼쪽에 계정별 사용량, 오른쪽에 실행 중인 세션과 터미널 수를 보입니다.
 * 사용량은 `/api/accounts`가 준 남은 한도를 쓰고, 한도를 읽지 못한 계정은 "측정 안 함"으로 보입니다.
 */
export function StatusBar() {
  const store = useStore();
  const worktrees = listWorktrees(store.sidebar.repos);
  const runningSessions = worktrees.reduce(
    (sum, { node }) =>
      sum + node.sessions.filter((session) => runningStatuses.has(session.record.status)).length,
    0,
  );
  const terminalIds = new Set(
    worktrees.flatMap(({ cwd }) =>
      (store.getTabs(cwd)?.tabs ?? []).flatMap((tab) =>
        tab.kind === 'terminal' && store.getTerminal(tab.terminalId)?.status === 'running'
          ? [tab.terminalId]
          : [],
      ),
    ),
  );
  const accounts = store.accounts.providers.flatMap(({ provider, accounts: list }) =>
    list.map((account) => ({
      key: `${provider}/${account.name}`,
      name: list.length > 1 ? `${providerName[provider]} ${account.name}` : providerName[provider],
      account,
    })),
  );
  return (
    <footer
      aria-label="앱 상태"
      className="flex h-7 shrink-0 items-center gap-4.5 border-t border-border bg-titlebar px-3.5 text-xs leading-4 text-foreground-muted"
    >
      {accounts.map(({ key, name, account }) => (
        <AccountUsage key={key} name={name} account={account} />
      ))}
      <div className="ml-auto flex items-center gap-4.5">
        <span className="flex items-center gap-1.5">
          <Loader
            aria-hidden
            className={cn(
              'size-3.5 text-foreground-subtle',
              runningSessions > 0 && 'motion-safe:animate-spin',
            )}
          />
          세션 {runningSessions}개 실행 중
        </span>
        <span className="flex items-center gap-1.5">
          <SquareTerminal aria-hidden className="size-3.5 text-foreground-subtle" />
          터미널 {terminalIds.size}
        </span>
      </div>
    </footer>
  );
}
