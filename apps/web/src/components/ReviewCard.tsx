import type { OraEvent } from '@ora/protocol';
import { CircleAlert, CircleCheck, ScanEye, TriangleAlert } from 'lucide-react';
import { useId } from 'react';
import { cn } from '../lib/cn.ts';

type ReviewPayload = Extract<OraEvent, { type: 'review' }>['payload'];

const severityBadge = {
  major: { label: '중요', className: 'text-warning' },
  minor: { label: '참고', className: 'text-foreground-muted' },
};

/** 다른 모델의 검토 결과 카드입니다. 건너뛰었거나 응답을 받지 못했으면 이유를 대화에 한 줄로만 적습니다. */
export function ReviewNote({ data }: { data: unknown }) {
  const review = data as ReviewPayload;
  const titleId = useId();
  if (review.outcome === 'skipped') {
    return (
      <p
        role="status"
        className="flex items-center gap-2 text-[13px] leading-5 text-foreground-muted"
      >
        <ScanEye aria-hidden className="size-3.5 shrink-0" />
        <span>다른 모델의 검토를 건너뛰었습니다 · {review.reason}</span>
      </p>
    );
  }
  if (review.outcome === 'failed') {
    return (
      <p role="status" className="flex items-center gap-2 text-[13px] leading-5 text-warning">
        <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
        <span>
          {review.model}의 검토 결과를 받지 못했습니다 · {review.reason} 할 일 판정에는 영향이
          없습니다
        </span>
      </p>
    );
  }
  const isChanges = review.verdict === 'changes';
  const StatusIcon = isChanges ? CircleAlert : CircleCheck;
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex items-center gap-2">
        <ScanEye aria-hidden className="size-4 text-foreground-muted" />
        <h2 id={titleId} className="text-sm leading-5 font-semibold text-foreground">
          다른 모델의 검토
        </h2>
        <span className="ml-auto flex items-center gap-1.5 text-xs leading-4 text-foreground-subtle">
          검토 모델
          <span className="font-mono font-medium text-foreground-muted">{review.model}</span>
        </span>
      </div>
      <p
        className={cn(
          'flex items-center gap-2 text-[13px] leading-[18px]',
          isChanges ? 'text-warning' : 'text-success',
        )}
      >
        <StatusIcon aria-hidden className="size-[15px] shrink-0" />
        <span className="font-semibold">{isChanges ? '고칠 점 있음' : '통과'}</span>
        <span className="font-normal text-foreground-muted">
          · {review.findings.length === 0 ? '지적 없음' : `지적 ${review.findings.length}건`}
        </span>
      </p>
      {review.findings.length > 0 && (
        <ul className="flex flex-col gap-2">
          {review.findings.map((finding, index) => (
            <li key={index} className="flex items-start gap-2.5">
              <span
                className={cn(
                  'shrink-0 rounded-sm border border-border px-1.5 text-xs leading-5 font-semibold',
                  severityBadge[finding.severity].className,
                )}
              >
                {severityBadge[finding.severity].label}
              </span>
              <span className="min-w-0 grow text-[13px] leading-5 text-foreground">
                {finding.text}
              </span>
              {finding.location !== undefined && (
                <span className="shrink-0 font-mono text-xs leading-5 text-foreground-subtle">
                  {finding.location}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs leading-[18px] text-foreground-subtle">
        검토 결과는 증거로 남습니다. 할 일은 검증 명령이 통과해야 끝납니다.
      </p>
    </section>
  );
}
