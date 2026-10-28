import { Tooltip } from 'radix-ui';
import { formatPercent, formatTokens, totalInput, type CacheView } from '../lib/cache.ts';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 text-xs leading-4">
      <span className="w-[72px] shrink-0 text-foreground-muted">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </div>
  );
}

/** 상태 표시줄의 "캐시 적중" 항목입니다. 마우스를 올리거나 키보드로 포커스하면 위쪽에 상세 카드를 엽니다. */
export function CacheStat({ cache }: { cache: CacheView }) {
  const percent = formatPercent(cache.rate);
  const { session, last } = cache;
  return (
    <Tooltip.Provider delayDuration={0}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            aria-label={`프롬프트 캐시 적중률 ${percent}, 자세히 보기`}
            className="rounded-sm text-xs leading-4 text-foreground-subtle"
          >
            캐시 적중 {percent}
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
              <span>프롬프트 캐시</span>
              <span className="ml-auto font-mono">{percent}</span>
            </div>
            <div className="h-1 rounded-[2px] bg-border-strong">
              <div
                className="h-full rounded-[2px] bg-foreground-muted"
                style={{ width: `${cache.rate * 100}%` }}
              />
            </div>
            <Row
              label="세션 누적"
              value={`읽기 ${formatTokens(session.read)} / 입력 ${formatTokens(totalInput(session))}`}
            />
            {last && (
              <Row
                label="마지막 요청"
                value={`읽기 ${formatTokens(last.read)} · 쓰기 ${formatTokens(last.creation)} · 새 ${formatTokens(last.uncached)}`}
              />
            )}
            {cache.ttl && <Row label="유지 시간" value={cache.ttl} />}
            <p className="text-xs leading-4 text-foreground-muted">
              적중한 토큰은 모델이 다시 처리하지 않습니다. 응답이 빨라지고 구독 사용량이 줄어듭니다.
            </p>
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
