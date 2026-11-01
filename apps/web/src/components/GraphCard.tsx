import {
  ChevronRight,
  CircleCheck,
  CircleX,
  GitCommitHorizontal,
  Hammer,
  Loader,
  LoaderCircle,
  OctagonPause,
  ScanEye,
  ShieldCheck,
  Telescope,
  Workflow,
  Wrench,
  Circle,
  Bot,
  type LucideIcon,
} from 'lucide-react';
import { MAX_GRAPH_NODE_RETRIES } from '@ora/protocol';
import type { GraphCardData, GraphNodeView, GraphSubmitData } from '../events.ts';
import { cn } from '../lib/cn.ts';
import { hashFor } from '../lib/route.ts';

const agentIcons: Record<string, LucideIcon> = {
  scout: Telescope,
  task: Hammer,
  reviewer: ScanEye,
};

interface StateView {
  Icon: LucideIcon;
  label: string;
  color: string;
}

/** 상태마다 아이콘 모양과 글자가 달라 색 없이도 구분합니다. 같은 `running`이라도 시도 번호가 2 이상이면 다시 시도입니다. */
function getStateView(node: GraphNodeView): StateView {
  const isRetry = node.attempt > 1;
  switch (node.state) {
    case 'verified':
      return { Icon: CircleCheck, label: '검증됨', color: 'text-success' };
    case 'failed':
      return { Icon: CircleX, label: '실패', color: 'text-danger' };
    case 'blocked':
      return { Icon: OctagonPause, label: '막힘', color: 'text-warning' };
    case 'verifying':
      return { Icon: ShieldCheck, label: '검증 중', color: 'text-foreground-muted' };
    case 'running':
      return isRetry
        ? { Icon: Wrench, label: '다시 시도 중', color: 'text-warning' }
        : { Icon: Loader, label: '실행 중', color: 'text-foreground-muted' };
    case 'queued':
      return isRetry
        ? { Icon: Wrench, label: '다시 시도 중', color: 'text-warning' }
        : { Icon: Circle, label: '대기', color: 'text-foreground-subtle' };
  }
}

/** 노드 오른쪽 아래 글자입니다. 검증된 노드는 다시 시도한 횟수를, 진행 중인 노드는 `다시 시도 N/3`을 적습니다. */
function getAttemptText(node: GraphNodeView): string {
  if (node.attempt === 0) return '';
  if (node.attempt === 1) return '시도 1';
  if (node.state === 'verified') return `다시 시도 ${String(node.attempt - 1)}회`;
  return `다시 시도 ${String(node.attempt - 1)}/${String(MAX_GRAPH_NODE_RETRIES)}`;
}

function GraphNode({ node }: { node: GraphNodeView }) {
  const { Icon, label, color } = getStateView(node);
  const AgentIcon = agentIcons[node.agent] ?? Bot;
  const isStrong = node.state === 'failed' || node.state === 'blocked' || node.attempt > 1;
  const body = (
    <>
      <span className="flex w-full items-center gap-1.5">
        <span className="font-mono text-[11px] leading-[14px] font-semibold text-foreground-subtle">
          {node.id}
        </span>
        <span className="flex h-5 items-center gap-1 rounded-[5px] bg-surface-hover px-1.5">
          <AgentIcon aria-hidden className="size-[11px] text-foreground-muted" />
          <span className="font-mono text-[11px] leading-[14px] font-semibold text-foreground">
            {node.agent}
          </span>
        </span>
        {node.after.length > 0 && (
          <span className="ml-auto text-[11px] leading-[14px] text-foreground-subtle">
            앞 {node.after.join(', ')}
          </span>
        )}
      </span>
      <span className="line-clamp-2 w-full text-[13px] leading-[18px] font-medium text-foreground">
        {node.title}
      </span>
      <span className="w-full truncate font-mono text-[11px] leading-[14px] text-foreground-subtle">
        {node.scope.length === 0 ? '읽기 전용' : node.scope.join(', ')}
      </span>
      <span className="flex w-full items-center gap-[5px]">
        <Icon
          aria-hidden
          className={cn('size-3 shrink-0', color, Icon === Loader && 'motion-safe:animate-spin')}
        />
        <span className={cn('text-xs leading-4 font-medium', color)}>{label}</span>
        <span className="ml-auto text-[11px] leading-[14px] text-foreground-subtle">
          {getAttemptText(node)}
        </span>
      </span>
    </>
  );
  const className = cn(
    'flex w-full flex-col items-start gap-1.5 rounded-lg border bg-background p-2.5 text-left',
    isStrong ? 'border-border-strong' : 'border-border',
  );
  if (node.childSessionId === undefined) return <div className={className}>{body}</div>;
  return (
    <a
      href={hashFor('worktree', { sessionId: node.childSessionId })}
      aria-label={`${node.id} ${node.title}, ${label}, 하위 세션 열기`}
      className={cn(
        className,
        'transition-colors duration-(--duration-fast) ease-(--ease-out) hover:bg-surface-hover',
      )}
    >
      {body}
    </a>
  );
}

function GraphFooter({
  footer,
  nodeCount,
}: {
  footer: NonNullable<GraphCardData['footer']>;
  nodeCount: number;
}) {
  if (footer.kind === 'lineage') {
    return (
      <p className="flex h-9 items-center gap-2 px-3.5 text-xs leading-4 text-foreground-muted">
        <GitCommitHorizontal aria-hidden className="size-[13px] shrink-0 text-foreground-subtle" />
        <span>
          계보 · 노드 {String(nodeCount)}개 · 시도 {String(footer.attempts)}회 · 기준 커밋
        </span>
        <span className="font-mono font-medium text-foreground">
          {footer.baseCommit?.slice(0, 7) ?? '없음'}
        </span>
        <span className="ml-auto text-foreground-subtle">
          파일 {String(footer.fileCount)}개 · +{String(footer.added)} −{String(footer.deleted)}
        </span>
      </p>
    );
  }
  const isFailed = footer.kind === 'failed';
  const Icon = isFailed ? CircleX : Wrench;
  let title = `${footer.nodeId} 검증 실패 · 다시 시도에 넘긴 진단`;
  if (isFailed) {
    title = `${footer.nodeId} · 다시 시도 ${String(footer.attempt - 1)}회 뒤에도 검증 실패`;
  } else if (footer.attempt === 2) {
    title = `${footer.nodeId} 첫 검증 실패 · 다시 시도에 넘긴 진단`;
  }
  return (
    <div className="flex items-start gap-2 px-3.5 py-2.5">
      <Icon
        aria-hidden
        className={cn('mt-0.5 size-[13px] shrink-0', isFailed ? 'text-danger' : 'text-warning')}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <p className="text-xs leading-4 font-semibold text-foreground">{title}</p>
        <p className="line-clamp-6 font-mono text-xs leading-[18px] break-words whitespace-pre-wrap text-foreground-muted">
          {footer.text}
        </p>
      </div>
    </div>
  );
}

/** 부모 대화의 그래프 카드입니다. 노드를 의존 단계별 열로 놓고 열 사이에 화살표를 둡니다. 노드를 누르면 그 노드의 마지막 하위 세션 탭을 엽니다. */
export function GraphCard({ data }: { data: unknown }) {
  const graph = data as GraphCardData;
  const parts = [
    graph.verifiedCount === graph.nodeCount
      ? '모두 검증됨'
      : [
          ...(graph.verifiedCount > 0 ? [`${String(graph.verifiedCount)}개 검증됨`] : []),
          ...(graph.failedCount > 0 ? [`${String(graph.failedCount)}개 실패`] : []),
        ].join(' · '),
  ].filter(Boolean);
  return (
    <section className="flex flex-col divide-y divide-border rounded-[10px] border border-border bg-surface">
      <h2 className="flex h-[38px] items-center gap-2 px-3.5 text-[13px] leading-[18px] font-semibold text-foreground">
        <Workflow aria-hidden className="size-3.5 text-foreground-muted" />
        {['그래프', `노드 ${String(graph.nodeCount)}개`, ...parts].join(' · ')}
      </h2>
      <div className="flex items-start gap-1.5 p-3">
        {graph.columns.map((column, index) => (
          <div key={column[0]?.id ?? index} className="contents">
            {index > 0 && (
              <ChevronRight
                aria-hidden
                className="mt-14 size-3.5 shrink-0 self-start text-foreground-subtle"
              />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <p className="text-[11px] leading-[14px] font-medium text-foreground-subtle">
                {String(index + 1)}단계
              </p>
              {column.map((node) => (
                <GraphNode key={node.id} node={node} />
              ))}
            </div>
          </div>
        ))}
      </div>
      {graph.footer !== undefined && (
        <GraphFooter footer={graph.footer} nodeCount={graph.nodeCount} />
      )}
    </section>
  );
}

/** 그래프 제출 도구 줄입니다. 엔진이 거부했으면 이유를 줄 아래에 보입니다. */
export function GraphSubmitRow({ data }: { data: unknown }) {
  const submit = data as GraphSubmitData;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex h-7 items-center gap-2">
        <Workflow aria-hidden className="size-[15px] shrink-0 text-foreground-subtle" />
        <span className="shrink-0 text-[13px] leading-[18px] font-medium text-foreground-muted">
          그래프 제출
        </span>
        <span className="min-w-0 truncate font-mono text-[13px] leading-[18px] text-foreground-muted">
          노드 {String(submit.nodeCount)}개
        </span>
        {submit.state === 'running' && (
          <span className="ml-auto flex items-center gap-1.5 text-xs leading-4 font-medium text-foreground-subtle">
            <LoaderCircle aria-hidden className="size-3.5 motion-safe:animate-spin" />
            실행 중
          </span>
        )}
        {submit.state === 'accepted' && (
          <span className="ml-auto text-xs leading-4 font-medium text-success">받아들임</span>
        )}
        {submit.state === 'rejected' && (
          <span className="ml-auto text-xs leading-4 font-medium text-danger">거부됨</span>
        )}
      </div>
      {submit.reason !== undefined && submit.reason !== '' && (
        <p className="pl-[23px] text-xs leading-[18px] text-foreground-subtle">{submit.reason}</p>
      )}
    </div>
  );
}
