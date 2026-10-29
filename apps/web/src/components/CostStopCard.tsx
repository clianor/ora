import { Gauge, OctagonPause } from 'lucide-react';
import { useId } from 'react';
import { navigateToSettings } from '../lib/route.ts';
import { formatCostRatio, type CostStop } from '../lib/cost.ts';
import { Button } from '../ui/button.tsx';

interface CostStopCardProps {
  stop: CostStop;
  ratioPct?: number;
  remainingTodos: number;
}

/** 비용 상한이나 단가 누락으로 멈춘 세션의 대화 끝에 놓는 안내입니다. 금액 없이 비율만 말합니다. */
export function CostStopCard({ stop, ratioPct, remainingTodos }: CostStopCardProps) {
  const isMissing = stop.reason === 'pricing_missing';
  const learnText = stop.isLearnSkipped ? ' Learn 단계는 건너뛰었습니다.' : '';
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex items-center gap-2">
        <OctagonPause aria-hidden className="size-4 text-warning" />
        <h2 id={titleId} className="text-sm leading-5 font-semibold text-foreground">
          {isMissing ? '모델 단가가 없어 멈췄습니다' : '비용 상한에 닿아 멈췄습니다'}
        </h2>
        {!isMissing && ratioPct !== undefined && (
          <span className="ml-auto font-mono text-xs leading-4 font-medium text-warning">
            상한의 {formatCostRatio(ratioPct)}
          </span>
        )}
      </div>
      <p className="text-[13px] leading-5 text-foreground-muted">
        {isMissing
          ? `${stop.model ?? '이 모델'}의 단가가 설정에 없어 요청을 보내지 않았습니다.`
          : '다음 모델 요청을 보내지 않았습니다.'}{' '}
        남은 할 일은 {remainingTodos}개입니다.{learnText}
      </p>
      <p className="text-[13px] leading-5 text-foreground-muted">
        {isMissing
          ? '설정에서 단가를 입력하고 지시를 보내면 이어 갑니다.'
          : '상한을 올리거나 지시를 바꿔 보내면 이어 갑니다. 지금까지 쓴 양은 그대로 이어받습니다.'}
      </p>
      <div className="flex items-center justify-end">
        <Button
          onClick={() => {
            navigateToSettings('cost');
          }}
        >
          <Gauge aria-hidden className="size-3.5" />
          비용 상한 설정 열기
        </Button>
      </div>
    </section>
  );
}
