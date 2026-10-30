import type { OraEvent } from '@ora/protocol';
import { ArrowRightLeft, X } from 'lucide-react';
import { useState } from 'react';
import { listModelSwitches, type ModelSwitchData } from '../events.ts';
import { useNow } from '../lib/now.ts';

const visibleMs = 8000;

const timeFormat = new Intl.DateTimeFormat('ko-KR', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Asia/Seoul',
});

function describeSwitch({ reason, from, to, resetAt, message }: ModelSwitchData): string {
  const previous = `${from ?? '앞'} 모델`;
  if (reason === 'revert') return `사용 한도가 풀려 ${to} 모델로 돌아왔습니다.`;
  if (reason === 'server-error')
    return `${previous}에서 서버 오류가 이어져 ${to} 모델로 넘어갔습니다.`;
  if (reason === 'error') return `${previous} 요청이 오류로 실패했습니다. ${message ?? ''}`.trim();
  const until =
    resetAt === undefined
      ? ''
      : ` ${timeFormat.format(new Date(resetAt))}에 한도가 풀리면 다시 ${previous}로 돌아갑니다.`;
  return `${previous}이 사용 한도에 걸렸습니다.${until}`;
}

/**
 * 모델이 바뀌면(폴백이나 첫 모델 복귀) 화면 오른쪽 위에 잠시 알림을 띄웁니다.
 * 이 화면을 연 뒤에 도착한 `retry` 이벤트만 알리므로, 다시 불러온 세션의 지난 전환은 띄우지 않습니다.
 */
export function ModelSwitchToast({ events }: { events: readonly OraEvent[] }) {
  const now = useNow();
  const latest = listModelSwitches(events).at(-1);
  const [seen, setSeen] = useState({ seq: latest?.seq ?? 0, at: 0, isDismissed: false });
  if (latest && latest.seq > seen.seq) {
    setSeen({ seq: latest.seq, at: now, isDismissed: false });
  }
  const isVisible =
    latest?.seq === seen.seq && seen.at > 0 && !seen.isDismissed && now - seen.at < visibleMs;
  return (
    <div
      aria-live="polite"
      className="pointer-events-none absolute top-3 right-4 z-50 flex w-[360px] flex-col"
    >
      {latest && isVisible && (
        <div className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border-strong bg-popover p-3">
          <ArrowRightLeft aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-[13px] leading-[18px] font-semibold text-foreground">
              모델을 {latest.to}로 바꿨습니다
            </p>
            <p className="text-xs leading-[18px] text-foreground-muted">{describeSwitch(latest)}</p>
          </div>
          <button
            type="button"
            aria-label="알림 닫기"
            onClick={() => {
              setSeen({ ...seen, isDismissed: true });
            }}
            className="flex size-5 shrink-0 items-center justify-center rounded-sm text-foreground-subtle hover:text-foreground"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
