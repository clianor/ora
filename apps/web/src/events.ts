import { stageSchema, type OraEvent, type Stage } from '@ora/protocol';
import type { ThreadMessageLike } from '@assistant-ui/react';
import { getStepRange, type StepRange } from './lib/context.ts';

type MessageContent = Exclude<ThreadMessageLike['content'], string>;
type ToolPart = Extract<MessageContent[number], { type: 'tool-call' }>;
type JsonObject = NonNullable<ToolPart['args']>;

export const stages: readonly Stage[] = stageSchema.options;

export const stageLabels: Record<Stage, string> = {
  understand: 'Understand',
  research: 'Research',
  decide: 'Decide',
  plan: 'Plan',
  execute: 'Execute',
  verify: 'Verify',
  operate: 'Operate',
  learn: 'Learn',
};

export interface ToolResultView {
  status: 'ok' | 'error' | 'aborted' | 'timeout';
  summary: string;
}

/** 도구 호출 줄의 동사입니다. 목록에 없는 도구는 이름을 그대로 적습니다. */
export const toolVerbs: Record<string, string> = {
  read: '읽기',
  edit: '수정',
  search: '검색',
  bash: '실행',
  file_read: '읽기',
  file_edit: '수정',
  file_write: '쓰기',
  shell: '실행',
  'verify.run': '검증',
  'history.read': '원문 보기',
  skill: '스킬',
};

/** MCP 도구는 이름이 `서버:도구`입니다. 줄의 대상은 도구 이름 뒤에 인자 요약(`#12`, `key=값`)을 붙여 보입니다. */
export function isMcpTool(toolName: string): boolean {
  return toolName.includes(':');
}

export function summarizeMcpArgs(toolName: string, args: Record<string, unknown>): string {
  const parts = Object.entries(args).flatMap(([key, value]) => {
    if (key === 'intent') return [];
    if (typeof value === 'number')
      return [key === 'number' || key === 'id' ? `#${value}` : `${key}=${value}`];
    return typeof value === 'string' && value !== '' ? [`${key}=${value}`] : [];
  });
  return [toolName, ...parts].join(' ');
}

/** 도구 호출 줄의 대상 글자입니다. 경로, 명령, 패턴, 의도 순으로 처음 있는 값을 씁니다. */
export function readToolTarget(args: Record<string, unknown>): string {
  for (const key of ['path', 'command', 'pattern', 'intent']) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

/** 압축 이벤트가 대화에 남기는 표시입니다. 가지치기는 생략한 호출의 도구 이름과 대상을 목록으로 갖습니다. */
export interface CompactionMarkData {
  sessionId: string;
  ts: string;
  method: Extract<OraEvent, { type: 'compaction' }>['payload']['method'];
  /** 압축이 바꾼 스텝 범위입니다. 스텝을 알 수 없으면 null입니다. */
  range: StepRange | null;
  path?: string;
  count: number;
  items: { tool: string; target: string }[];
}

/** `retry` 이벤트 하나가 만든 모델 전환입니다. 화면 오른쪽 위 알림이 씁니다. from은 전환 전에 쓰던 모델입니다. */
export interface ModelSwitchData {
  seq: number;
  ts: string;
  reason: Extract<OraEvent, { type: 'retry' }>['payload']['reason'];
  from: string;
  to: string;
  /** 실패한 요청의 오류 원문입니다. 표시의 title로만 보입니다. */
  message?: string;
  /** 사용 한도 해제 시각(ISO)입니다. */
  resetAt?: string;
}

/** 상태를 헤더와 할 일 패널이 이미 보여 주는 제어 도구입니다. 실패했을 때만 줄로 보입니다. */
const controlTools = new Set(['ask_user', 'todo.update', 'stage.advance', 'memory.propose']);

/** 질문 하나의 답을 짧은 글로 만듭니다. */
function formatAnswer(
  question: string,
  choices: readonly string[],
  text: string | undefined,
): string {
  const parts = [...choices, ...(text ? [`직접 입력: ${text}`] : [])];
  return `${question}\n→ ${parts.join(', ')}`;
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

/** `retry` 이벤트마다 전환 전과 후의 모델을 찾습니다. 전환 전 모델은 같은 역할이 직전 체인 위치에서 마지막으로 요청한 모델입니다. */
export function listModelSwitches(events: readonly OraEvent[]): ModelSwitchData[] {
  const modelNames = new Map<string, string>();
  const positions = new Map<string, number>();
  return events.flatMap((event) => {
    if (event.type === 'model_request') {
      modelNames.set(
        `${event.payload.role ?? 'default'}:${event.payload.chainPosition}`,
        event.payload.model,
      );
      return [];
    }
    if (event.type !== 'retry') return [];
    const { role, chainPosition, reason, message, resetAt, switchedTo } = event.payload;
    const previous = positions.get(role) ?? 0;
    positions.set(role, chainPosition);
    return [
      {
        seq: event.seq,
        ts: event.ts,
        reason,
        from: modelNames.get(`${role}:${previous}`) ?? (previous === 0 ? '첫 모델' : '이전 모델'),
        to: switchedTo,
        ...(message === undefined ? {} : { message }),
        ...(resetAt === undefined ? {} : { resetAt }),
      },
    ];
  });
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

  const questionsByCall = new Map<string, readonly { question: string }[]>();
  for (const event of events) {
    if (event.type === 'question') {
      questionsByCall.set(event.payload.callId, event.payload.questions);
    }
  }

  /** `verify.run` 호출은 todo ID만 인자로 받으므로, 줄에는 그 todo가 선언한 검증 명령을 보입니다. */
  const verifyCommands = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'todo_update' && event.payload.todo.verify !== undefined) {
      verifyCommands.set(event.payload.todoId, event.payload.todo.verify.command);
    }
  }
  const calls = new Map<string, { tool: string; target: string }>();
  for (const event of events) {
    if (event.type === 'tool_call') {
      calls.set(event.payload.callId, {
        tool: event.payload.tool,
        target: readToolTarget(event.payload.args),
      });
    }
  }
  /** `history.read`가 가리키는 원문의 이름입니다. 호출 ID면 그 호출의 대상과 동사, 범위면 seq 범위입니다. */
  const describeHistoryRead = (args: Record<string, unknown>): string => {
    if (typeof args.callId === 'string') {
      const call = calls.get(args.callId);
      return call
        ? `${call.target} ${toolVerbs[call.tool] ?? call.tool} 결과`.trim()
        : `호출 ${args.callId}`;
    }
    return `seq ${String(args.fromSeq)}~${String(args.toSeq)}`;
  };

  const failedMcpServers = new Set<string>();
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
    } else if (event.type === 'answer') {
      const questions = questionsByCall.get(event.payload.callId) ?? [];
      const text = event.payload.answers
        .map((answer, index) =>
          formatAnswer(
            questions[index]?.question ?? `질문 ${index + 1}`,
            answer.choices,
            answer.text,
          ),
        )
        .join('\n\n');
      flushAssistant();
      messages.push({ role: 'user', content: [{ type: 'text', text }] });
    } else if (event.type === 'permission' && event.payload.warning) {
      assistantContent.push({ type: 'data-warning', data: { text: event.payload.warning } });
    } else if (event.type === 'mcp_server') {
      const { server, outcome } = event.payload;
      if (outcome === 'failed') {
        failedMcpServers.add(server);
        assistantContent.push({ type: 'data-mcp', data: { server, outcome } });
      } else if (failedMcpServers.delete(server)) {
        assistantContent.push({ type: 'data-mcp', data: { server, outcome: 'recovered' } });
      }
    } else if (event.type === 'review') {
      assistantContent.push({ type: 'data-review', data: event.payload });
    } else if (event.type === 'recall') {
      for (const skill of event.payload.skills) {
        assistantContent.push({
          type: 'tool-call',
          toolCallId: `recall-${String(event.seq)}-${skill.scope}-${skill.name}`,
          toolName: 'skill',
          args: { label: skill.name, scope: skill.scope },
          result: { status: 'ok', summary: skill.scope },
        });
      }
    } else if (event.type === 'compaction') {
      const { method, fromSeq, toSeq, path, prunedCallIds } = event.payload;
      const data: CompactionMarkData = {
        sessionId: event.sessionId,
        ts: event.ts,
        method,
        range: getStepRange(events, fromSeq, toSeq),
        ...(path === undefined ? {} : { path }),
        count: prunedCallIds.length,
        items: prunedCallIds.flatMap((callId) => {
          const call = calls.get(callId);
          return call ? [call] : [];
        }),
      };
      assistantContent.push({ type: 'data-compaction', data });
    } else if (event.type === 'tool_call' && !waitingCallIds.has(event.payload.callId)) {
      const { callId, tool, args } = event.payload;
      if (controlTools.has(tool) && (results.get(callId)?.status ?? 'ok') === 'ok') continue;
      let labeled: Record<string, unknown> = args;
      if (tool === 'history.read') labeled = { ...args, label: describeHistoryRead(args) };
      else if (tool === 'verify.run') {
        const command = verifyCommands.get(String(args.todoId));
        if (command !== undefined) labeled = { ...args, label: command };
      }
      assistantContent.push({
        type: 'tool-call',
        toolCallId: callId,
        toolName: tool,
        args: labeled as JsonObject,
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
