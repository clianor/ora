import {
  Bell,
  CircleCheck,
  CircleX,
  Gauge,
  MessageCircleQuestion,
  OctagonPause,
  ShieldCheck,
  Plus,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { Switch } from 'radix-ui';
import { useId, useState } from 'react';
import type { CostSettings } from '@ora/protocol';
import {
  formatNotifyTitle,
  notifyKinds,
  requestPermission,
  sendTestNotification,
  setNotifyEnabled,
  useNotifyPrefs,
  usePermissionState,
  type NotifyKind,
  type PermissionState,
} from '../lib/notify.ts';
import { runAction, useStore } from '../store.tsx';
import { Button } from '../ui/button.tsx';

function PageShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center overflow-y-auto pt-[72px] pb-10">
      <div className="flex w-[640px] max-w-full flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl leading-8 font-semibold text-foreground">{title}</h1>
          <p className="text-[13px] leading-5 text-foreground-muted">{description}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

const kindViews: Record<NotifyKind, { icon: LucideIcon; title: string; description: string }> = {
  approval: {
    icon: ShieldCheck,
    title: '승인 대기',
    description: '명령 실행이나 예외 승인을 기다립니다. 알림을 누르면 그 승인 카드로 갑니다.',
  },
  question: {
    icon: MessageCircleQuestion,
    title: '질문 대기',
    description: '모델이 질문 카드로 답을 기다립니다.',
  },
  done: {
    icon: CircleCheck,
    title: '완료',
    description: '세션이 모든 할 일을 검증하고 끝났습니다.',
  },
  failed: {
    icon: OctagonPause,
    title: '실패·멈춤',
    description: '오류, blocked, 비용 상한이나 최대 스텝으로 멈췄습니다.',
  },
  cost: { icon: Gauge, title: '비용 경고', description: '비용 상한의 경고 비율에 닿았습니다.' },
};

const permissionLabels: Record<PermissionState, string> = {
  granted: '허용됨',
  denied: '거부됨',
  default: '아직 묻지 않음',
  unsupported: '이 브라우저는 알림을 지원하지 않음',
};

function NotifyRow({ kind, isOn }: { kind: NotifyKind; isOn: boolean }) {
  const { icon: Icon, title, description } = kindViews[kind];
  const labelId = useId();
  return (
    <li>
      <Switch.Root
        checked={isOn}
        aria-labelledby={labelId}
        onCheckedChange={(next) => {
          setNotifyEnabled(kind, next);
        }}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-(--duration-fast) ease-(--ease-out) hover:bg-surface-hover"
      >
        <Icon aria-hidden className="size-4 shrink-0 text-foreground-muted" />
        <span className="flex flex-1 flex-col gap-0.5">
          <span id={labelId} className="text-sm leading-5 font-medium text-foreground">
            {title}
          </span>
          <span className="text-xs leading-[18px] text-foreground-subtle">{description}</span>
        </span>
        <span className="text-xs leading-4 font-medium text-foreground-muted">
          {isOn ? '켜짐' : '꺼짐'}
        </span>
        <span
          aria-hidden
          className={`flex h-[18px] w-8 shrink-0 items-center rounded-full px-0.5 transition-colors duration-(--duration-fast) ease-(--ease-out) ${isOn ? 'bg-primary' : 'bg-surface-hover'}`}
        >
          <Switch.Thumb className="block size-3.5 rounded-full bg-background transition-transform duration-(--duration-fast) ease-(--ease-out) data-[state=checked]:translate-x-3.5 data-[state=unchecked]:bg-foreground-muted" />
        </span>
      </Switch.Root>
    </li>
  );
}

function PriceField({
  label,
  value,
  placeholder,
  onChange,
  action,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (next: string) => void;
  action?: React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs leading-4 font-medium text-foreground-subtle">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          value={value}
          placeholder={placeholder}
          inputMode={placeholder === undefined ? 'decimal' : 'text'}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          className={`${inputClass} w-full min-w-0 flex-1`}
        />
        {action}
      </div>
    </div>
  );
}

/** 설정의 알림 페이지입니다. 사건별 켜기는 브라우저에 저장하고, 창을 보고 있지 않을 때만 알림을 보냅니다. */
export function NotificationsPage() {
  const prefs = useNotifyPrefs();
  const permission = usePermissionState();
  const PermissionIcon = permission === 'granted' ? CircleCheck : CircleX;
  return (
    <PageShell
      title="알림"
      description="Ora 창을 보고 있지 않을 때 데스크톱 알림을 보냅니다. 알림을 누르면 해당 세션 탭으로 갑니다. 알림을 꺼도 기록은 남습니다."
    >
      <div className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3.5 py-3">
        <PermissionIcon
          aria-hidden
          className={permission === 'granted' ? 'size-4 text-success' : 'size-4 text-warning'}
        />
        <p className="flex-1 text-[13px] leading-[18px] font-medium text-foreground">
          브라우저 알림 권한: {permissionLabels[permission]}
        </p>
        {permission === 'default' && (
          <Button
            variant="primary"
            onClick={() => {
              runAction(requestPermission());
            }}
          >
            권한 요청
          </Button>
        )}
        <Button
          disabled={permission !== 'granted'}
          onClick={() => {
            sendTestNotification();
          }}
        >
          <Bell aria-hidden className="size-3.5" />
          테스트 알림 보내기
        </Button>
      </div>
      <section className="flex flex-col gap-2.5">
        <h2 className="text-[13px] leading-[18px] font-medium text-foreground-muted">
          알림을 보낼 사건
        </h2>
        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
          {notifyKinds.map((kind) => (
            <NotifyRow key={kind} kind={kind} isOn={prefs[kind]} />
          ))}
        </ul>
      </section>
      <section className="flex flex-col gap-2.5">
        <h2 className="text-[13px] leading-[18px] font-medium text-foreground-muted">미리보기</h2>
        <div className="flex w-[360px] max-w-full items-start gap-2.5 rounded-xl bg-popover p-3 outline-1 -outline-offset-1 outline-border-strong">
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-hover text-[15px] font-bold text-foreground"
          >
            O
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="text-[13px] leading-[18px] font-semibold text-foreground">
              {formatNotifyTitle('math-demo')}
            </p>
            <p className="text-[13px] leading-[18px] font-medium text-foreground">
              승인이 필요합니다
            </p>
            <p className="text-xs leading-[18px] text-foreground-muted">
              add 함수 버그 수정 · $ node check.js
            </p>
          </div>
        </div>
      </section>
    </PageShell>
  );
}

interface PricingDraft {
  key: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
}

const inputClass =
  'h-8 min-w-0 rounded-sm bg-background px-2.5 text-[13px] leading-[18px] text-foreground outline-1 -outline-offset-1 outline-border placeholder:text-foreground-subtle';

function toNumber(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : Number.NaN;
}

function toSettings(max: string, warn: string, rows: PricingDraft[]): CostSettings | string {
  const maxCost = toNumber(max);
  const warnCost = toNumber(warn);
  if (Number.isNaN(maxCost) || Number.isNaN(warnCost) || maxCost === 0 || warnCost === 0) {
    return '상한과 경고 값은 0보다 큰 숫자로 적습니다. 비우면 설정하지 않습니다.';
  }
  if (maxCost !== undefined && warnCost !== undefined && warnCost > maxCost) {
    return '경고 값은 상한 이하여야 합니다.';
  }
  const pricing: CostSettings['pricing'] = {};
  for (const row of rows) {
    if (!/^[^/\s]+\/\S+$/.test(row.key.trim())) {
      return '모델은 <프로바이더>/<모델> 형식으로 적습니다. 예: claude/claude-sonnet-5-5';
    }
    const input = toNumber(row.input);
    const output = toNumber(row.output);
    const cacheReadPerMTok = toNumber(row.cacheRead);
    const cacheWritePerMTok = toNumber(row.cacheWrite);
    if (input === undefined || output === undefined || [input, output].some(Number.isNaN)) {
      return `${row.key}의 입력·출력 단가를 0 이상의 숫자로 적습니다.`;
    }
    if (Number.isNaN(cacheReadPerMTok) || Number.isNaN(cacheWritePerMTok)) {
      return `${row.key}의 캐시 단가는 0 이상의 숫자이거나 비워 둡니다.`;
    }
    pricing[row.key.trim()] = {
      inputPerMTok: input,
      outputPerMTok: output,
      ...(cacheReadPerMTok === undefined ? {} : { cacheReadPerMTok }),
      ...(cacheWritePerMTok === undefined ? {} : { cacheWritePerMTok }),
    };
  }
  return { maxCost: maxCost ?? null, warnCost: warnCost ?? null, pricing };
}

function CostForm({ initial }: { initial: CostSettings }) {
  const { actions } = useStore();
  const [max, setMax] = useState(initial.maxCost === null ? '' : String(initial.maxCost));
  const [warn, setWarn] = useState(initial.warnCost === null ? '' : String(initial.warnCost));
  const [rows, setRows] = useState<PricingDraft[]>(
    Object.entries(initial.pricing).map(([key, price]) => ({
      key,
      input: String(price.inputPerMTok),
      output: String(price.outputPerMTok),
      cacheRead: price.cacheReadPerMTok === undefined ? '' : String(price.cacheReadPerMTok),
      cacheWrite: price.cacheWritePerMTok === undefined ? '' : String(price.cacheWritePerMTok),
    })),
  );
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const maxId = useId();
  const warnId = useId();

  const patchRow = (index: number, patch: Partial<PricingDraft>) => {
    setRows(rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  };

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        const next = toSettings(max, warn, rows);
        if (typeof next === 'string') {
          setMessage({ text: next, isError: true });
          return;
        }
        setMessage(null);
        actions
          .saveCostSettings(next)
          .then(() => {
            setMessage({
              text: '저장했습니다. 다음에 시작하거나 이어 가는 세션부터 적용합니다.',
              isError: false,
            });
          })
          .catch((error: unknown) => {
            setMessage({
              text: error instanceof Error ? error.message : String(error),
              isError: true,
            });
          });
      }}
    >
      <section className="flex flex-col gap-2.5">
        <h2 className="text-[13px] leading-[18px] font-medium text-foreground-muted">세션 한도</h2>
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface px-4 py-3.5">
          <div className="flex items-center gap-3">
            <label
              htmlFor={warnId}
              className="flex-1 text-sm leading-5 font-medium text-foreground"
            >
              경고 값
            </label>
            <input
              id={warnId}
              inputMode="decimal"
              value={warn}
              placeholder="설정 안 함"
              onChange={(event) => {
                setWarn(event.target.value);
              }}
              className={`${inputClass} w-[140px]`}
            />
          </div>
          <div className="flex items-center gap-3">
            <label htmlFor={maxId} className="flex-1 text-sm leading-5 font-medium text-foreground">
              상한 값
            </label>
            <input
              id={maxId}
              inputMode="decimal"
              value={max}
              placeholder="설정 안 함"
              onChange={(event) => {
                setMax(event.target.value);
              }}
              className={`${inputClass} w-[140px]`}
            />
          </div>
          <p className="text-xs leading-[18px] text-foreground-subtle">
            값은 아래 단가로 환산한 금액입니다. 화면과 세션 기록에는 금액을 쓰지 않고 상한 대비
            비율로만 알립니다.
          </p>
        </div>
      </section>
      <section className="flex flex-col gap-2.5">
        <h2 className="text-[13px] leading-[18px] font-medium text-foreground-muted">
          모델 단가 (100만 토큰당)
        </h2>
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface px-4 py-3.5">
          {rows.map((row, index) => (
            <div key={index} className="flex flex-col gap-2 rounded-md bg-background p-2.5">
              <PriceField
                label="모델"
                value={row.key}
                placeholder="claude/claude-sonnet-5-5"
                onChange={(key) => {
                  patchRow(index, { key });
                }}
                action={
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setRows(rows.filter((_, position) => position !== index));
                    }}
                  >
                    <Trash2 aria-hidden className="size-3.5" />
                    삭제
                  </Button>
                }
              />
              <div className="grid grid-cols-4 gap-2">
                <PriceField
                  label="입력"
                  value={row.input}
                  onChange={(input) => {
                    patchRow(index, { input });
                  }}
                />
                <PriceField
                  label="출력"
                  value={row.output}
                  onChange={(output) => {
                    patchRow(index, { output });
                  }}
                />
                <PriceField
                  label="캐시 읽기"
                  value={row.cacheRead}
                  onChange={(cacheRead) => {
                    patchRow(index, { cacheRead });
                  }}
                />
                <PriceField
                  label="캐시 쓰기"
                  value={row.cacheWrite}
                  onChange={(cacheWrite) => {
                    patchRow(index, { cacheWrite });
                  }}
                />
              </div>
            </div>
          ))}
          <div>
            <Button
              onClick={() => {
                setRows([
                  ...rows,
                  { key: '', input: '', output: '', cacheRead: '', cacheWrite: '' },
                ]);
              }}
            >
              <Plus aria-hidden className="size-3.5" />
              모델 단가 추가
            </Button>
          </div>
          <p className="text-xs leading-[18px] text-foreground-subtle">
            캐시 단가를 비우면 입력 단가로 계산합니다. 상한을 설정했는데 단가가 없는 모델은 요청을
            보내지 않고 멈춥니다.
          </p>
        </div>
      </section>
      <div className="flex items-center gap-3">
        <Button variant="primary" type="submit">
          저장
        </Button>
        {message && (
          <p
            role={message.isError ? 'alert' : 'status'}
            className={
              message.isError
                ? 'text-xs leading-4 text-danger'
                : 'text-xs leading-4 text-foreground-muted'
            }
          >
            {message.text}
          </p>
        )}
      </div>
    </form>
  );
}

/** 설정의 비용 상한 페이지입니다. 설정 파일은 서버 API로만 쓰고, 모델 도구는 이 값을 바꾸지 못합니다. */
export function CostPage() {
  const { costSettings, actions } = useStore();
  return (
    <PageShell
      title="비용 상한"
      description="세션 트리가 쓴 양이 상한에 닿으면 다음 모델 요청을 보내지 않고 멈춥니다. 알림과 기록에는 상한 대비 비율로만 알립니다."
    >
      {costSettings.settings === undefined ? (
        <p className="text-[13px] leading-5 text-foreground-muted">
          {costSettings.status === 'error' ? (
            <>
              {costSettings.errorMessage}{' '}
              <Button
                variant="ghost"
                onClick={() => {
                  actions.refreshCostSettings().catch(() => undefined);
                }}
              >
                다시 시도
              </Button>
            </>
          ) : (
            '불러오는 중입니다.'
          )}
        </p>
      ) : (
        <CostForm initial={costSettings.settings} />
      )}
    </PageShell>
  );
}
