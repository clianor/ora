import type { SessionStatus } from '@ora/protocol';
import { CircleCheck, CirclePause, CircleX, Loader, ShieldAlert } from 'lucide-react';
import { cn } from '../lib/cn.ts';
import { statusKindOf, statusLabel } from '../lib/status.ts';

const iconOf = {
  '실행 중': { Icon: Loader, color: 'text-foreground-muted' },
  '승인 대기': { Icon: ShieldAlert, color: 'text-warning' },
  완료: { Icon: CircleCheck, color: 'text-success' },
  실패: { Icon: CircleX, color: 'text-danger' },
  멈춤: { Icon: CirclePause, color: 'text-warning' },
} as const;

/** 세션 상태를 아이콘과 색으로 보입니다. 색만으로 알리지 않도록 화면 낭독기가 읽을 이름도 붙입니다. */
export function StatusIcon({ status, className }: { status: SessionStatus; className?: string }) {
  const { Icon, color } = iconOf[statusKindOf[status]];
  return (
    <Icon
      role="img"
      aria-label={statusLabel[status]}
      className={cn(
        'size-3.5 shrink-0',
        color,
        Icon === Loader && 'motion-safe:animate-spin',
        className,
      )}
    />
  );
}
