import { cn } from '../lib/cn.ts';

/** `+N −N` 줄 수 통계입니다. 색과 함께 부호가 증가와 감소를 알립니다. */
export function DiffStat({
  add,
  del,
  className,
}: {
  add: number;
  del: number;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex gap-1.5 font-mono text-xs leading-4 font-medium', className)}>
      <span className="text-success">+{add}</span>
      <span className="text-danger">−{del}</span>
    </span>
  );
}
