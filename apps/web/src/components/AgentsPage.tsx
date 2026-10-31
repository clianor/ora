import {
  Bot,
  ExternalLink,
  FolderOpen,
  Hammer,
  ScanEye,
  Telescope,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { useEffect } from 'react';
import type { AgentSummary } from '@ora/protocol';
import { runAction, useStore } from '../store.tsx';
import { Button } from '../ui/button.tsx';
import { PageShell } from './SettingsPages.tsx';

const agentIcons: Record<string, LucideIcon> = {
  scout: Telescope,
  task: Hammer,
  reviewer: ScanEye,
};

const cardClass =
  'flex flex-col divide-y divide-border-strong rounded-lg border border-border bg-surface';
const badgeClass =
  'rounded-sm bg-surface-hover px-1.5 text-[11px] leading-[18px] text-foreground-muted';

/** 허용 도구 목록을 한 줄 글로 줄입니다. `tier:`는 티어 전체, `*`는 모든 도구입니다. */
function describeTools(tools: readonly string[]): string {
  if (tools.includes('*')) return '모든 도구';
  const tiers = tools.flatMap((entry) => (entry.startsWith('tier:') ? [entry.slice(5)] : []));
  if (tiers.length !== tools.length) return tools.join(', ');
  if (tiers.length === 1 && tiers[0] === 'read') return '읽기 도구만';
  const labels: Record<string, string> = { read: '읽기', write: '쓰기', exec: '셸' };
  return tiers.map((tier) => labels[tier] ?? tier).join('·');
}

function Group({
  title,
  path,
  children,
}: {
  title: string;
  path?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] leading-[18px] font-medium text-foreground-muted">{title}</h2>
        {path !== undefined && (
          <span className="font-mono text-xs leading-4 text-foreground-subtle">{path}</span>
        )}
      </div>
      {children}
    </section>
  );
}

function AgentRow({ agent, cwd }: { agent: AgentSummary; cwd: string | undefined }) {
  const { actions } = useStore();
  const Icon = agentIcons[agent.name] ?? Bot;
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <Icon aria-hidden className="size-4 shrink-0 text-foreground-muted" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm leading-5 font-semibold text-foreground">
            {agent.name}
          </span>
          {agent.overridesBuiltin && <span className={badgeClass}>기본 제공 정의를 덮어씀</span>}
          {agent.isShadowed && (
            <span className={badgeClass}>
              {agent.scope === 'builtin'
                ? '같은 이름의 정의 파일이 덮어씀'
                : '프로젝트 정의가 가림'}
            </span>
          )}
        </div>
        <p className="text-xs leading-[18px] text-foreground-muted">{agent.description}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={badgeClass}>역할 {agent.role}</span>
          <span className={badgeClass}>{describeTools(agent.tools)}</span>
          <span className={badgeClass}>최대 스텝 {agent.maxSteps}</span>
        </div>
      </div>
      {agent.path !== undefined && (
        <Button
          variant="ghost"
          onClick={() => {
            if (agent.path !== undefined) runAction(actions.openPath(agent.path, cwd));
          }}
        >
          <ExternalLink aria-hidden className="size-3.5" />
          파일 열기
        </Button>
      )}
    </li>
  );
}

function AgentList({
  agents,
  empty,
  cwd,
}: {
  agents: readonly AgentSummary[];
  empty: string;
  cwd: string | undefined;
}) {
  if (agents.length === 0) {
    return <p className="text-[13px] leading-5 text-foreground-muted">{empty}</p>;
  }
  return (
    <ul className={cardClass}>
      {agents.map((agent) => (
        <AgentRow key={`${agent.scope}-${agent.name}`} agent={agent} cwd={cwd} />
      ))}
    </ul>
  );
}

/** 설정의 에이전트 페이지입니다. 정의는 읽기만 하고, 파일은 폴더에서 직접 고칩니다. */
export function AgentsPage({ cwd }: { cwd: string | undefined }) {
  const { agents, actions } = useStore();

  /** 프로젝트 정의는 고른 워크트리의 폴더에 있어서, 페이지를 열 때와 워크트리가 바뀔 때 서버에서 다시 읽어야 합니다. */
  useEffect(() => {
    actions.refreshAgents(cwd).catch(() => undefined);
  }, [actions, cwd]);

  const list = agents.list;
  return (
    <PageShell
      title="에이전트"
      description="세션이 일을 나눠 맡길 때 쓰는 하위 세션의 정의입니다. 하위 세션은 이 세션이 허용한 권한을 넘지 못하고, 결과는 맡긴 세션이 다시 검증합니다."
    >
      {agents.status === 'error' && (
        <p role="alert" className="text-xs leading-4 text-danger">
          {agents.errorMessage}{' '}
          <Button
            variant="ghost"
            onClick={() => {
              actions.refreshAgents(cwd).catch(() => undefined);
            }}
          >
            다시 시도
          </Button>
        </p>
      )}
      {agents.status === 'loading' && (
        <p className="text-[13px] leading-5 text-foreground-muted">불러오는 중입니다.</p>
      )}
      {list !== undefined && (
        <>
          <Group
            title={cwd === undefined ? '이 프로젝트' : `이 프로젝트 · ${list.projectName}`}
            {...(list.projectDir === undefined ? {} : { path: list.projectDir })}
          >
            <AgentList
              agents={list.project}
              empty={
                cwd === undefined
                  ? '워크트리를 고르면 이 프로젝트의 정의가 더 보입니다.'
                  : '이 프로젝트에 정의가 없습니다.'
              }
              cwd={cwd}
            />
          </Group>
          <Group title="기본 제공">
            <AgentList agents={list.builtin} empty="기본 제공 정의가 없습니다." cwd={cwd} />
          </Group>
          <Group title="전역" path={list.globalDir}>
            {list.global.length > 0 ? (
              <AgentList agents={list.global} empty="" cwd={cwd} />
            ) : (
              <div className={`${cardClass} flex-row items-center gap-2.5 px-4 py-3.5`}>
                <p className="flex-1 text-[13px] leading-[18px] text-foreground-subtle">
                  아직 전역 정의가 없습니다. 이 폴더에 .md 파일을 두면 모든 프로젝트에서 씁니다.
                </p>
                <Button
                  variant="ghost"
                  onClick={() => {
                    runAction(actions.openPath(list.globalDir, cwd));
                  }}
                >
                  <FolderOpen aria-hidden className="size-3.5" />
                  폴더 열기
                </Button>
              </div>
            )}
          </Group>
          {list.errors.length > 0 && (
            <Group title="건너뛴 정의">
              <ul className={cardClass}>
                {list.errors.map((error) => (
                  <li
                    key={`${error.scope}-${error.file}`}
                    className="flex items-start gap-2.5 px-4 py-3"
                  >
                    <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="font-mono text-[13px] leading-5 text-foreground">
                        {error.file}
                        <span className="ml-2 font-sans text-xs text-foreground-subtle">
                          {error.scope === 'project' ? '프로젝트' : '전역'}
                        </span>
                      </span>
                      <span className="text-xs leading-[18px] text-warning">{error.reason}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </Group>
          )}
        </>
      )}
    </PageShell>
  );
}
