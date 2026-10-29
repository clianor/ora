import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Ellipsis,
  LoaderCircle,
  RefreshCw,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { DropdownMenu, RadioGroup, Switch } from 'radix-ui';
import { useId, useState } from 'react';
import type { McpServerStatus, McpTransport } from '@ora/protocol';
import { cn } from '../lib/cn.ts';
import { useStore } from '../store.tsx';
import { Button } from '../ui/button.tsx';
import { inputClass, PageShell } from './SettingsPages.tsx';

const stateViews: Record<
  McpServerStatus['state'],
  { icon: LucideIcon; label: string; className: string }
> = {
  connected: { icon: CircleCheck, label: '연결됨', className: 'text-success' },
  connecting: { icon: LoaderCircle, label: '연결 중', className: 'text-foreground-muted' },
  unreachable: { icon: CircleAlert, label: '응답 없음 · 도구 끔', className: 'text-warning' },
  disabled: { icon: CircleDashed, label: '꺼 둠', className: 'text-foreground-subtle' },
};

function describeTools(server: McpServerStatus): string {
  if (server.toolCount === undefined) return '—';
  if (server.enabledToolCount === server.toolCount) return `${server.toolCount}개`;
  return `${server.enabledToolCount} / ${server.toolCount}개`;
}

function ServerRow({
  server,
  onError,
}: {
  server: McpServerStatus;
  onError: (message: string) => void;
}) {
  const { actions } = useStore();
  const { icon: StateIcon, label, className } = stateViews[server.state];
  const run = (request: Promise<void>) => {
    request.catch((error: unknown) => {
      onError(error instanceof Error ? error.message : String(error));
    });
  };
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm leading-5 font-semibold text-foreground">
              {server.name}
            </span>
            <span className="rounded-sm bg-surface-hover px-1.5 text-[11px] leading-[18px] text-foreground-muted">
              {server.transport === 'stdio' ? 'stdio' : 'HTTP'}
            </span>
          </div>
          <span className="truncate font-mono text-xs leading-4 text-foreground-subtle">
            {server.target}
          </span>
        </div>
        <div className="flex w-[110px] shrink-0 flex-col gap-0.5">
          <span className="text-xs leading-4 text-foreground-subtle">도구</span>
          <span className="font-mono text-xs leading-4 font-medium text-foreground-muted">
            {describeTools(server)}
          </span>
        </div>
        <span
          className={cn(
            'flex w-[150px] shrink-0 items-center gap-1.5 text-xs leading-4 font-medium',
            className,
          )}
        >
          <StateIcon
            aria-hidden
            className={cn('size-3.5', server.state === 'connecting' && 'animate-spin')}
          />
          {label}
        </span>
        <Switch.Root
          checked={server.enabled}
          aria-label={`${server.name} 서버 사용`}
          onCheckedChange={(next) => {
            run(actions.setMcpServerEnabled(server.name, next));
          }}
          className={cn(
            'flex h-[18px] w-8 shrink-0 items-center rounded-full px-0.5 transition-colors duration-(--duration-fast) ease-(--ease-out)',
            server.enabled ? 'bg-primary' : 'bg-surface-hover',
          )}
        >
          <Switch.Thumb className="block size-3.5 rounded-full bg-background transition-transform duration-(--duration-fast) ease-(--ease-out) data-[state=checked]:translate-x-3.5 data-[state=unchecked]:bg-foreground-muted" />
        </Switch.Root>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            aria-label={`${server.name} 서버 메뉴`}
            className="flex size-7 shrink-0 items-center justify-center rounded-sm text-foreground-muted hover:bg-surface-hover"
          >
            <Ellipsis aria-hidden className="size-4" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              className="min-w-32 rounded-lg border border-border bg-surface p-1 shadow-lg"
            >
              <DropdownMenu.Item
                onSelect={() => {
                  run(actions.removeMcpServer(server.name));
                }}
                className="flex h-8 items-center gap-2 rounded-sm px-2.5 text-[13px] leading-[18px] text-danger outline-none data-highlighted:bg-surface-hover"
              >
                <Trash2 aria-hidden className="size-3.5" />
                삭제
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      {server.state === 'unreachable' && server.lastFailure !== undefined && (
        <div className="flex items-center gap-2.5 rounded-sm bg-background px-3 py-2.5">
          <p className="flex-1 text-xs leading-[18px] text-foreground-muted">
            {server.lastFailure.at.slice(11, 16)} {server.lastFailure.reason} 이 서버의 도구만 껐고,
            세션은 계속 진행합니다.
          </p>
          <Button
            variant="secondary"
            onClick={() => {
              run(actions.reconnectMcpServer(server.name));
            }}
          >
            <RefreshCw aria-hidden className="size-3.5" />
            다시 연결
          </Button>
        </div>
      )}
    </li>
  );
}

function AddServerForm({ onError }: { onError: (message: string) => void }) {
  const { actions } = useStore();
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<McpTransport>('stdio');
  const [target, setTarget] = useState('');
  const [envNames, setEnvNames] = useState('');
  const nameId = useId();
  const targetId = useId();
  const envId = useId();
  const reset = () => {
    setName('');
    setTarget('');
    setEnvNames('');
  };
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onError('');
        const envRefs = envNames.split(/[\s,]+/).filter((entry) => entry !== '');
        actions
          .addMcpServer({
            name: name.trim(),
            transport,
            envRefs,
            ...(transport === 'stdio' ? { command: target } : { url: target.trim() }),
          })
          .then(reset)
          .catch((error: unknown) => {
            onError(error instanceof Error ? error.message : String(error));
          });
      }}
    >
      <div className="flex items-end gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label htmlFor={nameId} className="text-xs leading-4 font-medium text-foreground-muted">
            이름
          </label>
          <input
            id={nameId}
            value={name}
            placeholder="예: figma"
            onChange={(event) => {
              setName(event.target.value);
            }}
            className={cn(inputClass, 'h-[34px] font-mono')}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span
            id={`${nameId}-transport`}
            className="text-xs leading-4 font-medium text-foreground-muted"
          >
            전송 방식
          </span>
          <RadioGroup.Root
            value={transport}
            aria-labelledby={`${nameId}-transport`}
            orientation="horizontal"
            onValueChange={(value) => {
              setTransport(value as McpTransport);
            }}
            className="flex h-[34px] items-center gap-0.5 rounded-sm bg-background p-0.5"
          >
            {(['stdio', 'http'] as const).map((value) => (
              <RadioGroup.Item
                key={value}
                value={value}
                className="h-[30px] rounded-sm px-3 text-[13px] leading-[18px] font-medium text-foreground-muted aria-checked:bg-surface-hover aria-checked:text-foreground"
              >
                {value === 'stdio' ? 'stdio' : 'HTTP'}
              </RadioGroup.Item>
            ))}
          </RadioGroup.Root>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={targetId} className="text-xs leading-4 font-medium text-foreground-muted">
          {transport === 'stdio' ? '실행 명령' : '주소'}
        </label>
        <input
          id={targetId}
          value={target}
          placeholder={
            transport === 'stdio' ? '예: npx -y figma-mcp' : '예: https://mcp.example.com/mcp'
          }
          onChange={(event) => {
            setTarget(event.target.value);
          }}
          className={cn(inputClass, 'h-[34px] font-mono')}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={envId} className="text-xs leading-4 font-medium text-foreground-muted">
          환경변수 이름
        </label>
        <input
          id={envId}
          value={envNames}
          placeholder="예: FIGMA_TOKEN"
          onChange={(event) => {
            setEnvNames(event.target.value);
          }}
          className={cn(inputClass, 'h-[34px] font-mono')}
        />
        <p className="text-xs leading-4 text-foreground-subtle">
          값은 여기에 적지 않습니다. Ora는 실행할 때 환경변수에서 읽습니다.
          {transport === 'http' && ' HTTP 서버에는 Authorization: Bearer 헤더로 보냅니다.'}
        </p>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={reset}>
          취소
        </Button>
        <Button variant="primary" type="submit">
          추가하고 연결
        </Button>
      </div>
    </form>
  );
}

/** 설정의 MCP 페이지입니다. 서버 목록은 이 화면의 조작으로만 바뀌고, 모델 도구는 바꾸지 못합니다. */
export function McpPage() {
  const { mcpServers, actions } = useStore();
  const [message, setMessage] = useState('');
  return (
    <PageShell
      title="MCP"
      description="외부 도구 서버를 연결합니다. 서버의 도구도 권한 모드와 승인 규칙을 똑같이 따르고, 이름은 서버명:도구명으로 보입니다."
    >
      <section className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] leading-[18px] font-medium text-foreground-muted">서버</h2>
          <span className="text-xs leading-4 text-foreground-subtle">
            {mcpServers.servers.length}개
          </span>
        </div>
        {mcpServers.status === 'error' && (
          <p role="alert" className="text-xs leading-4 text-danger">
            {mcpServers.errorMessage}{' '}
            <Button
              variant="ghost"
              onClick={() => {
                actions.refreshMcpServers().catch(() => undefined);
              }}
            >
              다시 시도
            </Button>
          </p>
        )}
        {mcpServers.status === 'loading' && (
          <p className="text-[13px] leading-5 text-foreground-muted">불러오는 중입니다.</p>
        )}
        {mcpServers.servers.length > 0 && (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
            {mcpServers.servers.map((server) => (
              <ServerRow key={server.name} server={server} onError={setMessage} />
            ))}
          </ul>
        )}
        {mcpServers.status === 'ready' && mcpServers.servers.length === 0 && (
          <p className="text-[13px] leading-5 text-foreground-muted">연결한 서버가 없습니다.</p>
        )}
      </section>
      <section className="flex flex-col gap-2.5">
        <h2 className="text-[13px] leading-[18px] font-medium text-foreground-muted">서버 추가</h2>
        <AddServerForm onError={setMessage} />
        {message !== '' && (
          <p role="alert" className="text-xs leading-4 text-danger">
            {message}
          </p>
        )}
      </section>
    </PageShell>
  );
}
