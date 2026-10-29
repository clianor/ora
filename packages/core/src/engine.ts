import type {
  ApprovalRequest,
  ApprovalRule,
  ApprovalScope,
  ContentBlock,
  EndReason,
  Evidence,
  Isolation,
  PermissionMode,
  SessionRecord,
  SessionStatus,
  Stage,
  Todo,
  TodoStatus,
  ToolTier,
} from '@ora/protocol';
import { z } from 'zod';
import {
  askUserSchema,
  buildToolSpecs,
  isControlTool,
  memoryProposeSchema,
  stageAdvanceSchema,
  todoUpdateSchema,
  verifyRunSchema,
} from './control-tools.ts';
import { assessRisk, decidePermission } from './permission.ts';
import { findHarnessCliCall } from './harness-cli.ts';
import type { ToolPolicy } from './permission.ts';
import type { AlwaysApprovalPort, ApprovalPort, QuestionPort } from './ports/approval.ts';
import type { CommandRunner } from './ports/command-runner.ts';
import type { MemoryPort } from './ports/memory.ts';
import type { ModelMessage, ModelPort, ModelRequest, ModelStreamEvent } from './ports/model.ts';
import type { SessionStore } from './ports/session-store.ts';
import type { Clock } from './ports/system.ts';
import type { Tool, ToolOutput } from './ports/tool.ts';
import type { TranscriptSink } from './ports/transcript-sink.ts';
import type { WorkspacePort } from './ports/workspace.ts';
import { assembleSystemPrompt, describeTodos } from './prompt.ts';
import { createRecorder } from './recorder.ts';
import {
  HANDOFF_PROMPT,
  SUMMARY_SYSTEM,
  TURN_PREFIX_SYSTEM,
  applyPrune,
  buildSummaryDocument,
  buildSummaryInput,
  estimateTokens,
  findKeepCut,
  findTurnStart,
  narrativeOf,
  planPrune,
  shakeBoundarySeq,
  shakeMessages,
  summaryMessage,
} from './compaction.ts';
import { appendMessage } from './recovery.ts';
import type { ResumePlan } from './recovery.ts';
import { describeScrubHits, mergeScrubHits, scrubText, scrubValue } from './scrub.ts';
import type { ScrubHits } from './scrub.ts';
import { STAGES, checkStageExit, isBackwardAllowed } from './stages.ts';
import { formatKst } from './time.ts';
import { applyModelTodoEntry } from './todos.ts';

export interface EngineSettings {
  readonly permissionMode: PermissionMode;
  readonly toolPolicies: Readonly<Record<string, ToolPolicy>>;
  readonly isolation: Isolation;
  readonly engineVersion: string;
  readonly maxSteps: number;
  readonly maxRepairsPerTodo: number;
  readonly noProgressSteps: number;
  readonly shellTimeoutMs: number;
  readonly recallTokenBudget: number;
  /** 입력 토큰이 `contextWindow × compactAtRatio`에 닿으면 압축한다. */
  readonly compactAtRatio: number;
  readonly keepRecentTokens: number;
  readonly protectToolTokens: number;
  readonly minPruneSavings: number;
  readonly methodOrder: readonly ('shake' | 'handoff' | 'summary')[];
  /** 모델 컨텍스트 창이다. 모르면 비워 두고, 그러면 압축도 넘침 검사도 하지 않는다. */
  readonly contextWindow?: number;
}

export interface EngineDeps {
  readonly model: ModelPort;
  readonly tools: readonly Tool[];
  readonly runner: CommandRunner;
  readonly sink: TranscriptSink;
  readonly store: SessionStore;
  readonly workspace: WorkspacePort;
  readonly memory: MemoryPort;
  readonly clock: Clock;
  /** 없으면 승인이 필요한 호출을 headless 거부로 처리한다. */
  readonly approval?: ApprovalPort;
  /** 없으면 `ask_user`를 headless 오류로 돌려준다. */
  readonly questions?: QuestionPort;
  /** "항상 승인" 저장소다. 없으면 "항상 승인"을 이 세션 동안의 승인으로 다룬다. */
  readonly alwaysApprovals?: AlwaysApprovalPort;
}

export interface RunInput {
  readonly sessionId: string;
  readonly task: string;
  readonly cwd: string;
  readonly repo?: string;
  readonly settings: EngineSettings;
  readonly configSummary: Record<string, unknown>;
  /** 하드 킬 신호다. 진행 중인 도구 호출과 모델 요청을 바로 끊는다. */
  readonly signal: AbortSignal;
  /** 소프트 스톱 신호다. 진행 중인 도구 호출은 끝까지 기다리고, 아직 시작하지 않은 일은 하지 않는다. */
  readonly softStop: AbortSignal;
  readonly resume?: ResumeInput;
}

/** 멈춘 세션을 잇는 데 필요한 입력이다. 호스트가 transcript를 봉인한 뒤 `planResume`으로 만든다. */
export interface ResumeInput {
  readonly plan: ResumePlan;
  readonly session: SessionRecord;
  readonly steer?: string;
}

export interface RunOutcome {
  readonly status: SessionStatus;
  readonly endReason: EndReason;
  readonly summary: string;
  readonly todos: readonly Todo[];
}

interface ToolCall {
  readonly callId: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
}

interface CallResult {
  readonly text: string;
  readonly isError: boolean;
  /** `tool_result` 이벤트에 적은 요약이다. 재개가 같은 값을 읽는다. */
  readonly summary: string;
}

interface ControlOutput extends ToolOutput {
  readonly outputRef?: string;
  readonly scrubHits?: Readonly<ScrubHits>;
}

/** 압축한 뒤 어림값이 기준선의 이 비율 이하여야 여유를 만들었다고 본다 (SPEC 4.3절 진행 보증). */
const PROGRESS_RATIO = 0.8;
/** 요약 문서가 차지할 토큰의 어림이다. 남길 범위를 줄일 때 뺀다. */
const SUMMARY_RESERVE_TOKENS = 2000;
/** 압축이 여유를 만들지 못했을 때 창 안에서 다시 시도하기까지 기다리는 모델 응답 수다. */
const PASS_RETRY_RESPONSES = 3;
const SUMMARY_MAX_LINES = 20;
const SUMMARY_MAX_CHARS = 2048;
const EVENT_SUMMARY_MAX_CHARS = 500;

function summarizeOutput(text: string, maxChars: number): string {
  const tailLines = text.split('\n').slice(-SUMMARY_MAX_LINES).join('\n');
  return tailLines.length > maxChars ? tailLines.slice(-maxChars) : tailLines;
}

function formatCommandOutput(result: {
  exitCode?: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}): string {
  const status = result.timedOut ? 'timeout' : `exit code: ${result.exitCode ?? 'signal'}`;
  return `${status}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
}

/** 키 순서와 상관없이 같은 값이면 같은 문자열이 되게 객체 키를 정렬해 직렬화한다. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function ruleKey(rule: ApprovalRule): string {
  return stableStringify(
    'command' in rule ? [rule.tool, rule.command, rule.cwd] : [rule.tool, rule.args],
  );
}

/** 도구가 쓰는 cwd다. 경로 정규화는 하지 않으므로 문자열이 다르면 다른 규칙이 되어 다시 묻는다. */
function joinCwd(sessionCwd: string, requested: unknown): string {
  if (typeof requested !== 'string' || requested === '') return sessionCwd;
  return requested.startsWith('/') ? requested : `${sessionCwd.replace(/\/$/, '')}/${requested}`;
}

const STATUS_RANK: Record<TodoStatus, number> = {
  pending: 0,
  interrupted: 0,
  failed: 1,
  attempted: 1,
  claimed_verified: 2,
  verified: 3,
};

export async function runSession(deps: EngineDeps, input: RunInput): Promise<RunOutcome> {
  const { model, runner, store, workspace, memory, clock } = deps;
  const { settings, signal, softStop, resume } = input;
  const recorder = createRecorder(input.sessionId, deps.sink, clock, resume?.plan.lastSeq);
  const toolMap = new Map(deps.tools.map((tool) => [tool.name, tool]));
  const todos = new Map<string, Todo>(resume?.plan.todos.map((todo) => [todo.id, todo] as const));
  const now = () => formatKst(clock.now());
  const emit: (typeof recorder)['emit'] = (actor, draft) => recorder.emit(actor, draft, stepId);

  let stepId = 'step-0';
  let stage: Stage = resume?.plan.stage ?? 'understand';
  const getStage = (): Stage => stage;

  const promptFiles = await workspace.readPromptFiles();
  const instructionFiles = await workspace.readInstructionFiles();
  const harnessFiles =
    settings.isolation === 'clean-home' ? await workspace.findHarnessFiles() : [];
  const recall = await memory.recall({
    query: input.task,
    tokenBudget: settings.recallTokenBudget,
  });
  const specs = buildToolSpecs(deps.tools);
  const system = scrubText(
    assembleSystemPrompt({
      promptFiles,
      tools: specs,
      permissionMode: settings.permissionMode,
      isolation: settings.isolation,
      instructionFiles,
      recall,
      cwd: input.cwd,
    }),
  ).text;
  const promptHash = await workspace.hashText(
    JSON.stringify({
      prompts: promptFiles.map((file) => [file.name, file.content]),
      instructions: instructionFiles.map((file) => [file.path, file.sha256]),
    }),
  );

  const createdAt = now();
  let session: SessionRecord = resume?.session ?? {
    schemaVersion: 1,
    id: input.sessionId,
    createdAt,
    updatedAt: createdAt,
    title: scrubText(input.task.slice(0, 80)).text,
    actor: 'user',
    status: 'created',
    ...(input.repo === undefined ? {} : { repo: input.repo }),
    models: [{ model: model.model, role: 'default' }],
    permissionMode: settings.permissionMode,
    isolation: settings.isolation,
    promptHash,
    engineVersion: settings.engineVersion,
  };
  const saveSession = async (patch: Partial<SessionRecord>) => {
    session = { ...session, ...patch, updatedAt: now() };
    await store.saveSession(session);
  };
  const saveTodos = () => store.saveTodos(scrubValue([...todos.values()]));

  let taskSeq = 0;
  if (resume === undefined) {
    await emit('engine', {
      type: 'session_start',
      payload: {
        configSummary: input.configSummary,
        isolation: settings.isolation,
        ...(harnessFiles.length === 0 ? {} : { harnessFilesFound: [...harnessFiles] }),
        permissionMode: settings.permissionMode,
        instructionFiles: instructionFiles.map((file) => ({
          path: file.path,
          sha256: file.sha256,
        })),
        promptHash,
      },
    });
    await saveSession({});
    await saveSession({ status: 'running' });
    await emit('user', {
      type: 'message',
      payload: {
        role: 'user',
        content: [{ type: 'text', text: input.task }],
        instructions: [input.task],
      },
    });
    taskSeq = recorder.lastSeq();
    await emit('engine', { type: 'stage', payload: { outcome: 'entered', stage } });
  }

  const enterStage = async (to: Stage) => {
    stage = to;
    await emit('engine', { type: 'stage', payload: { outcome: 'entered', stage: to } });
  };

  const finish = async (
    status: SessionStatus,
    endReason: EndReason,
    summary: string,
  ): Promise<RunOutcome> => {
    const eventHits = recorder.scrubbedHits();
    const hitNote =
      Object.keys(eventHits).length > 0 ? ` [scrubbed: ${describeScrubHits(eventHits)}]` : '';
    const safeSummary = scrubText(summary).text + hitNote;
    await emit('engine', {
      type: 'session_end',
      payload: { status, endReason, summary: safeSummary },
    });
    await saveTodos();
    await saveSession({ status, endReason });
    return { status, endReason, summary: safeSummary, todos: [...todos.values()] };
  };

  const interruptActiveTodos = async () => {
    for (const todo of [...todos.values()]) {
      if (todo.status !== 'attempted') continue;
      const updated: Todo = { ...todo, status: 'interrupted', updatedAt: now() };
      todos.set(updated.id, updated);
      await emit('engine', {
        type: 'todo_update',
        payload: { todoId: updated.id, from: todo.status, to: 'interrupted', todo: updated },
      });
    }
  };

  // 승인이나 질문에 답을 기다리는 동안의 상태다. 답 없이 중단하면 이 값이 `cancel` 이벤트의 직전 상태가 된다.
  let waiting: SessionStatus | undefined;

  /** 하드 킬 신호가 있으면 `crashed`, 소프트 스톱이면 진행 중이던 todo를 `interrupted`로 남기고 `interrupted`로 끝낸다. */
  const finishCancelled = async (): Promise<RunOutcome> => {
    const mode = signal.aborted ? 'hard' : 'soft';
    await emit('engine', {
      type: 'cancel',
      payload: { mode, previousStatus: waiting ?? 'running' },
    });
    if (mode === 'hard') return finish('crashed', 'user_cancel', '사용자가 강제 종료했습니다.');
    await interruptActiveTodos();
    return finish('interrupted', 'user_cancel', '사용자가 중단했습니다.');
  };

  // "이 세션 동안" 승인한 규칙이다. session.json에 저장해 재개한 뒤에도 유지한다.
  const sessionRules: ApprovalRule[] = [...(resume?.session.approvals ?? [])];
  type Authorization = { readonly denied: string } | { readonly editedCommand?: string };

  const authorize = async (
    call: ToolCall,
    tier: ToolTier,
    intent: string,
  ): Promise<Authorization> => {
    const policy = settings.toolPolicies[call.tool];
    const verdict = decidePermission({
      mode: settings.permissionMode,
      tier,
      ...(policy === undefined ? {} : { policy }),
    });
    const verifyTodoId = typeof call.input.todoId === 'string' ? call.input.todoId : '';
    const verifyTodo = call.tool === 'verify.run' ? todos.get(verifyTodoId) : undefined;
    const command = call.tool === 'shell' ? call.input.command : verifyTodo?.verify?.command;
    // 차단 대상이면 권한 모드와 기억된 승인을 무시하고 매번 사용자에게 묻는다.
    const blockedCli =
      harnessFiles.length > 0 && typeof command === 'string'
        ? findHarnessCliCall(command)
        : undefined;
    const record = (
      decision: 'auto' | 'approved' | 'denied',
      extra: { scope?: ApprovalScope; editedCommand?: string; warning?: string } = {},
    ) =>
      emit('engine', {
        type: 'permission',
        payload: {
          callId: call.callId,
          mode: settings.permissionMode,
          ...(policy === undefined ? {} : { policy }),
          decision,
          ...(typeof command === 'string' ? { originalCommand: command } : {}),
          ...extra,
        },
      });

    if (verdict === 'auto' && blockedCli === undefined) {
      await record('auto');
      return {};
    }
    if (verdict === 'deny') {
      await record('denied');
      return { denied: `권한 거부: 도구 ${call.tool}의 정책이 deny입니다.` };
    }
    const rest = Object.fromEntries(
      Object.entries(call.input).filter(([name]) => name !== 'intent'),
    );
    const cwd = joinCwd(input.cwd, call.input.cwd);
    const rule: ApprovalRule =
      typeof command === 'string'
        ? { tool: call.tool, command, cwd }
        : { tool: call.tool, args: rest };
    const key = ruleKey(rule);
    if (blockedCli === undefined && sessionRules.some((entry) => ruleKey(entry) === key)) {
      await record('approved', { scope: 'session' });
      return {};
    }
    if (blockedCli === undefined && (await deps.alwaysApprovals?.has(rule))) {
      await record('approved', { scope: 'always' });
      return {};
    }
    if (deps.approval === undefined) {
      await record('denied');
      return {
        denied:
          blockedCli === undefined
            ? `권한 거부: ${settings.permissionMode} 모드에서 ${tier} 티어 호출은 승인이 필요하지만, headless 실행은 승인을 받을 수 없습니다. 다른 방법을 찾습니다.`
            : `격리 차단: clean-home에서 하네스 파일이 있는 폴더라 하네스 CLI(${blockedCli})를 실행하지 않았습니다. headless 실행은 승인을 받을 수 없습니다.`,
      };
    }

    let detail: ApprovalRequest['detail'];
    if (typeof command === 'string') {
      detail = { kind: 'shell', command, cwd, risk: assessRisk(command) };
    } else if (call.tool === 'file_write') {
      detail = {
        kind: 'file',
        path: String(call.input.path),
        content: String(call.input.content),
      };
    } else {
      detail = { kind: 'arguments', args: rest };
    }
    const linked = verifyTodo ?? [...todos.values()].find((todo) => todo.status === 'attempted');
    const request: ApprovalRequest = {
      callId: call.callId,
      tool: call.tool,
      tier,
      reason:
        blockedCli === undefined
          ? intent
          : `clean-home 격리: 하네스 파일이 있는 폴더에서 하네스 CLI(${blockedCli})를 실행합니다. ${intent}`,
      detail,
      ...(linked === undefined ? {} : { todo: { id: linked.id, content: linked.content } }),
    };
    // SPEC 4.1.1절: 이벤트를 먼저 쓰고 그다음 session.json을 바꾼다.
    await emit('engine', { type: 'approval_request', payload: request });
    await saveSession({ status: 'awaiting_approval' });
    waiting = 'awaiting_approval';
    const decision = await deps.approval.request(request, AbortSignal.any([signal, softStop]));
    // 중단 때문에 거부로 끝났으면 `running`으로 돌리지 않고 `cancel` 이벤트가 직전 상태를 기록하게 한다.
    const keepWaiting = (signal.aborted || softStop.aborted) && decision.outcome === 'denied';
    const restoreRunning = async () => {
      if (keepWaiting) return;
      waiting = undefined;
      await saveSession({
        status: 'running',
        ...(sessionRules.length === 0 ? {} : { approvals: sessionRules }),
      });
    };

    if (decision.outcome === 'denied') {
      await record('denied');
      await restoreRunning();
      const steer = decision.steer === undefined ? '' : ` 사용자 지시: ${decision.steer}`;
      if (decision.steer !== undefined) pendingSteers.push(scrubText(decision.steer).text);
      return { denied: `사용자가 ${call.tool} 호출을 거부했습니다.${steer}` };
    }
    const edited =
      call.tool === 'shell' && decision.editedCommand !== command
        ? decision.editedCommand
        : undefined;
    let warning: string | undefined;
    // 고친 명령을 승인했으면 원본이 아니라 고친 명령을 기억한다.
    const remembered: ApprovalRule =
      edited === undefined || !('command' in rule) ? rule : { ...rule, command: edited };
    if (decision.scope === 'session' || (decision.scope === 'always' && !deps.alwaysApprovals)) {
      sessionRules.push(remembered);
    } else if (decision.scope === 'always') {
      const saved = await deps.alwaysApprovals?.add(remembered);
      if (saved?.saved === false) {
        // 저장에 실패해도 이번 승인은 적용하고, 같은 세션에서는 다시 묻지 않도록 세션 규칙으로 둔다.
        sessionRules.push(remembered);
        warning = `항상 승인을 저장하지 못해 이 세션 동안만 적용합니다: ${saved.reason}`;
      }
    }
    await record('approved', {
      scope: decision.scope,
      ...(edited === undefined ? {} : { editedCommand: edited }),
      ...(warning === undefined ? {} : { warning }),
    });
    await restoreRunning();
    return edited === undefined ? {} : { editedCommand: edited };
  };

  const updateTodos = async (data: z.infer<typeof todoUpdateSchema>): Promise<ToolOutput> => {
    const lines: string[] = [];
    let anyRejected = false;
    for (const entry of data.todos) {
      const outcome = applyModelTodoEntry(todos, entry, now(), settings.maxRepairsPerTodo);
      await emit('model', {
        type: 'todo_update',
        payload: {
          todoId: entry.id,
          ...(outcome.from === undefined ? {} : { from: outcome.from }),
          to: outcome.to,
          todo: outcome.todo,
          ...(outcome.rejected === undefined ? {} : { rejected: { reason: outcome.rejected } }),
        },
      });
      anyRejected ||= outcome.rejected !== undefined;
      lines.push(
        outcome.rejected === undefined
          ? `${entry.id}: ${outcome.from ?? '신규'} → ${outcome.to}`
          : `${entry.id}: 거부됨: ${outcome.rejected}`,
      );
    }
    await saveTodos();
    return { status: anyRejected ? 'error' : 'ok', text: lines.join('\n') };
  };

  const runVerify = async (
    data: z.infer<typeof verifyRunSchema>,
    callId: string,
  ): Promise<ControlOutput> => {
    const todo = todos.get(data.todoId);
    if (todo === undefined) return { status: 'error', text: `todo ${data.todoId}가 없습니다.` };
    if (todo.verify === undefined) {
      return { status: 'error', text: 'verify 명령이 없습니다. todo.update로 먼저 선언합니다.' };
    }
    if (todo.status !== 'attempted' && todo.status !== 'claimed_verified') {
      return {
        status: 'error',
        text: `${todo.status} 상태에서는 검증하지 않습니다. todo.update로 attempted로 바꾼 뒤 실행합니다.`,
      };
    }
    const result = await runner.run({
      command: todo.verify.command,
      cwd: input.cwd,
      timeoutMs: settings.shellTimeoutMs,
      signal,
    });
    const scrubbedOutput = scrubText(formatCommandOutput(result));
    const output = scrubbedOutput.text;
    const outputRef = await store.writeArtifact(callId, output);
    const passed = result.exitCode === 0 && !result.timedOut;
    const evidence: Evidence = {
      command: todo.verify.command,
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      summary: summarizeOutput(output, SUMMARY_MAX_CHARS),
      origin: todo.verify.origin,
      ranAt: now(),
      scopeDigest: await workspace.hashFiles(todo.writeScope),
      outputRef,
      ...(result.timedOut ? { error: '시간 초과로 끝까지 실행하지 못했습니다.' } : {}),
    };
    await emit('engine', { type: 'verification', payload: { todoId: todo.id, evidence } });
    const updated: Todo = {
      ...todo,
      status: passed ? 'verified' : 'failed',
      evidence,
      updatedAt: now(),
    };
    todos.set(updated.id, updated);
    await emit('engine', {
      type: 'todo_update',
      payload: { todoId: updated.id, from: todo.status, to: updated.status, todo: updated },
    });
    await saveTodos();
    if (!passed && stage === 'verify') await enterStage('execute');
    return {
      status: 'ok',
      text: `${todo.id}: ${updated.status} (${result.timedOut ? 'timeout' : `exit ${result.exitCode ?? 'signal'}`})\n${evidence.summary}`,
      outputRef,
      scrubHits: scrubbedOutput.hits,
    };
  };

  const advanceStage = async (data: z.infer<typeof stageAdvanceSchema>): Promise<ToolOutput> => {
    const from = STAGES.indexOf(stage);
    const target = STAGES.indexOf(data.to);
    const list = [...todos.values()];
    if (target === from) return { status: 'error', text: `이미 ${stage} 단계입니다.` };
    if (target < from) {
      if (!isBackwardAllowed(data.to)) {
        return { status: 'error', text: `${data.to} 단계로는 돌아갈 수 없습니다.` };
      }
      await enterStage(data.to);
      return { status: 'ok', text: `${data.to} 단계로 돌아갔습니다.` };
    }
    const skipped = STAGES.slice(from + 1, target);
    if (skipped.length > 0 && data.skipReason === undefined) {
      return {
        status: 'error',
        text: `건너뛰는 단계가 있습니다: ${skipped.join(', ')}. skipReason에 사유를 적습니다.`,
      };
    }
    for (const passing of [stage, ...skipped]) {
      const blocked = checkStageExit(passing, list);
      if (blocked !== undefined) {
        return { status: 'error', text: `${passing} 단계를 끝낼 수 없습니다: ${blocked}` };
      }
    }
    for (const passed of skipped) {
      await emit('engine', {
        type: 'stage',
        payload: { outcome: 'skipped', stage: passed, reason: data.skipReason ?? '' },
      });
    }
    await enterStage(data.to);
    return { status: 'ok', text: `${data.to} 단계로 넘어갔습니다.` };
  };

  const proposeMemory = async (data: z.infer<typeof memoryProposeSchema>): Promise<ToolOutput> => {
    if (stage !== 'learn') {
      return { status: 'error', text: 'memory.propose는 learn 단계에서만 쓸 수 있습니다.' };
    }
    const decision = await memory.propose(
      { text: data.text, ...(data.source === undefined ? {} : { source: data.source }) },
      input.sessionId,
    );
    const detail = 'lessonId' in decision ? decision.lessonId : decision.reason;
    return { status: 'ok', text: `판정: ${decision.decision} (${detail})` };
  };

  const runControl = async (
    call: ToolCall,
    args: Record<string, unknown>,
  ): Promise<ControlOutput> => {
    const invalid = (error: z.ZodError): ControlOutput => ({
      status: 'error',
      text: z.prettifyError(error),
    });
    switch (call.tool) {
      case 'todo.update': {
        const parsed = todoUpdateSchema.safeParse(args);
        return parsed.success ? updateTodos(parsed.data) : invalid(parsed.error);
      }
      case 'verify.run': {
        const parsed = verifyRunSchema.safeParse(args);
        return parsed.success ? runVerify(parsed.data, call.callId) : invalid(parsed.error);
      }
      case 'stage.advance': {
        const parsed = stageAdvanceSchema.safeParse(args);
        return parsed.success ? advanceStage(parsed.data) : invalid(parsed.error);
      }
      case 'memory.propose': {
        const parsed = memoryProposeSchema.safeParse(args);
        return parsed.success ? proposeMemory(parsed.data) : invalid(parsed.error);
      }
      default: {
        const parsed = askUserSchema.safeParse(args);
        if (!parsed.success) return invalid(parsed.error);
        if (deps.questions === undefined) {
          return {
            status: 'error',
            text: 'headless 실행이라 사용자에게 물을 수 없습니다. 가정을 적고 진행합니다.',
          };
        }
        const request = { callId: call.callId, questions: parsed.data.questions };
        await emit('engine', { type: 'question', payload: request });
        await saveSession({ status: 'awaiting_user' });
        waiting = 'awaiting_user';
        let answers;
        try {
          answers = await deps.questions.ask(request, AbortSignal.any([signal, softStop]));
        } catch (error) {
          if (!(signal.aborted || softStop.aborted)) {
            waiting = undefined;
            await saveSession({ status: 'running' });
          }
          throw error;
        }
        await emit('user', { type: 'answer', payload: { callId: call.callId, answers } });
        waiting = undefined;
        await saveSession({ status: 'running' });
        const lines = parsed.data.questions.map((entry, index) => {
          const answer = answers[index];
          const parts = [
            ...(answer?.choices ?? []),
            ...(answer?.text === undefined ? [] : [answer.text]),
          ];
          const title = entry.header === undefined ? '' : `[${entry.header}] `;
          return `Q${index + 1}. ${title}${entry.question}\n답: ${parts.join(', ')}`;
        });
        return { status: 'ok', text: lines.join('\n') };
      }
    }
  };

  const executeCall = async (call: ToolCall): Promise<CallResult> => {
    const started = clock.now().getTime();
    const intent = typeof call.input.intent === 'string' ? call.input.intent.trim() : '';
    const args = Object.fromEntries(Object.entries(call.input).filter(([key]) => key !== 'intent'));
    const control = isControlTool(call.tool);
    const tool = toolMap.get(call.tool);
    let tier: ToolTier | undefined = tool?.tier;
    if (control) tier = call.tool === 'verify.run' ? 'exec' : undefined;

    if (intent !== '') await emit('model', { type: 'intent', payload: { text: intent } });
    await emit('model', {
      type: 'tool_call',
      payload: {
        callId: call.callId,
        tool: call.tool,
        args: call.input,
        ...(tier ? { tier } : {}),
      },
    });

    const conclude = async (output: ControlOutput): Promise<CallResult> => {
      const scrubbed = scrubText(output.text);
      const hits: ScrubHits = { ...output.scrubHits };
      mergeScrubHits(hits, scrubbed.hits);
      let outputRef = output.outputRef;
      if (outputRef === undefined && output.fullOutput !== undefined) {
        const full = scrubText(output.fullOutput);
        mergeScrubHits(hits, full.hits);
        outputRef = await store.writeArtifact(call.callId, full.text);
      }
      const note = Object.keys(hits).length > 0 ? ` [scrubbed: ${describeScrubHits(hits)}]` : '';
      await emit('tool', {
        type: 'tool_result',
        payload: {
          callId: call.callId,
          status: output.status,
          summary: scrubbed.text.slice(0, EVENT_SUMMARY_MAX_CHARS) + note,
          durationMs: Math.max(0, clock.now().getTime() - started),
          ...(outputRef === undefined ? {} : { outputRef }),
        },
      });
      const refNote = outputRef === undefined ? '' : `\n[전체 출력: ${outputRef}]`;
      return {
        text: scrubbed.text + refNote,
        isError: output.status !== 'ok',
        summary: scrubbed.text.slice(0, EVENT_SUMMARY_MAX_CHARS) + note,
      };
    };

    if (!control && tool === undefined) {
      return conclude({ status: 'error', text: `알 수 없는 도구: ${call.tool}` });
    }
    if (intent === '') {
      return conclude({
        status: 'error',
        text: 'intent가 비어 있어 실행하지 않았습니다. 이 호출이 필요한 이유를 한 문장으로 intent에 적어 다시 호출합니다.',
      });
    }
    let editedCommand: string | undefined;
    if (tier !== undefined) {
      const auth = await authorize(call, tier, intent);
      if ('denied' in auth) return conclude({ status: 'error', text: auth.denied });
      editedCommand = auth.editedCommand;
    }
    try {
      const output =
        control || tool === undefined
          ? await runControl(call, args)
          : await tool.run(
              editedCommand === undefined ? args : { ...args, command: editedCommand },
              { cwd: input.cwd, signal },
            );
      return await conclude(signal.aborted ? { ...output, status: 'aborted' } : output);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return conclude({ status: signal.aborted ? 'aborted' : 'error', text: message });
    }
  };

  // 신호는 await 사이에 바뀐다. 속성을 직접 읽으면 TypeScript가 앞선 검사로 좁힌 값을 그대로 믿는다.
  const isSoftStopped = () => softStop.aborted;
  const skipCall = async (call: ToolCall): Promise<CallResult> => {
    const text = '소프트 스톱으로 실행하지 않았습니다.';
    await emit('model', {
      type: 'tool_call',
      payload: { callId: call.callId, tool: call.tool, args: call.input },
    });
    await emit('tool', {
      type: 'tool_result',
      payload: { callId: call.callId, status: 'aborted', summary: text, durationMs: 0 },
    });
    return { text, isError: true, summary: text };
  };

  const invalidateStaleEvidence = async () => {
    for (const todo of [...todos.values()]) {
      if (todo.status !== 'verified' || todo.evidence === undefined) continue;
      if ((await workspace.hashFiles(todo.writeScope)) === todo.evidence.scopeDigest) continue;
      const updated: Todo = { ...todo, status: 'attempted', updatedAt: now() };
      todos.set(updated.id, updated);
      await emit('engine', {
        type: 'todo_update',
        payload: { todoId: updated.id, from: 'verified', to: 'attempted', todo: updated },
      });
    }
    await saveTodos();
  };

  const history: ModelMessage[] = resume
    ? [...resume.plan.history]
    : [{ role: 'user', content: [{ type: 'text', text: scrubText(input.task).text }] }];
  // `history` 메시지마다 마지막으로 합쳐진 이벤트의 seq다. 압축 범위를 seq로 적는 데 쓴다.
  const historySeqs: number[] = resume ? [...resume.plan.historySeqs] : [taskSeq];
  const instructions: string[] = resume
    ? [...resume.plan.instructions]
    : [scrubText(input.task).text];
  const lastResults = new Map<string, { isError: boolean; text: string }>(
    resume?.plan.openErrors.map((error) => [error.tool, { isError: true, text: error.summary }]),
  );
  let hasSummary = resume?.plan.hasSummary ?? false;
  // 마지막 모델 응답의 입력과 출력 토큰 합계와, 그때 `history` 길이다. 압축 직후에는 비운다.
  let knownTokens: number | undefined;
  let knownLength = 0;
  // 승인 거부 때 사용자가 덧붙인 조향이다. 같은 배치의 도구 결과 메시지에 지시 원문으로 함께 적는다.
  const pendingSteers: string[] = [];
  let responsesSincePass = Number.POSITIVE_INFINITY;
  const estimateInput = () =>
    knownTokens === undefined
      ? estimateTokens(system) + estimateTokens(specs) + estimateTokens(history)
      : knownTokens + estimateTokens(history.slice(knownLength));
  /** 사용자 지시 원문이 있으면 메시지 `instructions`에 적고, 압축 요약에 넣을 지시 목록에도 더한다. */
  const pushUser = async (
    actor: 'user' | 'tool' | 'engine',
    content: ContentBlock[],
    userInstructions: string[] = [],
  ) => {
    const safeContent = scrubValue(content);
    const before = history.length;
    appendMessage(history, { role: 'user', content: safeContent });
    await emit(actor, {
      type: 'message',
      payload: {
        role: 'user',
        content: safeContent,
        ...(userInstructions.length === 0 ? {} : { instructions: userInstructions }),
      },
    });
    instructions.push(...userInstructions);
    if (history.length > before) historySeqs.push(recorder.lastSeq());
    else historySeqs[historySeqs.length - 1] = recorder.lastSeq();
  };
  /** 요약과 인계 문서 요청이다. 응답의 텍스트만 돌려주고 도구 호출은 무시한다. 사용량은 `purpose: 'compaction'`으로 남긴다. */
  const requestCompaction = async (
    request: ModelRequest,
    modelSignal: AbortSignal,
  ): Promise<string> => {
    const started = clock.now().getTime();
    let completed: Extract<ModelStreamEvent, { type: 'completed' }> | undefined;
    for await (const event of model.stream(request, modelSignal)) {
      if (event.type === 'completed') completed = event;
    }
    if (completed === undefined) throw new Error('압축 요청 스트림이 completed 없이 끝났습니다.');
    await emit('model', {
      type: 'model_request',
      payload: {
        model: model.model,
        adapter: model.adapter,
        chainPosition: 0,
        nativeToolCalls: completed.nativeToolCalls,
        usage: completed.usage,
        durationMs: Math.max(0, clock.now().getTime() - started),
        purpose: 'compaction',
      },
    });
    return completed.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')
      .trim();
  };
  const firstEligible = () => (hasSummary ? 1 : 0);
  /** 도구 출력 가지치기나 shake가 바꾼 메시지 범위를 `compaction` 이벤트로 남긴다. */
  const recordRewrite = async (
    method: 'prune' | 'shake',
    touched: readonly number[],
    callIds: readonly string[],
    toSeq?: number,
  ) => {
    const seqs = touched.map((index) => historySeqs[index] ?? 1);
    await emit('engine', {
      type: 'compaction',
      payload: {
        method,
        fromSeq: Math.min(...seqs),
        toSeq: toSeq ?? Math.max(...seqs),
        prunedCallIds: [...callIds],
      },
    });
    knownTokens = undefined;
  };
  /** 앞 `cut`개 메시지를 요약 문서 하나로 바꾼다. 필수 절은 엔진이 기록에서 만든다. */
  const commit = async (
    method: 'handoff' | 'summary',
    cut: number,
    parts: { narrative: string; turnPrefix?: string },
  ) => {
    const document = scrubText(
      buildSummaryDocument({
        instructions,
        todos: [...todos.values()],
        openErrors: [...lastResults]
          .filter(([, result]) => result.isError)
          .map(([tool, result]) => ({ tool, summary: result.text })),
        ...parts,
      }),
    ).text;
    const fromSeq = historySeqs[0] ?? 1;
    const toSeq = historySeqs[cut - 1] ?? fromSeq;
    const path = await store.writeCompaction(document);
    await emit('engine', {
      type: 'compaction',
      payload: { method, fromSeq, toSeq, path, prunedCallIds: [] },
    });
    history.splice(0, cut, summaryMessage(document));
    historySeqs.splice(0, cut, fromSeq);
    hasSummary = true;
    knownTokens = undefined;
  };
  /** 압축 결과가 기준선의 80% 아래에 오도록 줄인 원문 유지 범위의 시작 위치다. 어시스턴트 메시지 앞에서만 자른다. */
  const keepCut = (window: number): number | undefined => {
    const fixed = estimateTokens(system) + estimateTokens(specs) + SUMMARY_RESERVE_TOKENS;
    const room = window * settings.compactAtRatio * PROGRESS_RATIO - fixed;
    const cut = findKeepCut(history, Math.max(0, Math.min(settings.keepRecentTokens, room)));
    return cut !== undefined && cut > firstEligible() ? cut : undefined;
  };
  const runShake = async (): Promise<boolean> => {
    const upToSeq = shakeBoundarySeq(history, historySeqs, settings.keepRecentTokens);
    if (upToSeq === undefined) return false;
    const { touched, callIds } = shakeMessages(history, historySeqs, upToSeq, firstEligible());
    if (touched.length === 0) return false;
    await recordRewrite('shake', touched, callIds, upToSeq);
    return true;
  };
  const runHandoff = async (window: number, modelSignal: AbortSignal): Promise<boolean> => {
    const cut = keepCut(window);
    if (cut === undefined) return false;
    const messages = [...history];
    appendMessage(messages, { role: 'user', content: [{ type: 'text', text: HANDOFF_PROMPT }] });
    const narrative = await requestCompaction({ system, messages, tools: specs }, modelSignal);
    if (narrative === '') return false;
    await commit('handoff', cut, { narrative });
    return true;
  };
  const runSummary = async (window: number, modelSignal: AbortSignal): Promise<boolean> => {
    const cut = keepCut(window);
    if (cut === undefined) return false;
    const start = firstEligible();
    const first = history[0]?.content.flatMap((block) =>
      block.type === 'text' ? [block.text] : [],
    );
    const previous = hasSummary ? narrativeOf((first ?? []).join('\n')) : undefined;
    const turnStart = findTurnStart(history, cut, start);
    // 턴 중간에서 잘랐고 그 앞에 요약할 메시지가 있으면, 턴 앞부분은 따로 요약해 붙인다.
    const splitAt = turnStart !== undefined && turnStart > start ? turnStart : undefined;
    const ask = (askSystem: string, messages: readonly ModelMessage[], prior?: string) =>
      requestCompaction(
        {
          system: askSystem,
          messages: [
            { role: 'user', content: [{ type: 'text', text: buildSummaryInput(messages, prior) }] },
          ],
          tools: [],
        },
        modelSignal,
      );
    const narrative = await ask(SUMMARY_SYSTEM, history.slice(start, splitAt ?? cut), previous);
    const turnPrefix =
      splitAt === undefined
        ? undefined
        : await ask(TURN_PREFIX_SYSTEM, history.slice(splitAt, cut));
    await commit('summary', cut, {
      narrative: narrative === '' ? '(요약 모델이 내용을 쓰지 않았습니다.)' : narrative,
      ...(turnPrefix === undefined ? {} : { turnPrefix }),
    });
    return true;
  };
  const isTool = (name: string) => !isControlTool(name) && toolMap.get(name)?.tier === 'read';

  let step = 0;
  try {
    if (resume !== undefined) {
      const { plan } = resume;
      if (plan.trim !== undefined) {
        await emit('engine', { type: 'context_trim', payload: plan.trim });
      }
      await emit('engine', {
        type: 'resume',
        payload: {
          fromStatus: plan.fromStatus,
          hardKilled: plan.hardKilled,
          steered: resume.steer !== undefined,
          ...(plan.resumePointTodoId === undefined
            ? {}
            : { resumePointTodoId: plan.resumePointTodoId }),
          ...(plan.summaryFallback === undefined ? {} : { summaryFallback: plan.summaryFallback }),
        },
      });
      await saveSession({
        status: 'running',
        endReason: undefined,
        isolation: settings.isolation,
      });
      // 하드 킬 뒤에는 검증 증거가 남은 todo 뒤의 작업을 믿지 않고, 진행 중이던 todo를 다시 시도 대상으로 돌린다.
      if (plan.hardKilled) await interruptActiveTodos();
      await saveTodos();
      const notice = plan.hardKilled
        ? `이전 실행이 강제로 끝났습니다. ${
            plan.resumePointTodoId === undefined
              ? '검증 증거가 남은 todo가 없습니다.'
              : `마지막으로 검증된 todo는 ${plan.resumePointTodoId}입니다.`
          } 그 뒤의 작업은 파일 상태를 확인한 뒤 이어 갑니다.`
        : '사용자가 작업을 중단했습니다. 중단한 지점부터 이어 갑니다.';
      await pushUser(
        resume.steer === undefined ? 'engine' : 'user',
        [
          ...plan.repair,
          {
            type: 'text',
            text: `${notice}${resume.steer === undefined ? '' : `\n사용자 지시: ${resume.steer}`}\n${describeTodos([...todos.values()])}\n현재 단계: ${stage}`,
          },
        ],
        resume.steer === undefined ? [] : [scrubText(resume.steer).text],
      );
    }
    // 진전은 todo 상태 전진, 수리 시도 증가, 새 todo 추가, 새 검증 증거, 오류 없이 끝난 도구 호출 중 하나다.
    const snapshotProgress = () =>
      new Map(
        [...todos.values()].map((todo) => [
          todo.id,
          { rank: STATUS_RANK[todo.status], attempts: todo.attempts, ranAt: todo.evidence?.ranAt },
        ]),
      );
    let progressMark = snapshotProgress();
    let stagnantSteps = 0;
    let toolSucceeded = false;
    for (;;) {
      if (signal.aborted || softStop.aborted) return await finishCancelled();
      if (step > 0) {
        const current = snapshotProgress();
        const advanced = [...current].some(([id, after]) => {
          const before = progressMark.get(id);
          return (
            before === undefined ||
            after.rank > before.rank ||
            after.attempts > before.attempts ||
            after.ranAt !== before.ranAt
          );
        });
        progressMark = current;
        stagnantSteps = advanced || toolSucceeded ? 0 : stagnantSteps + 1;
        if (stagnantSteps >= settings.noProgressSteps) {
          const stuck = [...todos.values()].filter((todo) => todo.status !== 'verified');
          const stuckText =
            stuck.length === 0
              ? '막힌 todo가 없습니다.'
              : `막힌 todo: ${stuck
                  .map(
                    (todo) =>
                      `${todo.id}(${todo.status}, 시도 ${todo.attempts}회${
                        todo.evidence === undefined
                          ? ''
                          : `, 마지막 증거 exit ${todo.evidence.exitCode}: ${todo.evidence.summary}`
                      })`,
                  )
                  .join('; ')}`;
          return await finish(
            'stopped',
            'no_progress',
            `연속 ${settings.noProgressSteps}스텝 동안 진전이 없습니다. ${stuckText}`,
          );
        }
      }
      if (step >= settings.maxSteps) {
        return await finish(
          'stopped',
          'max_steps',
          `최대 스텝(${settings.maxSteps})에 도달했습니다.`,
        );
      }
      step += 1;
      stepId = `step-${step}`;
      toolSucceeded = false;

      const window = settings.contextWindow;
      if (window !== undefined) {
        const threshold = window * settings.compactAtRatio;
        let estimate = estimateInput();
        let compacted = false;
        if (estimate >= threshold) {
          const pruneIds = planPrune(history, settings.protectToolTokens, settings.minPruneSavings);
          const pruned = pruneIds.length === 0 ? [] : applyPrune(history, new Set(pruneIds));
          if (pruned.length > 0) {
            await recordRewrite('prune', pruned, pruneIds);
            compacted = true;
            estimate = estimateInput();
          }
        }
        // 가지치기만으로 기준선 아래로 내려가면 압축하지 않는다. 앞선 압축이 여유를 만들지 못했다면 창 안에서는 몇 응답 동안 다시 시도하지 않는다.
        if (
          estimate >= threshold &&
          (estimate > window || responsesSincePass >= PASS_RETRY_RESPONSES)
        ) {
          const methods = { shake: runShake, handoff: runHandoff, summary: runSummary };
          let reached = false;
          for (const method of settings.methodOrder) {
            if (!(await methods[method](window, AbortSignal.any([signal, softStop])))) continue;
            compacted = true;
            estimate = estimateInput();
            if (estimate <= threshold * PROGRESS_RATIO) {
              reached = true;
              break;
            }
          }
          responsesSincePass = reached ? Number.POSITIVE_INFINITY : 0;
        }
        if (estimate > window) {
          return await finish(
            'stopped',
            'context_overflow',
            `입력이 약 ${estimate}토큰으로 컨텍스트 창 ${window}토큰을 넘습니다. ${
              compacted ? '압축한 뒤에도' : '압축할 범위가 없어'
            } 넘쳐서 멈춥니다. 앞부분을 자르지 않았습니다.`,
          );
        }
      }
      const started = clock.now().getTime();
      let completed: Extract<ModelStreamEvent, { type: 'completed' }> | undefined;
      const modelSignal = AbortSignal.any([signal, softStop]);
      for await (const event of model.stream(
        { system, messages: history, tools: specs },
        modelSignal,
      )) {
        if (event.type === 'completed') completed = event;
      }
      if (completed === undefined) throw new Error('모델 스트림이 completed 없이 끝났습니다.');
      const content = [...completed.content];
      await emit('model', {
        type: 'model_request',
        payload: {
          model: model.model,
          adapter: model.adapter,
          chainPosition: 0,
          nativeToolCalls: completed.nativeToolCalls,
          usage: completed.usage,
          durationMs: Math.max(0, clock.now().getTime() - started),
        },
      });
      history.push({ role: 'assistant', content: scrubValue(content) });
      await emit('model', {
        type: 'message',
        payload: {
          role: 'assistant',
          content,
          ...(completed.providerMetadata === undefined
            ? {}
            : { providerMetadata: completed.providerMetadata }),
        },
      });
      historySeqs.push(recorder.lastSeq());
      knownTokens =
        completed.usage.uncachedInputTokens +
        completed.usage.cacheReadInputTokens +
        completed.usage.cacheCreationInputTokens +
        completed.usage.outputTokens;
      knownLength = history.length;
      responsesSincePass += 1;
      const accountPin = model.accountPin?.();
      if (
        accountPin !== undefined &&
        JSON.stringify(accountPin) !== JSON.stringify(session.accountPin)
      ) {
        await saveSession({ accountPin });
      }

      const calls: ToolCall[] = content.flatMap((block) =>
        block.type === 'tool_use'
          ? [{ callId: block.callId, tool: block.tool, input: block.input }]
          : [],
      );

      if (calls.length === 0) {
        const text = content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('\n')
          .trim();
        const firstSentence = text.split(/(?<=[.!?。])\s/)[0] ?? '';
        if (firstSentence !== '')
          await emit('model', { type: 'intent', payload: { text: firstSentence } });
        const list = [...todos.values()];
        if (
          getStage() === 'learn' &&
          list.length > 0 &&
          list.every((todo) => todo.status === 'verified')
        ) {
          return await finish('completed', 'passed', text);
        }
        const nudge =
          list.length === 0 || list.some((todo) => todo.status !== 'verified')
            ? '아직 모든 todo가 verified가 아닙니다. 작업을 계속합니다.'
            : 'learn 단계까지 stage.advance로 진행한 뒤 마무리합니다.';
        await pushUser('engine', [
          { type: 'text', text: `${nudge}\n${describeTodos(list)}\n현재 단계: ${stage}` },
        ]);
        continue;
      }

      const results = new Map<string, CallResult>();
      let readGroup: ToolCall[] = [];
      const flushReads = async () => {
        const group = readGroup;
        readGroup = [];
        const done = await Promise.all(
          group.map(
            async (call) =>
              [
                call.callId,
                isSoftStopped() ? await skipCall(call) : await executeCall(call),
              ] as const,
          ),
        );
        for (const [callId, result] of done) results.set(callId, result);
      };
      for (const call of calls) {
        if (isTool(call.tool)) {
          readGroup.push(call);
          continue;
        }
        await flushReads();
        results.set(call.callId, isSoftStopped() ? await skipCall(call) : await executeCall(call));
      }
      await flushReads();
      await invalidateStaleEvidence();
      toolSucceeded = [...results.values()].some((result) => !result.isError);
      for (const call of calls) {
        const result = results.get(call.callId);
        lastResults.set(call.tool, {
          isError: result?.isError ?? true,
          text: result?.summary ?? '',
        });
      }

      const observations: ContentBlock[] = calls.map((call) => {
        const result = results.get(call.callId);
        return {
          type: 'tool_result',
          callId: call.callId,
          text: result?.text ?? '',
          isError: result?.isError ?? true,
        };
      });
      observations.push({
        type: 'text',
        text: `${describeTodos([...todos.values()])}\n현재 단계: ${stage}`,
      });
      await pushUser('tool', observations, pendingSteers.splice(0));
    }
  } catch (error) {
    if (signal.aborted || softStop.aborted) return await finishCancelled();
    return await finish('failed', 'error', error instanceof Error ? error.message : String(error));
  }
}
