import { stageSchema, type OraEvent, type Stage } from '@ora/protocol';
import type { ThreadMessageLike } from '@assistant-ui/react';

type MessageContent = Exclude<ThreadMessageLike['content'], string>;
type ToolPart = Extract<MessageContent[number], { type: 'tool-call' }>;
type JsonObject = NonNullable<ToolPart['args']>;

export const stages: readonly Stage[] = stageSchema.options;

export interface ToolResultView {
  status: 'ok' | 'error' | 'aborted' | 'timeout';
  summary: string;
}

interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionSpec {
  header: string;
  question: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

export interface PendingCommand {
  callId: string;
  command: string;
  cwd: string;
}

export interface ThreadData {
  messages: ThreadMessageLike[];
  pendingCommand: PendingCommand | null;
  pendingQuestions: QuestionSpec[] | null;
  /** `pendingQuestions`를 만든 `ask_user` 호출의 ID입니다. */
  pendingQuestionCallId: string | null;
  abortedCalls: number;
  lastEventAt: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** `ask_user` 호출 인자에서 질문 목록을 읽습니다. 모양이 맞지 않는 항목은 건너뜁니다. */
function readQuestions(args: Record<string, unknown>): QuestionSpec[] {
  const raw = Array.isArray(args.questions) ? (args.questions as unknown[]) : [];
  return raw.filter(isRecord).map((item) => ({
    header: readString(item.header),
    question: readString(item.question),
    multiSelect: item.multiSelect === true,
    options: (Array.isArray(item.options) ? (item.options as unknown[]) : [])
      .filter(isRecord)
      .map((option) => ({
        label: readString(option.label),
        description: readString(option.description),
      })),
  }));
}

/** 마지막 `stage` 진입 이벤트가 가리키는 단계 번호를 돌려줍니다. 진입한 단계가 없으면 null입니다. */
export function getStageIndex(events: readonly OraEvent[]): number | null {
  const entered = events.findLast((event) => event.type === 'stage');
  return entered ? stages.indexOf(entered.payload.stage) : null;
}

/**
 * 이벤트 스트림을 채팅 메시지로 바꿉니다.
 * 결과가 없는 `ask_user`와 승인 요청(`approvalCallId`)의 호출은 메시지가 아니라 답을 기다리는 카드로 돌려줍니다.
 * 그 밖에 결과가 없는 도구 호출은 실행 중인 호출로 메시지에 넣습니다.
 */
export function buildThread(events: readonly OraEvent[], approvalCallId?: string): ThreadData {
  const results = new Map<string, ToolResultView>();
  let abortedCalls = 0;
  for (const event of events) {
    if (event.type !== 'tool_result') continue;
    results.set(event.payload.callId, {
      status: event.payload.status,
      summary: event.payload.summary,
    });
    if (event.payload.status === 'aborted') abortedCalls += 1;
  }

  const messages: ThreadMessageLike[] = [];
  const assistantContent: MessageContent[number][] = [];
  const flushAssistant = () => {
    if (assistantContent.length === 0) return;
    messages.push({ role: 'assistant', content: [...assistantContent] });
    assistantContent.length = 0;
  };

  let pendingCommand: PendingCommand | null = null;
  let pendingQuestions: QuestionSpec[] | null = null;
  let pendingQuestionCallId: string | null = null;

  for (const event of events) {
    if (event.type === 'message') {
      const text = event.payload.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n\n');
      if (event.payload.role === 'assistant') {
        assistantContent.push({ type: 'text', text });
      } else {
        flushAssistant();
        messages.push({ role: 'user', content: [{ type: 'text', text }] });
      }
    } else if (event.type === 'tool_call') {
      const { callId, tool, args } = event.payload;
      const result = results.get(callId);
      if (result) {
        assistantContent.push({
          type: 'tool-call',
          toolCallId: callId,
          toolName: tool,
          args: args as JsonObject,
          result,
        });
      } else if (tool === 'ask_user') {
        pendingQuestions = readQuestions(args);
        pendingQuestionCallId = callId;
      } else if (callId !== approvalCallId) {
        assistantContent.push({
          type: 'tool-call',
          toolCallId: callId,
          toolName: tool,
          args: args as JsonObject,
        });
      } else {
        pendingCommand = {
          callId,
          command: readString(args.command),
          cwd: readString(args.cwd),
        };
      }
    }
  }
  flushAssistant();

  return {
    messages,
    pendingCommand,
    pendingQuestions,
    pendingQuestionCallId,
    abortedCalls,
    lastEventAt: events.at(-1)?.ts ?? null,
  };
}
