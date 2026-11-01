import { BOARD_LANES } from '@ora/protocol';
import type { BoardCardStatus, BoardCardView, BoardLane, BoardWorktree } from '@ora/protocol';
import {
  ArrowUpRight,
  BookOpen,
  Circle,
  CircleCheck,
  CircleDot,
  CircleX,
  CornerDownRight,
  Ellipsis,
  FlaskConical,
  GitBranch,
  Hammer,
  Kanban,
  Loader,
  Play,
  Plus,
  ScanEye,
  ShieldAlert,
  ShieldCheck,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { formatElapsed, useNow } from '../lib/now.ts';
import { openSessionTab } from '../lib/tabs.ts';
import type { OraStore } from '../model.ts';
import { runAction, useStore } from '../store.tsx';
import { Button } from '../ui/button.tsx';
import { inputClass } from './SettingsPages.tsx';
import { Sidebar } from './Sidebar.tsx';

const laneMeta: Record<BoardLane, { Icon: LucideIcon; label: string }> = {
  builder: { Icon: Hammer, label: '구현' },
  verifier: { Icon: ShieldCheck, label: '검증' },
  reviewer: { Icon: ScanEye, label: '검토' },
  docs: { Icon: BookOpen, label: '문서' },
  qa: { Icon: FlaskConical, label: '테스트' },
};

/** 상태는 아이콘 모양과 글자로 함께 알리므로 색을 못 보는 사용자도 구분합니다. */
const statusMeta: Record<BoardCardStatus, { Icon: LucideIcon; label: string; color: string }> = {
  not_started: { Icon: Circle, label: '시작 전', color: 'text-foreground-subtle' },
  running: { Icon: Loader, label: '실행 중', color: 'text-foreground-muted' },
  awaiting_approval: { Icon: ShieldAlert, label: '승인 대기', color: 'text-warning' },
  done: { Icon: CircleCheck, label: '끝남', color: 'text-success' },
  failed: { Icon: CircleX, label: '실패', color: 'text-danger' },
};

const LOCKED_REASON = '세션을 시작한 카드는 담당과 상위 카드를 바꿀 수 없습니다.';
const hideDoneStorageKey = 'ora-board-hide-done';

function readHideDone(repo: string): boolean {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(hideDoneStorageKey) ?? '{}');
    return typeof parsed === 'object' && parsed !== null && Reflect.get(parsed, repo) === true;
  } catch {
    return false;
  }
}

function writeHideDone(repo: string, isHidden: boolean): void {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(hideDoneStorageKey) ?? '{}');
    const stored = typeof parsed === 'object' && parsed !== null ? parsed : {};
    localStorage.setItem(hideDoneStorageKey, JSON.stringify({ ...stored, [repo]: isHidden }));
  } catch {
    // 저장하지 못하는 환경에서는 이번 탭에서만 적용합니다.
  }
}

function formatRunningTime(startedAt: string, now: number): string {
  const minutes = Math.max(1, Math.floor((now - Date.parse(startedAt)) / 60_000));
  if (minutes < 60) return `${String(minutes)}분`;
  return `${String(Math.floor(minutes / 60))}시간`;
}

const isChildLane = (lane: BoardLane) => lane === 'verifier' || lane === 'reviewer';
const isLive = (status: BoardCardStatus) => status === 'running' || status === 'awaiting_approval';

function Toggle({
  isOn,
  label,
  onChange,
}: {
  isOn: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[13px] leading-[18px] text-foreground-muted">
      <button
        type="button"
        role="switch"
        aria-checked={isOn}
        onClick={() => {
          onChange(!isOn);
        }}
        className={cn(
          'flex h-[18px] w-8 shrink-0 items-center rounded-full px-0.5 transition-colors',
          isOn ? 'bg-primary' : 'bg-surface-hover',
        )}
      >
        <span
          className={cn(
            'size-3.5 rounded-full bg-background transition-transform',
            isOn && 'translate-x-3.5',
          )}
        />
      </button>
      {label}
    </label>
  );
}

function SmallButton({
  children,
  Icon,
  isPrimary = false,
  ...props
}: {
  children: string;
  Icon: LucideIcon;
  isPrimary?: boolean;
  disabled?: boolean;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        'inline-flex h-[26px] items-center gap-1.5 rounded-sm px-2.5 text-xs leading-4 font-medium transition-colors disabled:opacity-45',
        isPrimary
          ? 'bg-primary text-primary-foreground hover:bg-foreground-muted'
          : 'bg-surface-hover text-foreground hover:bg-surface',
      )}
    >
      <Icon aria-hidden className="size-3" />
      {children}
    </button>
  );
}

function ModalShell({
  title,
  titleId,
  onClose,
  children,
}: {
  title: string;
  titleId: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[calc(100%-32px)] w-[520px] max-w-[calc(100%-32px)] flex-col overflow-y-auto rounded-xl border border-border-strong bg-popover"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 px-[18px]">
          <h2 id={titleId} className="text-[15px] leading-5 font-semibold text-foreground">
            {title}
          </h2>
          <button
            type="button"
            aria-label="닫기"
            onClick={onClose}
            className="ml-auto flex size-6 items-center justify-center rounded-sm text-foreground-subtle hover:text-foreground"
          >
            <X aria-hidden className="size-[15px]" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

interface CardDialogProps {
  repo: string;
  cards: readonly BoardCardView[];
  /** 있으면 편집, 없으면 만들기입니다. */
  card?: BoardCardView;
  /** 끝난 builder 카드의 "검증 카드 만들기"와 "검토 카드 만들기"가 레인과 상위 카드를 미리 채웁니다. */
  preset?: { lane: BoardLane; parentId: string };
  onClose: () => void;
}

function CardDialog({ repo, cards, card, preset, onClose }: CardDialogProps) {
  const { actions } = useStore();
  const base = useId();
  const presetParent = cards.find((item) => item.id === preset?.parentId);
  const [title, setTitle] = useState(
    card?.title ??
      (preset === undefined || presetParent === undefined
        ? ''
        : `${presetParent.title} · ${laneMeta[preset.lane].label}`),
  );
  const [lane, setLane] = useState<BoardLane>(card?.lane ?? preset?.lane ?? 'builder');
  const [parentId, setParentId] = useState<string | undefined>(card?.parentId ?? preset?.parentId);
  const [command, setCommand] = useState(card?.verifyCommand ?? presetParent?.verifyCommand ?? '');
  const [scope, setScope] = useState(card?.writeScope.join(', ') ?? '');
  const [description, setDescription] = useState(card?.description ?? '');
  const [error, setError] = useState<string>();
  const [isBusy, setIsBusy] = useState(false);

  const parents = cards.filter((item) => item.lane === 'builder');
  const parent = parents.find((item) => item.id === parentId);
  const isLocked = card?.isLocked === true;
  const needsParent = isChildLane(lane);
  const isCommandFromParent =
    needsParent && parent?.verifyCommand !== undefined && command === parent.verifyCommand;
  const canSubmit = title.trim() !== '' && (!needsParent || parentId !== undefined) && !isBusy;

  const fillCommand = (next: BoardCardView | undefined) => {
    if (command === '' && next?.verifyCommand !== undefined) setCommand(next.verifyCommand);
  };

  const submit = () => {
    if (!canSubmit) return;
    setIsBusy(true);
    setError(undefined);
    const writeScope =
      lane === 'verifier'
        ? []
        : scope
            .split(',')
            .map((item) => item.trim())
            .filter((item) => item !== '');
    const verifyCommand = command.trim();
    const request =
      card === undefined
        ? actions.createBoardCard({
            repo,
            title: title.trim(),
            description,
            lane,
            writeScope,
            ...(verifyCommand === '' ? {} : { verifyCommand }),
            ...(needsParent && parentId !== undefined ? { parentId } : {}),
          })
        : actions.updateBoardCard(card.id, {
            repo,
            title: title.trim(),
            description,
            lane,
            writeScope,
            verifyCommand: verifyCommand === '' ? null : verifyCommand,
            parentId: needsParent ? (parentId ?? null) : null,
          });
    request.then(onClose, (failure: unknown) => {
      setError(failure instanceof Error ? failure.message : String(failure));
      setIsBusy(false);
    });
  };

  const labelClass = 'text-xs leading-4 font-medium text-foreground-muted';
  const hintClass = 'text-[11px] leading-[15px] text-foreground-subtle';
  return (
    <ModalShell
      title={card === undefined ? '카드 만들기' : '카드 편집'}
      titleId={`${base}-title`}
      onClose={onClose}
    >
      <form
        className="flex flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="flex flex-col gap-3.5 border-y border-border p-[18px]">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${base}-title-input`} className={labelClass}>
              제목
            </label>
            <input
              id={`${base}-title-input`}
              value={title}
              autoFocus
              onChange={(event) => {
                setTitle(event.target.value);
              }}
              className={`${inputClass} h-[34px]`}
            />
          </div>
          <div role="group" aria-labelledby={`${base}-lane`} className="flex flex-col gap-1.5">
            <span id={`${base}-lane`} className={labelClass}>
              담당
            </span>
            <div
              role="radiogroup"
              aria-labelledby={`${base}-lane`}
              className="flex h-8 items-center gap-0.5 rounded-md bg-background p-0.5 outline-1 -outline-offset-1 outline-border"
            >
              {BOARD_LANES.map((item) => {
                const { Icon } = laneMeta[item];
                const isPicked = item === lane;
                return (
                  <button
                    key={item}
                    type="button"
                    role="radio"
                    aria-checked={isPicked}
                    disabled={isLocked}
                    onClick={() => {
                      setLane(item);
                      if (isChildLane(item)) fillCommand(parent);
                    }}
                    className={cn(
                      'flex h-[26px] flex-1 items-center justify-center gap-1.5 rounded-sm font-mono text-xs leading-4 disabled:opacity-50',
                      isPicked
                        ? 'bg-surface-hover font-semibold text-foreground'
                        : 'text-foreground-muted',
                    )}
                  >
                    <Icon aria-hidden className="size-3" />
                    {item}
                  </button>
                );
              })}
            </div>
            <p className={hintClass}>
              {isLocked ? LOCKED_REASON : '담당 이름과 같은 에이전트 정의로 세션을 엽니다.'}
            </p>
          </div>
          {needsParent && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${base}-parent`} className={labelClass}>
                상위 카드
              </label>
              <select
                id={`${base}-parent`}
                value={parentId ?? ''}
                disabled={isLocked}
                onChange={(event) => {
                  const next = parents.find((item) => item.id === event.target.value);
                  setParentId(next?.id);
                  fillCommand(next);
                }}
                className={`${inputClass} h-[34px] disabled:opacity-50`}
              >
                <option value="" disabled>
                  상위 카드를 고릅니다
                </option>
                {parents.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title} · builder · {statusMeta[item.status].label}
                  </option>
                ))}
              </select>
              <p className={hintClass}>
                {isLocked ? LOCKED_REASON : '검증·검토 카드에는 상위 카드가 있어야 합니다.'}
              </p>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${base}-command`} className={labelClass}>
              검증 명령
            </label>
            <input
              id={`${base}-command`}
              value={command}
              spellCheck={false}
              onChange={(event) => {
                setCommand(event.target.value);
              }}
              className={`${inputClass} h-[34px] font-mono`}
            />
            {isCommandFromParent && (
              <p className={hintClass}>상위 카드의 검증 명령을 가져왔습니다.</p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${base}-scope`} className={labelClass}>
              쓰기 범위
            </label>
            <input
              id={`${base}-scope`}
              value={lane === 'verifier' ? '' : scope}
              disabled={lane === 'verifier'}
              placeholder={lane === 'verifier' ? '검증 카드는 파일을 쓰지 않습니다' : 'src/refund/'}
              spellCheck={false}
              onChange={(event) => {
                setScope(event.target.value);
              }}
              className={`${inputClass} h-[34px] font-mono disabled:opacity-50`}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${base}-description`} className={labelClass}>
              설명
            </label>
            <textarea
              id={`${base}-description`}
              value={description}
              rows={3}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
              className={`${inputClass} h-16 resize-none py-2`}
            />
          </div>
          {error !== undefined && (
            <p role="alert" className="text-xs leading-4 text-danger">
              {error}
            </p>
          )}
        </div>
        <div className="flex h-14 shrink-0 items-center justify-end gap-2 px-[18px]">
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button variant="primary" type="submit" disabled={!canSubmit}>
            {card === undefined ? '만들기' : '저장'}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}

function describeWorktree(item: BoardWorktree): string {
  return [
    item.isMain ? '기본' : '',
    item.runningSessions > 0 ? `실행 ${String(item.runningSessions)}` : '',
    item.awaitingApprovalSessions > 0 ? '승인 대기' : '',
  ]
    .filter((part) => part !== '')
    .join(' · ');
}

const worktreeName = (item: BoardWorktree) =>
  item.branch ?? item.path.split('/').at(-1) ?? item.path;

function StartPopover({
  repo,
  card,
  anchor,
  onClose,
}: {
  repo: string;
  card: BoardCardView;
  anchor: { left: number; top: number };
  onClose: () => void;
}) {
  const { actions } = useStore();
  const titleId = useId();
  const [worktrees, setWorktrees] = useState<BoardWorktree[]>();
  const [picked, setPicked] = useState<string>();
  const [error, setError] = useState<string>();
  const [isBusy, setIsBusy] = useState(false);

  /** 팝오버를 열 때마다 워크트리 목록과 실행 중인 세션 수를 서버에서 새로 받아야 합니다. */
  useEffect(() => {
    let isCurrent = true;
    actions.loadBoardWorktrees(repo).then(
      (list) => {
        if (isCurrent) setWorktrees(list);
      },
      (failure: unknown) => {
        if (isCurrent) setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
    return () => {
      isCurrent = false;
    };
  }, [actions, repo]);

  const selected =
    picked ??
    worktrees?.find((item) => item.path === card.lastWorktree)?.path ??
    worktrees?.find((item) => item.isMain)?.path ??
    worktrees?.[0]?.path;

  const start = () => {
    if (selected === undefined || isBusy) return;
    setIsBusy(true);
    setError(undefined);
    actions.startBoardCard(repo, card.id, selected).then(onClose, (failure: unknown) => {
      setError(failure instanceof Error ? failure.message : String(failure));
      setIsBusy(false);
    });
  };

  return (
    <div
      className="fixed inset-0 z-50"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <button
        type="button"
        aria-label="닫기"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <div
        role="dialog"
        aria-labelledby={titleId}
        style={{ left: anchor.left, top: anchor.top }}
        className="absolute flex w-[330px] flex-col gap-1.5 rounded-xl border border-border-strong bg-popover p-2.5"
      >
        <h2 id={titleId} className="px-1 pt-0.5 text-[13px] leading-[18px] font-semibold">
          어느 워크트리에서 시작할까요?
        </h2>
        <p className="px-1 text-xs leading-4 text-foreground-subtle">
          {card.lane} 정의로 세션을 열고, 카드 내용을 작업 지시로 넘깁니다.
        </p>
        <div role="radiogroup" aria-labelledby={titleId} className="flex flex-col gap-0.5 pt-1">
          {worktrees?.map((item) => {
            const isPicked = item.path === selected;
            const meta = describeWorktree(item);
            return (
              <button
                key={item.path}
                type="button"
                role="radio"
                aria-checked={isPicked}
                onClick={() => {
                  setPicked(item.path);
                }}
                className={cn(
                  'flex h-9 items-center gap-2 rounded-md px-2.5 text-left',
                  isPicked ? 'bg-surface-hover' : 'hover:bg-surface-hover',
                )}
              >
                {isPicked ? (
                  <CircleDot aria-hidden className="size-3.5 text-foreground" />
                ) : (
                  <Circle aria-hidden className="size-3.5 text-foreground-subtle" />
                )}
                <GitBranch aria-hidden className="size-[13px] text-foreground-subtle" />
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-[13px] leading-[18px] text-foreground',
                    isPicked && 'font-medium',
                  )}
                >
                  {worktreeName(item)}
                </span>
                <span className="shrink-0 text-xs leading-4 text-foreground-subtle">{meta}</span>
              </button>
            );
          })}
        </div>
        {error !== undefined && (
          <p role="alert" className="px-1 text-xs leading-4 text-danger">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-1.5 pt-1">
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button variant="primary" disabled={selected === undefined || isBusy} onClick={start}>
            시작
          </Button>
        </div>
      </div>
    </div>
  );
}

function DeleteDialog({
  repo,
  card,
  childCount,
  onClose,
}: {
  repo: string;
  card: BoardCardView;
  childCount: number;
  onClose: () => void;
}) {
  const { actions } = useStore();
  const titleId = useId();
  const [error, setError] = useState<string>();
  const [isBusy, setIsBusy] = useState(false);
  return (
    <ModalShell title="카드 삭제" titleId={titleId} onClose={onClose}>
      <div className="flex flex-col gap-2 border-t border-border p-[18px] text-[13px] leading-5 text-foreground-muted">
        <p>
          &quot;{card.title}&quot; 카드를 삭제할까요? 이 카드로 연 세션 기록은 남습니다.
          {childCount > 0 && ' 이 카드를 상위로 둔 카드에는 "상위: 삭제한 카드"가 보입니다.'}
        </p>
        {error !== undefined && (
          <p role="alert" className="text-xs leading-4 text-danger">
            {error}
          </p>
        )}
      </div>
      <div className="flex h-14 shrink-0 items-center justify-end gap-2 px-[18px]">
        <Button variant="ghost" onClick={onClose}>
          취소
        </Button>
        <Button
          variant="primary"
          disabled={isBusy}
          onClick={() => {
            setIsBusy(true);
            actions.deleteBoardCard(repo, card.id).then(onClose, (failure: unknown) => {
              setError(failure instanceof Error ? failure.message : String(failure));
              setIsBusy(false);
            });
          }}
        >
          삭제
        </Button>
      </div>
    </ModalShell>
  );
}

function openCardSession(store: OraStore, card: BoardCardView): void {
  const sessionId = card.sessionIds.at(-1);
  const cwd = card.lastWorktree;
  if (sessionId === undefined || cwd === undefined) return;
  runAction(
    store.actions.loadTabs(cwd).then(() => {
      openSessionTab(
        { actions: store.actions, cwd, tabs: store.getTabs(cwd) ?? { tabs: [] } },
        sessionId,
      );
    }),
  );
}

type Overlay =
  | { kind: 'edit'; card?: BoardCardView; preset?: { lane: BoardLane; parentId: string } }
  | { kind: 'start'; card: BoardCardView; anchor: { left: number; top: number } }
  | { kind: 'delete'; card: BoardCardView };

function CardItem({
  card,
  now,
  isMenuOpen,
  onMenu,
  onOverlay,
}: {
  card: BoardCardView;
  now: number;
  isMenuOpen: boolean;
  onMenu: (isOpen: boolean) => void;
  onOverlay: (overlay: Overlay) => void;
}) {
  const store = useStore();
  const { Icon, label, color } = statusMeta[card.status];
  const hasStarted = card.sessionIds.length > 0;
  const session =
    card.lastStartedAt === undefined || card.lastUpdatedAt === undefined
      ? ''
      : [
          card.lastWorktreeName,
          isLive(card.status)
            ? formatRunningTime(card.lastStartedAt, now)
            : formatElapsed(card.lastUpdatedAt, now),
        ]
          .filter((part) => part !== undefined)
          .join(' · ');
  const parentLabel = card.parentDeleted ? '삭제한 카드' : card.parentTitle;
  let scopeLine = card.writeScope.join(', ');
  if (card.lane === 'verifier') {
    scopeLine = card.verifyCommand === undefined ? '' : `$ ${card.verifyCommand}`;
  }
  return (
    <li className="relative flex flex-col gap-1.5 rounded-lg border border-border bg-background p-2.5">
      <div className="flex items-center gap-1.5">
        <Icon aria-hidden className={cn('size-3', color)} />
        <span className={cn('text-xs leading-4 font-medium', color)}>{label}</span>
        <span className="ml-auto truncate text-[11px] leading-[14px] text-foreground-subtle">
          {session}
        </span>
        <button
          type="button"
          aria-label={`${card.title} 카드 메뉴`}
          aria-haspopup="menu"
          aria-expanded={isMenuOpen}
          onClick={() => {
            onMenu(!isMenuOpen);
          }}
          className="flex size-5 shrink-0 items-center justify-center rounded-sm text-foreground-subtle hover:text-foreground"
        >
          <Ellipsis aria-hidden className="size-3.5" />
        </button>
      </div>
      {isMenuOpen && (
        <div
          role="menu"
          aria-label={`${card.title} 카드 메뉴`}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onMenu(false);
          }}
          className="absolute top-8 right-2.5 z-30 flex w-24 flex-col rounded-md border border-border-strong bg-popover p-1"
        >
          <button
            type="button"
            role="menuitem"
            autoFocus
            onClick={() => {
              onMenu(false);
              onOverlay({ kind: 'edit', card });
            }}
            className="h-7 rounded-sm px-2 text-left text-[13px] hover:bg-surface-hover"
          >
            편집
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onMenu(false);
              onOverlay({ kind: 'delete', card });
            }}
            className="h-7 rounded-sm px-2 text-left text-[13px] text-danger hover:bg-surface-hover"
          >
            삭제
          </button>
        </div>
      )}
      <h3 className="line-clamp-2 text-[13px] leading-[18px] font-medium text-foreground">
        {card.title}
      </h3>
      {parentLabel !== undefined && (
        <p className="flex items-center gap-1 text-[11px] leading-[14px] text-foreground-subtle">
          <CornerDownRight aria-hidden className="size-[11px] shrink-0" />
          <span className="truncate">상위: {parentLabel}</span>
        </p>
      )}
      {scopeLine !== '' && (
        <p className="truncate font-mono text-[11px] leading-[14px] text-foreground-subtle">
          {scopeLine}
        </p>
      )}
      {card.startBlockedReason !== undefined && (
        <p className="text-[11px] leading-[15px] text-foreground-muted">
          {card.startBlockedReason}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {(card.status === 'not_started' || card.status === 'failed') && (
          <SmallButton
            Icon={Play}
            isPrimary={card.status === 'not_started'}
            disabled={card.startBlockedReason !== undefined}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              onOverlay({
                kind: 'start',
                card,
                anchor: {
                  left: Math.max(8, Math.min(rect.left, window.innerWidth - 338)),
                  top: Math.min(rect.bottom + 6, window.innerHeight - 280),
                },
              });
            }}
          >
            시작
          </SmallButton>
        )}
        {hasStarted && (
          <SmallButton
            Icon={ArrowUpRight}
            onClick={() => {
              openCardSession(store, card);
            }}
          >
            세션 열기
          </SmallButton>
        )}
        {card.status === 'done' && card.lane === 'builder' && (
          <>
            <SmallButton
              Icon={ShieldCheck}
              onClick={() => {
                onOverlay({ kind: 'edit', preset: { lane: 'verifier', parentId: card.id } });
              }}
            >
              검증 카드 만들기
            </SmallButton>
            <SmallButton
              Icon={ScanEye}
              onClick={() => {
                onOverlay({ kind: 'edit', preset: { lane: 'reviewer', parentId: card.id } });
              }}
            >
              검토 카드 만들기
            </SmallButton>
          </>
        )}
      </div>
    </li>
  );
}

function BoardBody({ repo }: { repo: string }) {
  const store = useStore();
  const { board, actions } = store;
  const now = useNow();
  const [isHidingDone, setIsHidingDone] = useState(() => readHideDone(repo));
  const [overlay, setOverlay] = useState<Overlay>();
  const [menuId, setMenuId] = useState<string>();

  /** 보드는 서버가 저장한 값이라 저장소를 열거나 바꿀 때마다 새로 받아야 합니다. */
  useEffect(() => {
    runAction(actions.refreshBoard(repo));
  }, [actions, repo]);

  const data = board.board;
  const cards = data?.cards ?? [];
  const shown = isHidingDone ? cards.filter((card) => card.status !== 'done') : cards;
  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-3 px-5 pt-4 pb-3">
        <Kanban aria-hidden className="size-[18px] text-foreground" />
        <h1 className="text-lg leading-[26px] font-semibold text-foreground">보드</h1>
        <span className="text-sm leading-5 text-foreground-subtle">
          {data?.repoName ?? repo.split('/').at(-1)}
        </span>
        <div className="ml-auto flex items-center gap-4">
          <Toggle
            isOn={isHidingDone}
            label="끝난 카드 숨기기"
            onChange={(next) => {
              setIsHidingDone(next);
              writeHideDone(repo, next);
            }}
          />
          <Button
            variant="primary"
            onClick={() => {
              setOverlay({ kind: 'edit' });
            }}
          >
            <Plus aria-hidden className="size-3.5" />
            카드 만들기
          </Button>
        </div>
      </div>
      {board.status === 'error' && (
        <p role="alert" className="px-5 text-xs leading-4 text-danger">
          {board.errorMessage}{' '}
          <Button
            variant="ghost"
            onClick={() => {
              runAction(actions.refreshBoard(repo));
            }}
          >
            다시 시도
          </Button>
        </p>
      )}
      {board.status === 'loading' && (
        <p className="px-5 text-[13px] leading-5 text-foreground-muted">불러오는 중입니다.</p>
      )}
      <div className="flex min-h-0 flex-1 gap-2.5 px-5 pb-4">
        {BOARD_LANES.map((lane) => {
          const { Icon, label } = laneMeta[lane];
          const inLane = shown.filter((card) => card.lane === lane);
          return (
            <section
              key={lane}
              aria-label={`${lane} · ${label}`}
              className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 rounded-[10px] bg-surface p-2"
            >
              <header className="flex h-7 shrink-0 items-center gap-1.5 px-1">
                <Icon aria-hidden className="size-[13px] text-foreground-muted" />
                <h2 className="text-[13px] leading-[18px] font-semibold text-foreground">
                  <span className="font-mono">{lane}</span> · {label}
                </h2>
                <span className="ml-auto font-mono text-xs leading-4 font-medium text-foreground-subtle">
                  {inLane.length}
                </span>
              </header>
              <ul className="flex min-h-0 flex-col gap-2 overflow-y-auto">
                {inLane.map((card) => (
                  <CardItem
                    key={card.id}
                    card={card}
                    now={now}
                    isMenuOpen={menuId === card.id}
                    onMenu={(isOpen) => {
                      setMenuId(isOpen ? card.id : undefined);
                    }}
                    onOverlay={setOverlay}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      {overlay?.kind === 'edit' && (
        <CardDialog
          repo={repo}
          cards={cards}
          {...(overlay.card === undefined ? {} : { card: overlay.card })}
          {...(overlay.preset === undefined ? {} : { preset: overlay.preset })}
          onClose={() => {
            setOverlay(undefined);
          }}
        />
      )}
      {overlay?.kind === 'start' && (
        <StartPopover
          repo={repo}
          card={overlay.card}
          anchor={overlay.anchor}
          onClose={() => {
            setOverlay(undefined);
          }}
        />
      )}
      {overlay?.kind === 'delete' && (
        <DeleteDialog
          repo={repo}
          card={overlay.card}
          childCount={cards.filter((card) => card.parentId === overlay.card.id).length}
          onClose={() => {
            setOverlay(undefined);
          }}
        />
      )}
    </main>
  );
}

/** 저장소 하나의 에이전트 보드입니다. 열은 담당(레인) 다섯 개이고 주소의 `repo`가 저장소를 가리킵니다. */
export function BoardScreen({ repo }: { repo: string | undefined }) {
  const store = useStore();
  const picked = repo ?? store.sidebar.repos.find((item) => item.path !== undefined)?.path;
  return (
    <>
      <Sidebar data={store.sidebar} isBoardSelected />
      {picked === undefined ? (
        <main className="flex min-w-0 flex-1 flex-col px-5 pt-8">
          <h1 className="text-lg leading-[26px] font-semibold text-foreground">보드</h1>
          <p className="pt-3 text-[13px] leading-5 text-foreground-muted">
            저장소가 없습니다. 세션을 시작하면 저장소가 나타납니다.
          </p>
        </main>
      ) : (
        <BoardBody key={picked} repo={picked} />
      )}
    </>
  );
}
