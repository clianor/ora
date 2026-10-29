import { Tooltip } from 'radix-ui';
import { formatPercent, formatTokens } from '../lib/cache.ts';
import { formatRange, formatWindow, methodLabel, type ContextView } from '../lib/context.ts';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 text-xs leading-4">
      <span className="w-[72px] shrink-0 text-foreground-muted">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </div>
  );
}

/** 상태 표시줄의 "컨텍스트" 항목입니다. 마우스를 올리거나 키보드로 포커스하면 위쪽에 상세 카드를 엽니다. */
export function ContextStat({ context }: { context: ContextView }) {
  const percent = formatPercent(context.rate);
  const { pruned, compaction } = context;
  const last = compaction.last;
  const prunedText =
    pruned.count === 0
      ? '없음'
      : `도구 출력 ${pruned.count}개${pruned.savedTokens > 0 ? ` · ${formatTokens(pruned.savedTokens)} 줄임` : ''}`;
  const compactionText = last
    ? `${compaction.count}회 · ${methodLabel[last.method]} · ${formatRange(last.range)}`
    : '없음';
  return (
    <Tooltip.Provider delayDuration={0}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            aria-label={`컨텍스트 사용 ${percent}, 자세히 보기`}
            className="rounded-sm text-xs leading-4 text-foreground-subtle"
          >
            컨텍스트 {percent}
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            align="start"
            sideOffset={4}
            className="flex w-[340px] flex-col gap-2.5 rounded-md bg-popover p-3 outline-1 -outline-offset-1 outline-border-strong"
          >
            <div className="flex items-center text-xs leading-4 font-semibold text-foreground">
              <span>컨텍스트</span>
              <span className="ml-auto font-mono">{percent}</span>
            </div>
            <div className="h-1 rounded-[2px] bg-border-strong">
              <div
                className="h-full rounded-[2px] bg-foreground-muted"
                style={{ width: `${Math.min(context.rate, 1) * 100}%` }}
              />
            </div>
            <Row
              label="사용"
              value={`${formatTokens(context.used)} / ${formatWindow(context.window)} 토큰`}
            />
            <Row
              label="압축 기준"
              value={`${formatPercent(context.compactAtRatio)} · ${formatWindow(context.window * context.compactAtRatio)}`}
            />
            <Row label="생략" value={prunedText} />
            <Row label="압축" value={compactionText} />
            <p className="text-xs leading-4 text-foreground-muted">
              {formatPercent(context.compactAtRatio)}에 닿으면 오래된 도구 출력부터 생략하고, 그래도
              넘치면 앞부분을 인계 문서로 바꿉니다. 최근 {formatWindow(context.keepRecentTokens)}{' '}
              토큰과 할 일·검증 증거는 그대로 둡니다. 모델은 생략한 원문을 다시 읽을 수 있습니다.
            </p>
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
