import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type TextMessagePartProps,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { ArrowUp, Cpu, Paperclip, Shield, Square, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { runAction, useActions } from '../store.tsx';
import { cn } from '../lib/cn.ts';
import { ToolLine } from './ToolLine.tsx';

interface ChatProviderProps {
  messages: readonly ThreadMessageLike[];
  children: ReactNode;
}

/**
 * 채팅 영역의 상태를 assistant-ui 외부 저장소 런타임에 연결합니다. 메시지의 정본은 이벤트 스트림입니다.
 * 실행 중에도 입력창이 메시지를 보내야 하므로(조향 메시지, SPEC 2.9절) 런타임에는 isRunning을 넘기지 않습니다.
 * 런타임은 isRunning이 true이고 queue 어댑터가 없으면 Enter 전송을 막기 때문입니다.
 */
export function ChatProvider({ messages, children }: ChatProviderProps) {
  const actions = useActions();
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: (message: ThreadMessageLike) => message,
    onNew: (message) => {
      const text = message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []));
      return actions.sendMessage(text.join('\n'));
    },
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

/** 글 안의 `코드 조각`을 고정폭 글꼴로 구분합니다. */
function InlineCode({ text }: { text: string }) {
  return text.split('`').map((chunk, index) =>
    index % 2 === 1 ? (
      <code key={index} className="font-mono text-[13px] text-foreground">
        {chunk}
      </code>
    ) : (
      chunk
    ),
  );
}

function ReplyText({ text }: TextMessagePartProps) {
  return (
    <p className="text-foreground-muted">
      <InlineCode text={text} />
    </p>
  );
}

function UserText({ text }: TextMessagePartProps) {
  return <p className="text-foreground">{text}</p>;
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="max-w-[520px] rounded-xl bg-surface px-4 py-2.5">
        <MessagePrimitive.Parts components={{ Text: UserText }} />
      </div>
    </MessagePrimitive.Root>
  );
}

function ToolGroup({ children }: { children?: ReactNode }) {
  return <div className="flex flex-col gap-1">{children}</div>;
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex flex-col gap-4">
      <MessagePrimitive.Parts
        components={{ Text: ReplyText, tools: { Fallback: ToolLine }, ToolGroup }}
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

interface ComposerProps {
  isRunning: boolean;
  placeholder?: string;
}

const idlePlaceholder = 'Ora에게 메시지, @파일, /명령';
const runningPlaceholder = '조향 메시지를 입력합니다. 현재 스텝이 끝난 뒤 반영합니다';

/** 입력창입니다. 실행 중에 보낸 입력은 조향 메시지입니다(SPEC 2.9절). */
export function Composer({ isRunning, placeholder }: ComposerProps) {
  const actions = useActions();
  const hint = placeholder ?? (isRunning ? runningPlaceholder : idlePlaceholder);
  const buttonClass =
    'flex size-[30px] shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors duration-(--duration-fast) ease-(--ease-out) hover:bg-foreground-muted';
  return (
    <ComposerPrimitive.Root className="flex w-[720px] max-w-full flex-col gap-2.5 rounded-xl bg-surface px-3.5 pt-3 pb-2.5">
      <ComposerPrimitive.Input
        rows={1}
        placeholder={hint}
        aria-label="메시지 입력"
        className="w-full resize-none bg-transparent text-[15px] leading-[22px] text-foreground outline-none placeholder:text-foreground-subtle"
      />
      <div className="flex h-7 items-center gap-1.5">
        <Paperclip aria-hidden className="size-4 text-foreground-subtle" />
        <Chip>
          <Cpu aria-hidden className="size-3.5 text-foreground-muted" />
          기본 모델
          <ChevronDown aria-hidden className="size-3 text-foreground-subtle" />
        </Chip>
        <Chip>
          medium
          <ChevronDown aria-hidden className="size-3 text-foreground-subtle" />
        </Chip>
        <Chip>
          <Shield aria-hidden className="size-3.5 text-foreground-muted" />
          승인 생략
        </Chip>
        <div className="ml-auto flex items-center gap-2">
          {isRunning && (
            <button
              type="button"
              aria-label="중지"
              onClick={() => {
                runAction(actions.cancelRun());
              }}
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

/** 입력창 바로 아래의 한 줄입니다. 스텝 수, 사용 모델, 격리 옵션을 가운뎃점으로 나눕니다. */
export function StatusLine({ items }: { items: readonly string[] }) {
  return (
    <p className="flex h-5 w-[720px] max-w-full items-center gap-2 px-3.5 text-xs leading-4 text-foreground-subtle">
      {items.flatMap((item, index) =>
        index === 0 ? [item] : [<span key={`dot-${index}`}>·</span>, item],
      )}
    </p>
  );
}
