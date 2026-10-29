import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useExternalStoreRuntime,
  type TextMessagePartProps,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import {
  ArrowUp,
  Check,
  CircleCheck,
  ChevronDown,
  CircleAlert,
  Cpu,
  Plus,
  Shield,
  Square,
  TriangleAlert,
} from 'lucide-react';
import { Popover } from 'radix-ui';
import { useEffect, type ReactNode } from 'react';
import type { ComposerChips, Effort, RoutingModel, SessionView, StatusItem } from '../model.ts';
import { cn } from '../lib/cn.ts';
import type { CacheView } from '../lib/cache.ts';
import type { ContextView } from '../lib/context.ts';
import { MarkdownText } from './Markdown.tsx';
import { CacheStat } from './CacheStat.tsx';
import { CompactionMark } from './CompactionMark.tsx';
import { ReviewNote } from './ReviewCard.tsx';
import { ContextStat } from './ContextStat.tsx';
import { ToolLine } from './ToolLine.tsx';

interface ChatProviderProps {
  messages: readonly ThreadMessageLike[];
  /** 입력창에서 보낸 글을 엔진에 전달합니다. 실행 중이면 조향 메시지입니다. */
  onSend: (text: string) => Promise<void>;
  children: ReactNode;
}

/**
 * 채팅 영역의 상태를 assistant-ui 외부 저장소 런타임에 연결합니다. 메시지의 정본은 이벤트 스트림입니다.
 * 실행 중에도 입력창이 메시지를 보내야 하므로(조향 메시지, SPEC 2.9절) 런타임에는 isRunning을 넘기지 않습니다.
 * 런타임은 isRunning이 true이고 queue 어댑터가 없으면 Enter 전송을 막기 때문입니다.
 */
export function ChatProvider({ messages, onSend, children }: ChatProviderProps) {
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: (message: ThreadMessageLike) => message,
    onNew: (message) => {
      const text = message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []));
      return onSend(text.join('\n'));
    },
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

/**
 * 조향 메시지를 전달하지 못했을 때 돌려받은 글을 입력창에 되살립니다.
 * 입력창 글은 assistant-ui 런타임이 갖고 있어서 서버 이벤트에 맞춰 바꾸려면 구독이 필요합니다.
 */
export function SteerRestore({ failure }: { failure: SessionView['steerFailure'] }) {
  const aui = useAui();
  useEffect(() => {
    if (failure) aui.composer.setText(failure.texts.join('\n'));
  }, [aui, failure]);
  return null;
}

function UserText({ text }: TextMessagePartProps) {
  return <p className="whitespace-pre-line text-foreground">{text}</p>;
}

function UserMessage() {
  return (
    <MessagePrimitive.Root>
      <div className="w-full rounded-lg border border-border bg-surface px-3.5 py-2.5 text-sm leading-[22px]">
        <MessagePrimitive.Parts components={{ Text: UserText }} />
      </div>
    </MessagePrimitive.Root>
  );
}

/** 승인은 적용했지만 기억 저장에 실패하는 것처럼 사용자가 알아야 할 경고입니다. 색과 함께 아이콘과 글자로 알립니다. */
function WarningNote({ data }: { data: unknown }) {
  const text = (data as { text?: string }).text ?? '';
  return (
    <p role="status" className="flex items-start gap-2 text-[13px] leading-5 text-warning">
      <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>경고: {text}</span>
    </p>
  );
}

/** MCP 서버가 응답하지 않아 도구를 껐거나 다시 연결한 사실을 대화 흐름에 한 줄로 알립니다. */
function McpNote({ data }: { data: unknown }) {
  const { server, outcome } = data as { server: string; outcome: 'failed' | 'recovered' };
  if (outcome === 'recovered') {
    return (
      <p role="status" className="flex items-center gap-2 text-[13px] leading-5 text-success">
        <CircleCheck aria-hidden className="size-3.5 shrink-0" />
        <span>MCP 서버 {server}에 다시 연결했습니다</span>
      </p>
    );
  }
  return (
    <p role="status" className="flex items-center gap-2 text-[13px] leading-5 text-warning">
      <CircleAlert aria-hidden className="size-3.5 shrink-0" />
      <span>MCP 서버 {server}가 응답하지 않아 이 서버의 도구를 껐습니다 · 세션은 계속합니다</span>
    </p>
  );
}

function ToolGroup({ children }: { children?: ReactNode }) {
  return <div className="flex flex-col gap-1">{children}</div>;
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex flex-col gap-4">
      <MessagePrimitive.Parts
        components={{
          Text: MarkdownText,
          tools: { Fallback: ToolLine },
          ToolGroup,
          data: {
            by_name: { compaction: CompactionMark, mcp: McpNote, review: ReviewNote },
            Fallback: WarningNote,
          },
        }}
      />
    </MessagePrimitive.Root>
  );
}

interface ThreadViewProps {
  /** 메시지 아래에 놓는 카드(승인, 질문, 멈춤 안내)입니다. */
  children?: ReactNode;
}

export function ThreadView({ children }: ThreadViewProps) {
  return (
    <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col items-center">
      <ThreadPrimitive.Viewport className="flex w-full flex-1 flex-col items-center overflow-y-auto pt-5">
        <div className="flex w-[720px] max-w-full flex-col gap-4 pb-6">
          <ThreadPrimitive.Messages>
            {({ message }) => (message.role === 'user' ? <UserMessage /> : <AssistantMessage />)}
          </ThreadPrimitive.Messages>
          {children}
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-[26px] items-center gap-1 rounded-sm px-2 text-xs leading-4 font-medium text-foreground-muted">
      {children}
    </span>
  );
}

interface ComposerRouting {
  /** `default` 역할의 체인입니다. */
  chain: readonly RoutingModel[];
  /** 체인 밖의 카탈로그 모델입니다. */
  others: readonly RoutingModel[];
  /** 지금 고른(또는 체인 맨 앞의) 모델과 추론 강도입니다. */
  selected: RoutingModel;
  defaultOpen?: boolean;
  onPickModel: (entry: RoutingModel) => void;
  onPickEffort: (effort: Effort) => void;
}

const efforts: readonly Effort[] = ['low', 'medium', 'high'];
const popoverClass =
  'z-50 flex flex-col gap-1 rounded-md bg-popover p-1 outline-1 -outline-offset-1 outline-border-strong';
const rowClass =
  'flex h-8 w-full items-center gap-2 rounded-sm px-2.5 text-left text-[13px] leading-[18px] text-foreground transition-colors duration-(--duration-fast) ease-(--ease-out) hover:bg-surface-hover focus-visible:bg-surface-hover';
const chipButtonClass =
  'inline-flex h-[26px] items-center gap-1 rounded-sm px-2 text-xs leading-4 font-medium text-foreground-muted transition-colors duration-(--duration-fast) ease-(--ease-out) hover:bg-surface-hover data-[state=open]:bg-surface-hover';

function NeedLogin() {
  return (
    <span className="flex items-center gap-1 text-xs leading-4 font-medium text-warning">
      <CircleAlert aria-hidden className="size-3" />
      로그인 필요
    </span>
  );
}

function CheckMark({ isOn }: { isOn: boolean }) {
  return (
    <span className="flex size-3.5 shrink-0 items-center">
      {isOn && <Check aria-hidden className="size-3.5" />}
    </span>
  );
}

const isSameModel = (a: RoutingModel, b: RoutingModel) =>
  a.provider === b.provider && a.model === b.model;

function ModelRow({
  entry,
  isSelected,
  onPick,
}: {
  entry: RoutingModel;
  isSelected: boolean;
  onPick: () => void;
}) {
  return (
    <Popover.Close asChild>
      <button
        type="button"
        aria-current={isSelected ? 'true' : undefined}
        onClick={onPick}
        className={cn(rowClass, isSelected && 'bg-surface-hover')}
      >
        <CheckMark isOn={isSelected} />
        <span className="min-w-0 flex-1 truncate font-mono font-medium">{entry.model}</span>
        <span className="text-xs leading-4 text-foreground-muted">{entry.effort}</span>
        {entry.hasAccount ? (
          <span className="text-xs leading-4 text-foreground-muted">{entry.provider}</span>
        ) : (
          <NeedLogin />
        )}
      </button>
    </Popover.Close>
  );
}

function ModelChip({ routing }: { routing: ComposerRouting }) {
  const { chain, others, selected } = routing;
  return (
    <Popover.Root defaultOpen={routing.defaultOpen}>
      <Popover.Trigger className={chipButtonClass} aria-label={`모델 ${selected.model} 바꾸기`}>
        <Cpu aria-hidden className="size-3.5 text-foreground-muted" />
        <span className="font-mono">{selected.model}</span>
        <ChevronDown aria-hidden className="size-3 text-foreground-subtle" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          aria-label="모델 고르기"
          className={cn(popoverClass, 'w-[340px]')}
        >
          {(
            [
              ['모델', chain],
              ['다른 모델', others],
            ] as const
          ).map(([title, list]) => (
            <div key={title} className="flex flex-col gap-0.5">
              <p className="px-2.5 pt-1.5 pb-0.5 text-xs leading-4 font-medium text-foreground-muted">
                {title}
              </p>
              {list.map((entry) => (
                <ModelRow
                  key={`${entry.provider}/${entry.model}/${entry.effort ?? ''}`}
                  entry={entry}
                  isSelected={isSameModel(entry, selected)}
                  onPick={() => {
                    routing.onPickModel(entry);
                  }}
                />
              ))}
            </div>
          ))}
          <p className="px-2.5 pt-1 pb-1.5 text-xs leading-[18px] text-foreground-muted">
            고른 모델로 세션을 시작하고, 세션 기록에 "직접 고름"으로 남깁니다. 한도에 걸리면 엔진이
            다른 모델로 바꾸고 알림을 띄웁니다.
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function EffortChip({ routing }: { routing: ComposerRouting }) {
  const { effort } = routing.selected;
  if (effort === undefined) return null;
  return (
    <Popover.Root>
      <Popover.Trigger className={chipButtonClass} aria-label={`추론 강도 ${effort} 바꾸기`}>
        {effort}
        <ChevronDown aria-hidden className="size-3 text-foreground-subtle" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          aria-label="추론 강도 고르기"
          className={cn(popoverClass, 'w-40')}
        >
          {efforts.map((item) => (
            <Popover.Close key={item} asChild>
              <button
                type="button"
                aria-current={item === effort ? 'true' : undefined}
                onClick={() => {
                  routing.onPickEffort(item);
                }}
                className={cn(rowClass, item === effort && 'bg-surface-hover')}
              >
                <CheckMark isOn={item === effort} />
                {item}
              </button>
            </Popover.Close>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

interface ComposerProps {
  isRunning: boolean;
  /** 소프트 스톱을 보낸 뒤 멈추기를 기다리는 중입니다. 이때 한 번 더 중지하면 하드 킬입니다. */
  isStopping?: boolean;
  placeholder?: string;
  /** 입력창 아래에 보여 줄 값입니다. 값이 없는 칩은 그리지 않습니다. */
  chips?: ComposerChips;
  /** 있으면 모델·추론 강도 칩이 팝오버로 바뀌고, 없으면 chips의 글자만 보여 줍니다. */
  routing?: ComposerRouting;
  /** 중지 버튼과 Esc가 부릅니다. 없으면 중지 동작이 없습니다. */
  onStop?: () => void;
}

const idlePlaceholder = 'Ora에게 메시지, @파일, /명령';
const runningPlaceholder = '조향 메시지를 입력합니다. 현재 스텝이 끝난 뒤 반영합니다';
const stoppingPlaceholder = '멈추는 중입니다. 한 번 더 중지하면 강제로 종료합니다';

/** 입력창입니다. 실행 중에 보낸 입력은 조향 메시지입니다(SPEC 2.9절). */
export function Composer({
  isRunning,
  isStopping = false,
  placeholder,
  chips,
  routing,
  onStop,
}: ComposerProps) {
  const runningHint = isStopping ? stoppingPlaceholder : runningPlaceholder;
  const hint = placeholder ?? (isRunning ? runningHint : idlePlaceholder);
  const buttonClass =
    'flex size-[30px] shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors duration-(--duration-fast) ease-(--ease-out) hover:bg-foreground-muted';
  return (
    <ComposerPrimitive.Root className="flex w-[720px] max-w-full flex-col gap-2.5 rounded-xl border border-border bg-surface px-3.5 pt-3 pb-2.5">
      <ComposerPrimitive.Input
        rows={1}
        cancelOnEscape={false}
        placeholder={hint}
        aria-label="메시지 입력"
        className="w-full resize-none bg-transparent text-[15px] leading-[22px] text-foreground outline-none placeholder:text-foreground-subtle"
      />
      <div className="flex h-7 items-center gap-1.5">
        <Plus aria-hidden className="size-4 text-foreground-subtle" />
        {routing ? (
          <>
            <ModelChip routing={routing} />
            <EffortChip routing={routing} />
          </>
        ) : (
          <>
            {chips?.model && (
              <Chip>
                <Cpu aria-hidden className="size-3.5 text-foreground-muted" />
                {chips.model}
              </Chip>
            )}
            {chips?.effort && <Chip>{chips.effort}</Chip>}
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {chips?.permission && (
            <Chip>
              <Shield aria-hidden className="size-3.5 text-foreground-muted" />
              {chips.permission}
            </Chip>
          )}
          {isRunning && onStop && (
            <button
              type="button"
              aria-label={isStopping ? '강제 종료' : '중지'}
              onClick={onStop}
              className={cn(buttonClass, 'bg-surface-hover text-foreground hover:bg-surface')}
            >
              <Square aria-hidden className="size-3 fill-current" />
            </button>
          )}
          <ComposerPrimitive.Send
            className={buttonClass}
            aria-label={isRunning ? '조향 메시지 보내기' : '보내기'}
          >
            <ArrowUp aria-hidden className="size-4" />
          </ComposerPrimitive.Send>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}

/** 입력창 바로 아래의 한 줄입니다. 스텝 수, 격리 옵션, 컨텍스트 사용, 캐시 적중을 가운뎃점으로 나눕니다. */
export function StatusLine({
  items,
  context,
  cache,
}: {
  items: readonly StatusItem[];
  context?: ContextView | null;
  cache?: CacheView | null;
}) {
  const parts: ReactNode[] = [
    ...items.map((item, index) =>
      typeof item === 'string' ? (
        <span key={`${index}-${item}`} className="whitespace-nowrap">
          {item}
        </span>
      ) : (
        <span
          key={`${index}-${item.text}`}
          className="flex items-center gap-1 whitespace-nowrap font-medium text-warning"
        >
          <TriangleAlert aria-hidden className="size-3" />
          {item.text}
        </span>
      ),
    ),
    ...(context ? [<ContextStat key="context" context={context} />] : []),
    ...(cache ? [<CacheStat key="cache" cache={cache} />] : []),
  ];
  return (
    <div className="flex min-h-5 w-[720px] max-w-full flex-wrap items-center gap-x-2 px-3.5 text-xs leading-4 text-foreground-subtle">
      {parts.flatMap((part, index) =>
        index === 0 ? [part] : [<span key={`dot-${index}`}>·</span>, part],
      )}
    </div>
  );
}
