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

export interface ThreadData {
  messages: ThreadMessageLike[];
  abortedCalls: number;
  lastEventAt: string | null;
}

/** 마지막 `stage` 진입 이벤트가 가리키는 단계 번호를 돌려줍니다. 진입한 단계가 없으면 null입니다. */
export function getStageIndex(events: readonly OraEvent[]): number | null {
  const entered = events.findLast((event) => event.type === 'stage');
  return entered ? stages.indexOf(entered.payload.stage) : null;
}

/**
 * 이벤트 스트림을 채팅 메시지로 바꿉니다.
 * `waitingCallIds`는 승인이나 답을 기다리는 호출입니다. 이 호출은 카드로 그리므로 메시지에서 뺍니다.
 * 그 밖에 결과가 없는 도구 호출은 실행 중인 호출로 메시지에 넣습니다.
 */
export function buildThread(
  events: readonly OraEvent[],
  waitingCallIds: ReadonlySet<string>,
): ThreadData {
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

  for (const event of events) {
    if (event.type === 'message') {
      const text = event.payload.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n\n');
      // 엔진과 도구가 대화에 끼워 넣는 상태 안내(현재 todo, 현재 단계)는 사용자가 쓴 글이 아니므로 말풍선으로 그리지 않습니다.
      if (text === '' || (event.payload.role === 'user' && event.actor !== 'user')) continue;
      if (event.payload.role === 'assistant') {
        assistantContent.push({ type: 'text', text });
      } else {
        flushAssistant();
        messages.push({ role: 'user', content: [{ type: 'text', text }] });
      }
    } else if (event.type === 'permission' && event.payload.warning) {
      assistantContent.push({ type: 'data-warning', data: { text: event.payload.warning } });
    } else if (event.type === 'tool_call' && !waitingCallIds.has(event.payload.callId)) {
      const { callId, tool, args } = event.payload;
      assistantContent.push({
        type: 'tool-call',
        toolCallId: callId,
        toolName: tool,
        args: args as JsonObject,
        result: results.get(callId),
      });
    }
  }
  flushAssistant();

  return { messages, abortedCalls, lastEventAt: events.at(-1)?.ts ?? null };
}

/**
 * 새로 만든 메시지 목록에서 내용이 같은 메시지는 이전 객체를 그대로 씁니다.
 * 이벤트가 올 때마다 바뀌지 않은 메시지를 다시 그리지 않게 합니다(SPEC 8.2절).
 */
export function reuseMessages(
  previous: readonly ThreadMessageLike[],
  next: readonly ThreadMessageLike[],
): ThreadMessageLike[] {
  return next.map((message, index) => {
    const old = previous[index];
    return old && JSON.stringify(old) === JSON.stringify(message) ? old : message;
  });
}
