import { RadioGroup, Switch } from 'radix-ui';
import { useId, type ReactNode } from 'react';
import { cn } from '../lib/cn.ts';
import type { Loadable } from '../model.ts';
import { Button } from '../ui/button.tsx';
import { inputClass } from './SettingsPages.tsx';

/** 설정 페이지 안의 묶음입니다. 제목 아래에 줄로 나뉜 행이 들어갑니다. */
export function SettingsGroup({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="flex items-baseline gap-2 text-[13px] leading-[18px] font-medium text-foreground-muted">
        {title}
        {aside !== undefined && (
          <span className="text-xs leading-4 font-normal text-foreground-subtle">{aside}</span>
        )}
      </h2>
      <div className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
        {children}
      </div>
    </section>
  );
}

/** 이름, 설명, 오른쪽 조작으로 이루어진 행입니다. `controlId`가 있으면 이름이 그 조작의 `<label>`이 됩니다. */
export function SettingsRow({
  title,
  description,
  controlId,
  error,
  children,
}: {
  title: string;
  description?: string;
  controlId?: string;
  error?: string | undefined;
  children: ReactNode;
}) {
  const errorId = useId();
  return (
    <div className="flex items-center gap-4 px-4 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {controlId === undefined ? (
          <span className="text-sm leading-5 font-medium text-foreground">{title}</span>
        ) : (
          <label htmlFor={controlId} className="text-sm leading-5 font-medium text-foreground">
            {title}
          </label>
        )}
        {description !== undefined && (
          <p className="text-xs leading-[17px] text-foreground-subtle">{description}</p>
        )}
        {error !== undefined && (
          <p id={errorId} role="alert" className="text-xs leading-[17px] text-danger">
            {error}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

/** 숫자 입력칸과 단위입니다. 칸의 이름은 행의 `<label>`이 붙이고, 오류는 행이 칸 아래에 보입니다. */
export function NumberInput({
  id,
  value,
  unit,
  hasError,
  onChange,
}: {
  id: string;
  value: string;
  unit: string;
  hasError: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <input
        id={id}
        inputMode="numeric"
        value={value}
        aria-invalid={hasError}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className={cn(inputClass, 'w-[84px] text-right font-mono', hasError && 'outline-danger')}
      />
      <span className="w-8 text-xs leading-4 text-foreground-subtle">{unit}</span>
    </span>
  );
}

/** 켜짐과 꺼짐을 고르는 스위치입니다. 상태를 색만으로 알리지 않고 "켬"·"끔" 글자를 함께 보입니다. */
export function Toggle({
  id,
  isOn,
  onChange,
}: {
  id: string;
  isOn: boolean;
  onChange: (isOn: boolean) => void;
}) {
  return (
    <span className="flex shrink-0 items-center gap-2">
      <span className="w-5 text-right text-xs leading-4 text-foreground-muted">
        {isOn ? '켬' : '끔'}
      </span>
      <Switch.Root
        id={id}
        checked={isOn}
        onCheckedChange={onChange}
        className={cn(
          'flex h-[18px] w-8 shrink-0 items-center rounded-full px-0.5 transition-colors duration-(--duration-fast) ease-(--ease-out)',
          isOn ? 'bg-primary' : 'bg-surface-hover',
        )}
      >
        <Switch.Thumb className="block size-3.5 rounded-full bg-background transition-transform duration-(--duration-fast) ease-(--ease-out) data-[state=checked]:translate-x-3.5 data-[state=unchecked]:bg-foreground-muted" />
      </Switch.Root>
    </span>
  );
}

/** 선택지가 둘에서 넷인 값을 가로로 고릅니다. 고른 항목은 배경과 굵은 글자로 보입니다. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | undefined;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <RadioGroup.Root
      aria-label={label}
      value={value ?? ''}
      orientation="horizontal"
      onValueChange={(next) => {
        onChange(next as T);
      }}
      className="flex h-[30px] shrink-0 items-center rounded-lg bg-background p-0.5"
    >
      {options.map((option) => (
        <RadioGroup.Item
          key={option.value}
          value={option.value}
          className="flex h-[26px] items-center rounded-md px-2.5 text-xs leading-4 font-medium text-foreground-muted aria-checked:bg-surface-hover aria-checked:font-semibold aria-checked:text-foreground"
        >
          {option.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}

/** 라디오 카드 하나입니다. 같은 `RadioGroup.Root` 안에서 쓰고, 고른 카드는 테두리와 채워진 원으로 보입니다. */
export function ChoiceCard({
  value,
  title,
  description,
  badge,
}: {
  value: string;
  title: string;
  description: string;
  badge?: string;
}) {
  return (
    <RadioGroup.Item
      value={value}
      className="group flex h-full min-h-[78px] items-start gap-3 rounded-lg border border-border bg-surface px-3.5 py-3 text-left aria-checked:border-foreground-muted aria-checked:bg-surface-hover"
    >
      <span
        aria-hidden
        className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] border-foreground-subtle group-aria-checked:border-foreground"
      >
        <span className="hidden size-2 rounded-full bg-foreground group-aria-checked:block" />
      </span>
      <span className="flex flex-col gap-1">
        <span className="flex items-center gap-2 text-sm leading-5 font-semibold text-foreground">
          {title}
          {badge !== undefined && (
            <span className="rounded-sm bg-background px-1.5 text-[11px] leading-[18px] font-medium text-foreground-muted">
              {badge}
            </span>
          )}
        </span>
        <span className="text-xs leading-[17px] text-foreground-muted">{description}</span>
      </span>
    </RadioGroup.Item>
  );
}

/** 페이지 아래의 되돌리기·저장 줄입니다. 바꾼 값 수를 글자로 알리고, 바꾼 값이 없으면 두 단추를 막습니다. */
export function SaveBar({
  changedCount,
  isInvalid,
  isSaving,
  message,
  onRevert,
}: {
  changedCount: number;
  isInvalid: boolean;
  isSaving: boolean;
  message: { text: string; isError: boolean } | null;
  onRevert: () => void;
}) {
  const isUnchanged = changedCount === 0;
  return (
    <div className="flex items-center gap-2.5">
      <p
        role={message?.isError === true ? 'alert' : 'status'}
        className={cn(
          'flex-1 text-xs leading-4',
          message?.isError === true ? 'text-danger' : 'text-foreground-subtle',
        )}
      >
        {message?.text ??
          (isUnchanged ? '바꾼 값이 없습니다' : `바꾼 값이 ${String(changedCount)}개 있습니다`)}
      </p>
      <Button variant="ghost" disabled={isUnchanged || isSaving} onClick={onRevert}>
        되돌리기
      </Button>
      <Button variant="primary" type="submit" disabled={isUnchanged || isInvalid || isSaving}>
        저장
      </Button>
    </div>
  );
}

/** 설정을 아직 읽지 못했을 때의 안내와 다시 시도 단추입니다. 읽은 값이 있으면 `children`을 그립니다. */
export function LoadedPage<T>({
  data,
  onRetry,
  children,
}: {
  data: Loadable<T>;
  onRetry: () => void;
  children: (value: T) => ReactNode;
}) {
  if (data.value !== undefined) return children(data.value);
  return (
    <p className="text-[13px] leading-5 text-foreground-muted">
      {data.status === 'error' ? (
        <>
          {data.errorMessage}{' '}
          <Button variant="ghost" onClick={onRetry}>
            다시 시도
          </Button>
        </>
      ) : (
        '불러오는 중입니다.'
      )}
    </p>
  );
}
