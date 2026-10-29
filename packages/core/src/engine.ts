import type {
  ApprovalRequest,
  ApprovalRule,
  ApprovalScope,
  ContentBlock,
  EndReason,
  Evidence,
  Isolation,
  PermissionMode,
  ReviewFinding,
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
  verifyWaiveSchema,
} from './control-tools.ts';
import { assessRisk, decidePermission } from './permission.ts';
import { findHarnessCliCall } from './harness-cli.ts';
import { addedLines, findStubs, judgeGate } from './gate.ts';
import type { GateResult } from './gate.ts';
import type { ToolPolicy } from './permission.ts';
import type { AlwaysApprovalPort, ApprovalPort, QuestionPort } from './ports/approval.ts';
import type { McpNoticePort } from './ports/mcp-notices.ts';
import type { CommandRunner } from './ports/command-runner.ts';
import type { ConflictJudge, MemoryPort } from './ports/memory.ts';
import type { SkillEntry, SkillPort } from './ports/skills.ts';
import { scoreBm25 } from './relevance.ts';
import { CostStopError, ModelLimitError } from './ports/model.ts';
import type {
  ModelChainEntry,
  ModelMessage,
  ModelPort,
  ModelPricing,
  ModelRequest,
  ModelRouter,
  ModelStreamEvent,
  ModelUsage,
} from './ports/model.ts';
import type { SessionStore } from './ports/session-store.ts';
import type { Clock } from './ports/system.ts';
import type { Tool, ToolOutput } from './ports/tool.ts';
import type { TranscriptSink } from './ports/transcript-sink.ts';
import { NODE_TEST, classifyOrigin, commandCandidates } from './origin.ts';
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
  withCap,
} from './compaction.ts';
import { CONFLICT_JUDGE_PROMPT, conflictJudgementSchema } from './conflict.ts';
import {
  REVIEW_PROMPT,
  buildReviewQuestion,
  formatFindings,
  parseReviewReply,
  REVIEWER_UNAVAILABLE_REASON,
  ReviewerUnavailableError,
} from './review.ts';
import { appendMessage } from './recovery.ts';
import type { ResumePlan } from './recovery.ts';
import { describeScrubHits, mergeScrubHits, scrubText, scrubValue } from './scrub.ts';
import type { ScrubHits } from './scrub.ts';
import { STAGES, checkStageExit, isBackwardAllowed } from './stages.ts';
import { formatKst } from './time.ts';
import {
  applyModelTodoEntry,
  applyUserTodoAction,
  ensurePhase,
  isDone,
  normalizePhaseName,
  phaseOf,
  reconcileCurrent as reconcileTodoCurrent,
} from './todos.ts';
import type { UserTodoAction } from './todos.ts';

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
  readonly methodOrder: readonly ('remote' | 'shake' | 'handoff' | 'summary')[];
  /** 사용자 입력을 기다리기 시작한 뒤 이 시간(ms)이 지나도 기다리는 중이면 다음 압축에 쓸 요약을 미리 만든다. 비우거나 0이면 만들지 않는다. */
  readonly idleSummaryMs?: number;
  /** 비용 상한이다 (SPEC 5.4절). 비우면 상한이 없다. 단위는 `pricing`과 같다. */
  readonly maxCost?: number;
  readonly warnCost?: number;
  /** `<프로바이더>/<모델>`마다 100만 토큰당 단가다. 가드레일 판정에만 쓴다. */
  readonly pricing?: Readonly<Record<string, ModelPricing>>;
  /** 검증이 통과한 todo를 `review` 역할의 다른 모델에 검토시킨다. 기본은 끈다. */
  readonly reviewEnabled?: boolean;
}

export interface EngineDeps {
  readonly models: ModelRouter;
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
  /** MCP 서버 연결·장애 알림이다. 엔진이 스텝마다 꺼내 세션 기록에 남긴다. */
  readonly mcpNotices?: McpNoticePort;
  /** 없으면 스킬을 쓰지 않는다. */
  readonly skills?: SkillPort;
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
  /** 사용자가 보낸 포기·포기 취소다. 엔진이 스텝이 끝날 때마다 꺼내 반영한다. */
  readonly userTodoActions?: { drain(): readonly UserTodoAction[] };
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
/** 어림값이 기준선의 이 비율에 닿으면 다음 압축에 쓸 요약을 미리 만든다. */
const AHEAD_RATIO = 0.9;
/** 쉴 때 요약은 어림값이 기준선의 이 비율 이상일 때만 만든다. 비율은 SPEC에 없어 보수적으로 정한 값이다. */
const IDLE_RATIO = 0.5;
/** 압축 요청의 출력 상한 기본값이다 (SPEC 4.3절 출력 상한). */
const COMPACTION_OUTPUT_CAP = 8000;
/** 남은 자리가 이보다 작으면 그 방식을 건너뛴다. 제목 몇 개와 목록 몇 줄(한글 300~500토큰)은 있어야 쓸 만한 문서라는 판단이고 실측하지 않았다. */
const MIN_OUTPUT_ROOM = 500;
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
  blocked: 3,
  abandoned: 3,
};

export async function runSession(deps: EngineDeps, input: RunInput): Promise<RunOutcome> {
  const { models: router, runner, store, workspace, memory, clock } = deps;
  const { settings, signal, softStop, resume } = input;
  const recorder = createRecorder(input.sessionId, deps.sink, clock, resume?.plan.lastSeq);
  const toolMap = new Map(deps.tools.map((tool) => [tool.name, tool]));
  const todos = new Map<string, Todo>(resume?.plan.todos.map((todo) => [todo.id, todo] as const));
  const now = () => formatKst(clock.now());
  const emit: (typeof recorder)['emit'] = (actor, draft) => recorder.emit(actor, draft, stepId);

  const phaseOrder: string[] = (resume?.plan.phases ?? []).map((phase) => phase.name);
  const phaseCriteria = new Map<string, string>(
    (resume?.plan.phases ?? []).flatMap((phase) =>
      phase.criterion === undefined ? [] : [[phase.name, phase.criterion] as const],
    ),
  );
  let objective = resume?.plan.objective ?? '';
  let current: string | undefined = resume?.plan.current;
  const summaryPhases = () =>
    phaseOrder.map((name) => {
      const criterion = phaseCriteria.get(name);
      return criterion === undefined ? { name } : { name, criterion };
    });
  const describeState = (list: readonly Todo[]) =>
    describeTodos(list, { objective, ...(current === undefined ? {} : { current }) });
  /** 작업 중 todo가 후보(`blocked`가 아닌 남은 todo)가 아니면 다음 후보로 옮긴다. 바뀌었으면 `todo_update`에 붙일 필드를 돌려준다. */
  const reconcileCurrent = () => {
    const fragment = reconcileTodoCurrent([...todos.values()], phaseOrder, current);
    if (fragment !== undefined) current = fragment.current ?? undefined;
    return fragment;
  };
  const applyUserActions = async () => {
    const actions = input.userTodoActions?.drain() ?? [];
    for (const action of actions) {
      const outcome = applyUserTodoAction(todos, action, now());
      if (outcome === undefined) continue;
      const fragment = outcome.rejected === undefined ? (reconcileCurrent() ?? {}) : {};
      await emit('user', {
        type: 'todo_update',
        payload: {
          todoId: action.todoId,
          ...(outcome.from === undefined ? {} : { from: outcome.from }),
          to: outcome.to,
          todo: outcome.todo,
          ...fragment,
          ...(outcome.rejected === undefined ? {} : { rejected: { reason: outcome.rejected } }),
        },
      });
    }
    if (actions.length > 0) await saveTodos();
  };

  let stepId = 'step-0';
  let stage: Stage = resume?.plan.stage ?? 'understand';
  const getStage = (): Stage => stage;

  const promptFiles = await workspace.readPromptFiles();
  const instructionFiles = await workspace.readInstructionFiles();
  const harnessFiles =
    settings.isolation === 'clean-home' ? await workspace.findHarnessFiles() : [];
  const startFiles = resume === undefined ? await workspace.snapshotFiles() : undefined;
  const recall = await memory.recall({
    query: input.task,
    tokenBudget: settings.recallTokenBudget,
    sessionId: input.sessionId,
  });
  const skills = (await deps.skills?.list()) ?? [];
  const injectedSkills: SkillEntry[] = [];
  const candidateSkills: SkillEntry[] = [];
  let skillTokens = 0;
  const skillScores = scoreBm25(
    input.task,
    skills.map(
      (skill) => `${skill.name} ${skill.description} ${skill.triggers.join(' ')} ${skill.body}`,
    ),
  );
  const ranked = skills
    .map((skill, index) => ({ skill, score: skillScores[index] ?? 0 }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  for (const { skill } of ranked) {
    const tokens = Math.ceil(skill.body.length / 4);
    if (recall.tokenCount + skillTokens + tokens > settings.recallTokenBudget) {
      candidateSkills.push(skill);
      continue;
    }
    injectedSkills.push(skill);
    skillTokens += tokens;
  }
  const specs = buildToolSpecs(deps.tools);
  const system = scrubText(
    assembleSystemPrompt({
      promptFiles,
      tools: specs,
      permissionMode: settings.permissionMode,
      isolation: settings.isolation,
      instructionFiles,
      recall,
      skills,
      skillBodies: injectedSkills,
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
    models: [],
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
  const roleState = new Map<string, { position: number; resetAtMs?: number }>();
  const stateOf = (role: string) => {
    let state = roleState.get(role);
    if (state === undefined) {
      const last = resume?.session.models.findLast((used) => used.role === role);
      const position = last?.chainPosition ?? 0;
      state = { position: position < router.chain(role).length ? position : 0 };
      roleState.set(role, state);
    }
    return state;
  };
  const entryAt = (role: string, position: number): ModelChainEntry => {
    const entry = router.chain(role)[position];
    if (entry === undefined)
      throw new Error(`${role} 역할의 체인에 ${position}번 항목이 없습니다.`);
    return entry;
  };
  const currentPort = (role: string): Promise<ModelPort> =>
    router.open(entryAt(role, stateOf(role).position));
  /** 세션 기록의 `models`에 이 역할이 지금 쓰는 모델을 남긴다. 같은 역할·위치는 한 항목이고 가장 나중에 쓴 항목이 맨 뒤에 온다. */
  const noteUse = async (role: string) => {
    const { position } = stateOf(role);
    const entry = entryAt(role, position);
    const last = session.models.findLast((used) => used.role === role);
    if (last?.chainPosition === position && last.model === entry.model) return;
    const used = {
      model: entry.model,
      provider: entry.provider,
      role,
      chainPosition: position,
      ...(entry.effort === undefined ? {} : { effort: entry.effort }),
      source: position === 0 ? entry.source : ('fallback' as const),
    };
    await saveSession({
      models: [
        ...session.models.filter((old) => !(old.role === role && old.chainPosition === position)),
        used,
      ],
    });
  };

  const priceOf = (model: string): ModelPricing | undefined => {
    const pricing = settings.pricing ?? {};
    const key = Object.keys(pricing).find((name) => name === model || name.endsWith(`/${model}`));
    return key === undefined ? undefined : pricing[key];
  };
  const costOf = (model: string, usage: ModelUsage): number => {
    const price = priceOf(model);
    if (price === undefined) return 0;
    return (
      (usage.uncachedInputTokens * price.inputPerMTok +
        usage.cacheReadInputTokens * (price.cacheReadPerMTok ?? price.inputPerMTok) +
        usage.cacheCreationInputTokens * (price.cacheWritePerMTok ?? price.inputPerMTok) +
        usage.outputTokens * price.outputPerMTok) /
      1_000_000
    );
  };
  let spent = (resume?.plan.modelUsage ?? []).reduce(
    (total, item) => total + costOf(item.model, item.usage),
    0,
  );
  let costWarned = resume?.plan.costWarned ?? false;
  const ratioPct = () => {
    const base = settings.maxCost ?? settings.warnCost;
    return base === undefined || base <= 0 ? undefined : Math.floor((spent / base) * 100);
  };
  /** 모델 요청 전에 호출한다. 상한 이상이거나 `maxCost`가 있는데 단가가 없으면 요청을 막고, 경고 비용에 처음 닿으면 한 번 기록한다. */
  const guardCost = async (model: string) => {
    if (settings.maxCost !== undefined) {
      if (priceOf(model) === undefined) {
        await emit('engine', {
          type: 'cost_guard',
          payload: { outcome: 'pricing_missing', model },
        });
        throw new CostStopError(
          `비용 상한을 설정했지만 ${model}의 단가가 없어 요청을 보내지 않았습니다. 설정 pricing에 단가를 입력합니다.`,
          'pricing_missing',
        );
      }
      if (spent >= settings.maxCost) {
        const pct = ratioPct() ?? 100;
        await emit('engine', { type: 'cost_guard', payload: { outcome: 'limit', ratioPct: pct } });
        throw new CostStopError(
          `비용 상한의 ${pct}%에 닿아 다음 요청을 보내지 않고 멈춥니다.`,
          'limit',
        );
      }
    }
    if (settings.warnCost !== undefined && !costWarned && spent >= settings.warnCost) {
      costWarned = true;
      await emit('engine', {
        type: 'cost_guard',
        payload: { outcome: 'warn', ratioPct: ratioPct() ?? 0 },
      });
    }
  };
  const addSpend = (model: string, usage: ModelUsage) => {
    spent += costOf(model, usage);
    const pct = settings.maxCost === undefined ? undefined : ratioPct();
    return pct === undefined ? {} : { costRatioPct: pct };
  };

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
    await noteUse('default');
    await emit('user', {
      type: 'message',
      payload: {
        role: 'user',
        content: [{ type: 'text', text: input.task }],
        instructions: [input.task],
      },
    });
    await emit('engine', {
      type: 'recall',
      payload: {
        lessonIds: recall.lessons.map((lesson) => lesson.id),
        skills: injectedSkills.map(({ name, scope }) => ({ name, scope })),
        candidateSkills: candidateSkills.map(({ name, scope }) => ({ name, scope })),
        tokenCount: recall.tokenCount + skillTokens,
      },
    });
    taskSeq = recorder.lastSeq();
    await emit('engine', { type: 'stage', payload: { outcome: 'entered', stage } });
  }

  const flushMcpNotices = async () => {
    for (const notice of deps.mcpNotices?.drain() ?? []) {
      await emit('engine', { type: 'mcp_server', payload: notice });
    }
  };
  await flushMcpNotices();

  const enterStage = async (to: Stage) => {
    stage = to;
    await emit('engine', { type: 'stage', payload: { outcome: 'entered', stage: to } });
  };

  const finish = async (
    status: SessionStatus,
    endReason: EndReason,
    summary: string,
  ): Promise<RunOutcome> => {
    await applyUserActions();
    await flushMcpNotices();
    const eventHits = recorder.scrubbedHits();
    const hitNote =
      Object.keys(eventHits).length > 0 ? ` [scrubbed: ${describeScrubHits(eventHits)}]` : '';
    const canJudge = endReason !== 'cost_limit' && endReason !== 'user_cancel';
    const maintenanceNote = await memory.maintain(canJudge ? judgeConflict : undefined).then(
      () => '',
      (error: unknown) =>
        ` [기억 유지보수 실패: ${error instanceof Error ? error.message : String(error)}]`,
    );
    const safeSummary = scrubText(summary).text + hitNote + maintenanceNote;
    await emit('engine', {
      type: 'session_end',
      payload: { status, endReason, summary: safeSummary },
    });
    await saveTodos();
    await saveSession({ status, endReason });
    return { status, endReason, summary: safeSummary, todos: [...todos.values()] };
  };

  /** 스텝이 끝나면 사용자의 포기를 반영하고, 남은 todo가 전부 `blocked`이거나 전부 `abandoned`이면 세션을 멈춘다 (SPEC 6.1절). */
  const judgeTodos = async (): Promise<RunOutcome | undefined> => {
    await applyUserActions();
    const list = [...todos.values()];
    if (list.length === 0) return undefined;
    if (list.every((todo) => todo.status === 'abandoned')) {
      return await finish(
        'stopped',
        'abandoned',
        `모든 todo를 포기했습니다: ${list.map((todo) => todo.id).join(', ')}`,
      );
    }
    const open = list.filter((todo) => !isDone(todo.status));
    if (open.length > 0 && open.every((todo) => todo.status === 'blocked')) {
      return await finish(
        'stopped',
        'blocked',
        `남은 todo가 모두 막혀 멈춥니다. ${open
          .map((todo) => `${todo.id}: ${todo.blockedReason ?? '사유 없음'}`)
          .join('; ')}`,
      );
    }
    return undefined;
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
    const decision = await deps.approval
      .request(request, AbortSignal.any([signal, softStop]))
      .finally(startIdleSummary());
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
    let rejectedCount = 0;
    const rejectLine = (line: string) => {
      rejectedCount += 1;
      lines.push(line);
    };
    if (data.objective !== undefined) {
      const text = data.objective.trim();
      if (text.includes('\n')) {
        rejectLine('objective: 거부됨: 줄바꿈 없이 한 줄로 적습니다.');
      } else {
        objective = text;
        await emit('model', { type: 'objective', payload: { text } });
        lines.push(`objective: ${text === '' ? '지움' : '기록'}`);
      }
    }
    for (const phase of data.phases ?? []) {
      const name = normalizePhaseName(phase.name);
      const criterion = phase.criterion?.trim();
      if (name === undefined) {
        rejectLine(`phase ${phase.name}: 거부됨: phase 이름은 40자 이하여야 합니다.`);
      } else if (criterion === undefined) {
        continue;
      } else if (criterion.includes('\n')) {
        rejectLine(`phase ${name}: 거부됨: 완료 조건은 한 줄로 적습니다.`);
      } else {
        ensurePhase(phaseOrder, name);
        if (criterion === '') phaseCriteria.delete(name);
        else phaseCriteria.set(name, criterion);
        await emit('model', {
          type: 'phase',
          payload: { name, criterion: criterion === '' ? null : criterion },
        });
        lines.push(`phase ${name}: 완료 조건 ${criterion === '' ? '지움' : '기록'}`);
      }
    }
    for (const entry of data.todos) {
      const outcome = applyModelTodoEntry(todos, entry, now(), settings.maxRepairsPerTodo);
      let fragment: { current?: string | null } = {};
      if (outcome.rejected === undefined) {
        ensurePhase(phaseOrder, phaseOf(outcome.todo));
        if (entry.current === true) {
          if (entry.id !== current) {
            current = entry.id;
            fragment = { current: entry.id };
          }
        } else {
          fragment = reconcileCurrent() ?? {};
        }
      }
      await emit('model', {
        type: 'todo_update',
        payload: {
          todoId: entry.id,
          ...(outcome.from === undefined ? {} : { from: outcome.from }),
          to: outcome.to,
          todo: outcome.todo,
          ...fragment,
          ...(outcome.rejected === undefined ? {} : { rejected: { reason: outcome.rejected } }),
        },
      });
      if (outcome.rejected === undefined) {
        lines.push(`${entry.id}: ${outcome.from ?? '신규'} → ${outcome.to}`);
      } else {
        rejectLine(`${entry.id}: 거부됨: ${outcome.rejected}`);
      }
    }
    await saveTodos();
    return { status: rejectedCount > 0 ? 'error' : 'ok', text: lines.join('\n') };
  };

  interface ReviewResult {
    readonly model: string;
    readonly verdict: 'pass' | 'changes';
    readonly findings: ReviewFinding[];
  }

  /**
   * 통과한 todo를 `review` 역할의 다른 모델에 도구 없이 한 번 묻는다. 형식이 틀리면 한 번 다시 묻는다.
   * 건너뛰었거나 두 번 틀렸으면 그 사실만 `review` 이벤트로 남기고 `undefined`를 돌려준다.
   * 비교하는 기준은 세션 파일 기준선이라, 이 todo의 쓰기 범위에서 세션 동안 더한 줄이 모두 들어간다.
   */
  const reviewTodo = async (todo: Todo, evidence: Evidence): Promise<ReviewResult | undefined> => {
    const executor = entryAt('default', stateOf('default').position);
    const baselines = await store.readBaselines();
    const cwdPrefix = `${input.cwd.replace(/\/$/, '')}/`;
    const diffLines: string[] = [];
    for (const path of await workspace.listScopeFiles(todo.writeScope)) {
      const before = baselines[path];
      if (before === undefined) continue;
      const after = await workspace.readText(path);
      if (after === undefined) continue;
      const shown = path.startsWith(cwdPrefix) ? path.slice(cwdPrefix.length) : path;
      for (const [line, text] of addedLines(before ?? '', after)) {
        diffLines.push(`${shown}:${line}: +${text}`);
      }
    }
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: buildReviewQuestion({
              title: todo.content,
              command: evidence.command,
              evidenceSummary: evidence.summary,
              diff: scrubText(diffLines.join('\n')).text,
            }),
          },
        ],
      },
    ];
    let model = entryAt('review', stateOf('review').position).model;
    let failure = '검토 응답이 약속한 JSON 형식이 아니었습니다.';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await requestModel(
        'review',
        { system: REVIEW_PROMPT, messages, tools: [], maxOutputTokens: 1500 },
        AbortSignal.any([signal, softStop]),
        executor,
      ).catch((error: unknown) => {
        if (error instanceof CostStopError || signal.aborted || softStop.aborted) throw error;
        if (error instanceof ReviewerUnavailableError) return error;
        return new Error(error instanceof Error ? error.message : String(error));
      });
      if (result instanceof ReviewerUnavailableError) {
        await emit('engine', {
          type: 'review',
          payload: { outcome: 'skipped', todoId: todo.id, reason: REVIEWER_UNAVAILABLE_REASON },
        });
        return undefined;
      }
      if (result instanceof Error) {
        failure = `검토 요청이 실패했습니다: ${scrubText(result.message).text}`;
        break;
      }
      const { completed, port, chainPosition, durationMs } = result;
      model = port.model;
      await emit('model', {
        type: 'model_request',
        payload: {
          model: port.model,
          adapter: port.adapter,
          chainPosition,
          role: 'review',
          nativeToolCalls: completed.nativeToolCalls,
          usage: completed.usage,
          ...addSpend(port.model, completed.usage),
          durationMs,
          purpose: 'review',
        },
      });
      const reply = completed.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n');
      const findings = parseReviewReply(reply);
      if (findings === undefined) continue;
      const verdict = findings.some((finding) => finding.severity === 'major') ? 'changes' : 'pass';
      await emit('engine', {
        type: 'review',
        payload: { outcome: 'completed', todoId: todo.id, model, verdict, findings },
      });
      return { model, verdict, findings };
    }
    await emit('engine', {
      type: 'review',
      payload: { outcome: 'failed', todoId: todo.id, model, reason: failure },
    });
    return undefined;
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
    const exitedClean = result.exitCode === 0 && !result.timedOut;
    let gate: GateResult | undefined;
    if (exitedClean) {
      const baselines = await store.readBaselines();
      const cwdPrefix = `${input.cwd.replace(/\/$/, '')}/`;
      const stubs: string[] = [];
      const unchecked: string[] = [];
      for (const path of await workspace.listScopeFiles(todo.writeScope)) {
        const after = await workspace.readText(path);
        if (after === undefined) continue;
        const shown = path.startsWith(cwdPrefix) ? path.slice(cwdPrefix.length) : path;
        const before = baselines[path];
        if (before === undefined) unchecked.push(shown);
        else stubs.push(...findStubs(shown, before ?? '', after));
      }
      gate = judgeGate({ command: todo.verify.command, output, stubs, unchecked });
    }
    const passed = exitedClean && gate?.passed !== false;
    const origin = classifyOrigin({
      command: todo.verify.command,
      cwd: input.cwd,
      instructions,
      baselines: await store.readBaselines(),
      ...(startFiles === undefined ? {} : { start: startFiles }),
      current: NODE_TEST.test(todo.verify.command)
        ? await workspace.snapshotFiles()
        : await workspace.statFiles(commandCandidates(todo.verify.command, input.cwd)),
    });
    const evidence: Evidence = {
      command: todo.verify.command,
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      summary: summarizeOutput(output, SUMMARY_MAX_CHARS),
      origin,
      ranAt: now(),
      scopeDigest: await workspace.hashFiles(todo.writeScope),
      outputRef,
      ...(result.timedOut ? { error: '시간 초과로 끝까지 실행하지 못했습니다.' } : {}),
      ...(gate === undefined || gate.passed ? {} : { gateFindings: [...gate.findings] }),
    };
    await emit('engine', {
      type: 'verification',
      payload: {
        todoId: todo.id,
        evidence,
        ...(gate === undefined
          ? {}
          : {
              gate: {
                passed: gate.passed,
                findings: [...gate.findings],
                ...(gate.unchecked.length === 0 ? {} : { unchecked: [...gate.unchecked] }),
              },
            }),
      },
    });
    const review =
      passed && settings.reviewEnabled === true ? await reviewTodo(todo, evidence) : undefined;
    const hasMajor = review?.findings.some((finding) => finding.severity === 'major') === true;
    const reviewedEvidence: Evidence = review === undefined ? evidence : { ...evidence, review };
    const repairs = todo.attempts - 1;
    const exhausted = (!passed || hasMajor) && repairs >= settings.maxRepairsPerTodo;
    let nextStatus: TodoStatus = 'verified';
    if (!passed) nextStatus = 'failed';
    else if (hasMajor) nextStatus = 'attempted';
    const updated: Todo = {
      ...todo,
      status: nextStatus,
      attempts: hasMajor ? todo.attempts + 1 : todo.attempts,
      verify: { command: todo.verify.command, origin },
      evidence: reviewedEvidence,
      updatedAt: now(),
    };
    todos.set(updated.id, updated);
    await emit('engine', {
      type: 'todo_update',
      payload: {
        todoId: updated.id,
        from: todo.status,
        to: updated.status,
        todo: updated,
        ...(reconcileCurrent() ?? {}),
      },
    });
    let finalTodo = updated;
    if (exhausted) {
      finalTodo = {
        ...updated,
        status: 'blocked',
        blockedReason: hasMajor
          ? `${repairs}번 고쳤지만 검토 지적이 남았습니다`
          : `${repairs}번 고쳤지만 검사를 통과하지 못했습니다`,
        updatedAt: now(),
      };
      todos.set(finalTodo.id, finalTodo);
      await emit('engine', {
        type: 'todo_update',
        payload: {
          todoId: finalTodo.id,
          from: updated.status,
          to: 'blocked',
          todo: finalTodo,
          ...(reconcileCurrent() ?? {}),
        },
      });
    }
    await saveTodos();
    if ((!passed || hasMajor) && stage === 'verify') await enterStage('execute');
    return {
      status: 'ok',
      text: `${todo.id}: ${finalTodo.status} (${result.timedOut ? 'timeout' : `exit ${result.exitCode ?? 'signal'}`})\n${evidence.summary}${
        review === undefined || review.findings.length === 0
          ? ''
          : `\n다른 모델(${review.model})의 검토 지적:\n${formatFindings(review.findings)}${hasMajor ? '\n중요 지적을 고친 뒤 다시 검증합니다. 이 왕복은 고친 횟수에 셉니다.' : ''}`
      }${
        gate === undefined || gate.passed
          ? ''
          : `\n완성 무결성 게이트가 걸렸습니다. 종료 코드는 0이지만 verified가 아닙니다:\n${gate.findings.map((finding) => `- ${finding}`).join('\n')}\n스텁을 구현하고 건너뜀을 없앤 뒤 다시 검증합니다. 사용자가 일부러 요청한 경우처럼 정당한 사유가 있을 때만 verify.waive로 예외를 요청합니다.`
      }`,
      outputRef,
      scrubHits: scrubbedOutput.hits,
    };
  };

  const runWaive = async (
    data: z.infer<typeof verifyWaiveSchema>,
    call: ToolCall,
  ): Promise<ControlOutput> => {
    const todo = todos.get(data.todoId);
    const findings = todo?.evidence?.gateFindings;
    if (
      todo?.evidence === undefined ||
      todo.status !== 'failed' ||
      findings === undefined ||
      findings.length === 0
    ) {
      return {
        status: 'error',
        text: `예외를 요청할 수 없습니다. 마지막 검증이 완성 무결성 게이트 때문에 failed가 된 todo만 대상입니다 (${data.todoId}: ${todo?.status ?? '없음'}).`,
      };
    }
    const evidence = todo.evidence;
    const record = (decision: 'approved' | 'denied') =>
      emit('engine', {
        type: 'permission',
        payload: { callId: call.callId, mode: settings.permissionMode, decision, scope: 'once' },
      });
    if (deps.approval === undefined) {
      await record('denied');
      return {
        status: 'error',
        text: `headless 실행은 예외 승인을 받을 수 없어 ${todo.id}는 failed 그대로입니다. 게이트가 찾은 항목을 고칩니다.`,
      };
    }
    const intent = typeof call.input.intent === 'string' ? call.input.intent : data.reason;
    const request: ApprovalRequest = {
      callId: call.callId,
      tool: 'verify.waive',
      tier: 'exec',
      reason: intent,
      detail: {
        kind: 'verify_waiver',
        reason: data.reason,
        findings: [...findings],
        command: evidence.command,
        ...(evidence.exitCode === undefined ? {} : { exitCode: evidence.exitCode }),
      },
      todo: { id: todo.id, content: todo.content },
    };
    await emit('engine', { type: 'approval_request', payload: request });
    await saveSession({ status: 'awaiting_approval' });
    waiting = 'awaiting_approval';
    const decision = await deps.approval
      .request(request, AbortSignal.any([signal, softStop]))
      .finally(startIdleSummary());
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
      return {
        status: 'error',
        text: `사용자가 예외 요청을 거부했습니다. ${todo.id}는 failed 그대로입니다.${steer}`,
      };
    }
    await record('approved');
    await restoreRunning();
    const at = now();
    const waived: Todo = {
      ...todo,
      status: 'verified',
      evidence: { ...evidence, waiver: { reason: data.reason, approvedBy: 'user', at } },
      updatedAt: at,
    };
    todos.set(waived.id, waived);
    await emit('engine', {
      type: 'todo_update',
      payload: {
        todoId: waived.id,
        from: 'failed',
        to: 'verified',
        todo: waived,
        ...(reconcileCurrent() ?? {}),
      },
    });
    await saveTodos();
    return { status: 'ok', text: `${waived.id}: verified (사용자가 게이트 예외를 승인했습니다)` };
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
      case 'verify.waive': {
        const parsed = verifyWaiveSchema.safeParse(args);
        return parsed.success ? runWaive(parsed.data, call) : invalid(parsed.error);
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
          answers = await deps.questions
            .ask(request, AbortSignal.any([signal, softStop]))
            .finally(startIdleSummary());
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
        payload: {
          todoId: updated.id,
          from: 'verified',
          to: 'attempted',
          todo: updated,
          ...(reconcileCurrent() ?? {}),
        },
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
  const shouldFallback = (error: unknown) => {
    const { on } = router.fallback;
    if (on === 'any') return true;
    return error instanceof ModelLimitError === (on === 'usage-limit');
  };
  /**
   * 역할의 체인에서 지금 위치의 모델로 요청 한 번을 보낸다. 실패하면 `fallback.on`에 맞을 때 다음 모델로 같은 요청을 다시 보내고 `retry` 이벤트를 남긴다.
   * 첫 모델이 한도 오류로 넘어갔고 그 해제 시각이 지났으면, 요청 전에 첫 모델로 되돌아간다. 취소는 폴백하지 않는다.
   */
  const requestModel = async (
    role: string,
    request: ModelRequest,
    modelSignal: AbortSignal,
    exclude?: ModelChainEntry,
  ) => {
    const state = stateOf(role);
    const chain = router.chain(role);
    let attempt = 0;
    const emitRetry = async (
      reason: 'usage-limit' | 'error' | 'revert',
      error: unknown,
      delayMs: number,
    ) => {
      attempt += 1;
      const target = entryAt(role, state.position);
      await emit('engine', {
        type: 'retry',
        payload: {
          layer: 'session',
          attempt,
          reason,
          ...(error instanceof Error ? { message: scrubText(error.message).text } : {}),
          ...(error instanceof ModelLimitError && error.resetAtMs !== undefined
            ? { resetAt: new Date(error.resetAtMs).toISOString() }
            : {}),
          delayMs,
          switchedTo: target.model,
          chainPosition: state.position,
          role,
        },
      });
    };
    if (
      state.position > 0 &&
      router.fallback.revertPolicy === 'cooldown-expiry' &&
      state.resetAtMs !== undefined &&
      clock.now().getTime() >= state.resetAtMs
    ) {
      state.position = 0;
      delete state.resetAtMs;
      await emitRetry('revert', undefined, 0);
    }
    for (;;) {
      for (
        let entry = entryAt(role, state.position);
        entry.provider === exclude?.provider && entry.model === exclude.model;
        entry = entryAt(role, state.position)
      ) {
        if (state.position + 1 >= chain.length) throw new ReviewerUnavailableError();
        state.position += 1;
      }
      const port = await currentPort(role);
      await guardCost(port.model);
      const started = clock.now().getTime();
      try {
        let completed: Extract<ModelStreamEvent, { type: 'completed' }> | undefined;
        for await (const event of port.stream(request, modelSignal)) {
          if (event.type === 'completed') completed = event;
        }
        if (completed === undefined) throw new Error('모델 스트림이 completed 없이 끝났습니다.');
        await noteUse(role);
        return {
          completed,
          port,
          chainPosition: state.position,
          durationMs: Math.max(0, clock.now().getTime() - started),
        };
      } catch (error) {
        if (signal.aborted || softStop.aborted) throw error;
        if (state.position + 1 >= chain.length || !shouldFallback(error)) throw error;
        if (state.position === 0) {
          if (error instanceof ModelLimitError && error.resetAtMs !== undefined) {
            state.resetAtMs = error.resetAtMs;
          } else delete state.resetAtMs;
        }
        state.position += 1;
        await emitRetry(error instanceof ModelLimitError ? 'usage-limit' : 'error', error, 0);
      }
    }
  };
  /**
   * 요약과 인계 문서 요청이다. 응답의 텍스트만 돌려주고 도구 호출은 무시한다. 사용량은 `purpose: 'compaction'`으로 남긴다.
   * 출력이 `cap`을 넘었거나 상한 때문에 잘렸으면 `undefined`다. 상한을 실을 수 없는 형식은 받은 문서의 어림으로 검사한다.
   */
  const requestCompaction = async (
    request: ModelRequest,
    modelSignal: AbortSignal,
    cap: number,
  ): Promise<string | undefined> => {
    const { completed, port, chainPosition, durationMs } = await requestModel(
      'compaction',
      { ...request, maxOutputTokens: cap },
      modelSignal,
    );
    await emit('model', {
      type: 'model_request',
      payload: {
        model: port.model,
        adapter: port.adapter,
        chainPosition,
        role: 'compaction',
        nativeToolCalls: completed.nativeToolCalls,
        usage: completed.usage,
        ...addSpend(port.model, completed.usage),
        durationMs,
        purpose: 'compaction',
      },
    });
    const text = completed.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')
      .trim();
    if (completed.stopReason === 'max_tokens') return undefined;
    if (port.acceptsOutputCap !== true && estimateTokens(text) > cap) return undefined;
    return text;
  };
  /**
   * 가벼운 유지보수 패스의 충돌 판정이다 (SPEC 3.4절). `memory` 역할 모델에 도구 없이 한 번 묻고, 형식이 틀리면 한 번 다시 묻는다.
   * 응답이 두 번 틀리면 `undefined`다. 사용량은 `purpose: 'memory'`로 남기고 비용 합계에 더한다.
   */
  const judgeConflict: ConflictJudge = async ({ lessonId, text, candidates }) => {
    const question = `새 교훈 ${lessonId}: ${text}\n\n기존 교훈 후보:\n${candidates.map((candidate) => `- ${candidate.id}: ${candidate.text}`).join('\n')}`;
    const messages: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: question }] },
    ];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { completed, port, chainPosition, durationMs } = await requestModel(
        'memory',
        { system: CONFLICT_JUDGE_PROMPT, messages, tools: [], maxOutputTokens: 400 },
        AbortSignal.any([signal, softStop]),
      );
      await emit('model', {
        type: 'model_request',
        payload: {
          model: port.model,
          adapter: port.adapter,
          chainPosition,
          role: 'memory',
          nativeToolCalls: completed.nativeToolCalls,
          usage: completed.usage,
          ...addSpend(port.model, completed.usage),
          durationMs,
          purpose: 'memory',
        },
      });
      const reply = completed.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n');
      const json = /\{[\s\S]*\}/.exec(reply)?.[0];
      let raw: unknown;
      try {
        raw = json === undefined ? undefined : JSON.parse(json);
      } catch {
        raw = undefined;
      }
      const parsed = conflictJudgementSchema.safeParse(raw);
      if (parsed.success) return parsed.data;
    }
    return undefined;
  };
  /** 필수 절만 있는 요약 문서의 어림이다. */
  const requiredTokens = () =>
    estimateTokens(
      buildSummaryDocument({
        instructions,
        todos: [...todos.values()],
        objective,
        phases: summaryPhases(),
        ...(current === undefined ? {} : { current }),
        openErrors: [...lastResults]
          .filter(([, result]) => result.isError)
          .map(([tool, result]) => ({ tool, summary: result.text })),
        narrative: '',
      }),
    );
  const firstEligible = () => (hasSummary ? 1 : 0);
  /** 도구 출력 가지치기나 shake가 바꾼 메시지 범위를 `compaction` 이벤트로 남긴다. */
  const recordRewrite = async (
    method: 'prune' | 'shake',
    touched: readonly number[],
    callIds: readonly string[],
    tokensBefore: number,
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
        savedTokens: Math.max(0, tokensBefore - estimateTokens(history)),
      },
    });
    knownTokens = undefined;
  };
  // 다음 압축에 쓸 요약이다. `end`는 요약이 덮는 `history` 앞쪽 메시지 수이고 `lastSeq`는 그 마지막 메시지의 seq다.
  let prepared:
    { end: number; lastSeq: number; narrative: string; kind: 'ahead' | 'idle' } | undefined;
  /** 앞 `cut`개 메시지를 요약 문서 하나로 바꾼다. 필수 절은 엔진이 기록에서 만든다. */
  const commit = async (
    method: 'handoff' | 'summary' | 'remote',
    cut: number,
    parts: { narrative: string; turnPrefix?: string; prepared?: 'ahead' | 'idle' },
  ) => {
    const { prepared: preparedKind, ...documentParts } = parts;
    const document = scrubText(
      buildSummaryDocument({
        instructions,
        todos: [...todos.values()],
        objective,
        phases: summaryPhases(),
        ...(current === undefined ? {} : { current }),
        openErrors: [...lastResults]
          .filter(([, result]) => result.isError)
          .map(([tool, result]) => ({ tool, summary: result.text })),
        method: method === 'handoff' ? 'handoff' : 'summary',
        ...documentParts,
      }),
    ).text;
    const fromSeq = historySeqs[0] ?? 1;
    const toSeq = historySeqs[cut - 1] ?? fromSeq;
    const path = await store.writeCompaction(document);
    await emit('engine', {
      type: 'compaction',
      payload: {
        method,
        fromSeq,
        toSeq,
        path,
        prunedCallIds: [],
        ...(preparedKind === undefined ? {} : { prepared: preparedKind }),
      },
    });
    history.splice(0, cut, summaryMessage(document));
    historySeqs.splice(0, cut, fromSeq);
    hasSummary = true;
    prepared = undefined;
    knownTokens = undefined;
  };
  /**
   * 압축 결과가 기준선의 80% 아래에 오도록 줄인 원문 유지 범위의 시작 위치와, 문서가 쓸 수 있는 출력 상한이다.
   * 상한은 min(기본 상한, 모델의 최대 출력, 남은 자리)이고, 남은 자리가 `MIN_OUTPUT_ROOM`보다 작으면 `undefined`다.
   */
  const keepCut = (
    window: number,
    maxOutput: number | undefined,
    minimal = false,
  ): { cut: number; cap: number } | undefined => {
    const base =
      window * settings.compactAtRatio * PROGRESS_RATIO -
      (estimateTokens(system) + estimateTokens(specs) + requiredTokens());
    const keepTokens = minimal
      ? 0
      : Math.max(0, Math.min(settings.keepRecentTokens, base - MIN_OUTPUT_ROOM));
    const cut = findKeepCut(history, keepTokens);
    if (cut === undefined || cut <= firstEligible()) return undefined;
    const room = base - estimateTokens(history.slice(cut));
    if (room < MIN_OUTPUT_ROOM) return undefined;
    return {
      cut,
      cap: Math.floor(Math.min(COMPACTION_OUTPUT_CAP, maxOutput ?? COMPACTION_OUTPUT_CAP, room)),
    };
  };
  const runShake = async (): Promise<boolean> => {
    const upToSeq = shakeBoundarySeq(history, historySeqs, settings.keepRecentTokens);
    if (upToSeq === undefined) return false;
    const tokensBefore = estimateTokens(history);
    const { touched, callIds } = shakeMessages(history, historySeqs, upToSeq, firstEligible());
    if (touched.length === 0) return false;
    await recordRewrite('shake', touched, callIds, tokensBefore, upToSeq);
    return true;
  };
  const runHandoff = async (
    window: number,
    modelSignal: AbortSignal,
    minimal = false,
  ): Promise<boolean> => {
    const port = await currentPort('compaction');
    const kept = keepCut(window, port.maxOutputTokens, minimal);
    if (kept === undefined) return false;
    const { cut, cap } = kept;
    const messages = [...history];
    const prompt = port.acceptsOutputCap === true ? HANDOFF_PROMPT : withCap(HANDOFF_PROMPT, cap);
    appendMessage(messages, { role: 'user', content: [{ type: 'text', text: prompt }] });
    const narrative = await requestCompaction({ system, messages, tools: specs }, modelSignal, cap);
    if (narrative === undefined || narrative === '') return false;
    await commit('handoff', cut, { narrative });
    return true;
  };
  /** 앞선 요약 문서에서 모델이 쓴 서술이다. 요약이 없으면 `undefined`다. */
  const previousNarrative = () => {
    if (!hasSummary) return undefined;
    const first = history[0]?.content.flatMap((block) =>
      block.type === 'text' ? [block.text] : [],
    );
    return narrativeOf((first ?? []).join('\n'));
  };
  const askSummary = (
    port: ModelPort,
    modelSignal: AbortSignal,
    askSystem: string,
    messages: readonly ModelMessage[],
    askCap: number,
    prior?: string,
  ) =>
    requestCompaction(
      {
        system: port.acceptsOutputCap === true ? askSystem : withCap(askSystem, askCap),
        messages: [
          { role: 'user', content: [{ type: 'text', text: buildSummaryInput(messages, prior) }] },
        ],
        tools: [],
      },
      modelSignal,
      askCap,
    );
  /**
   * 다음 압축에 쓸 요약을 미리 만들어 `prepared`에 둔다. 만들지 못하면 조용히 넘어가고, 압축 시점에 평소대로 요약한다.
   * 비용은 `requestCompaction`이 비용 합계에 더한다.
   */
  const prepareSummary = async (kind: 'ahead' | 'idle', window: number) => {
    if (prepared !== undefined || !settings.methodOrder.includes('summary')) return;
    if (
      estimateInput() <
      window * settings.compactAtRatio * (kind === 'ahead' ? AHEAD_RATIO : IDLE_RATIO)
    )
      return;
    const port = await currentPort('compaction');
    const kept = keepCut(window, port.maxOutputTokens);
    if (kept === undefined) return;
    const lastSeq = historySeqs[kept.cut - 1];
    if (lastSeq === undefined) return;
    try {
      const narrative = await askSummary(
        port,
        AbortSignal.any([signal, softStop]),
        SUMMARY_SYSTEM,
        history.slice(firstEligible(), kept.cut),
        kept.cap,
        previousNarrative(),
      );
      if (narrative !== undefined) prepared = { end: kept.cut, lastSeq, narrative, kind };
    } catch (error) {
      if (signal.aborted || softStop.aborted) throw error;
    }
  };
  // 쉴 때 요약이 돌고 있으면 그 요청이다. 다음 모델 요청 전에 끝까지 기다린다.
  let preparing: Promise<void> = Promise.resolve();
  /** 사용자 입력을 기다리기 시작할 때 부른다. `idleSummaryMs`가 지나도 기다리는 중이면 쉴 때 요약을 만들고, 돌려준 함수를 부르면 타이머를 끈다. */
  const startIdleSummary = (): (() => void) => {
    const delay = settings.idleSummaryMs ?? 0;
    if (delay <= 0) return () => undefined;
    const timer = setTimeout(() => {
      preparing = (async () => {
        const window = (await currentPort('default')).contextWindow;
        if (window !== undefined) await prepareSummary('idle', window);
      })().catch(() => undefined);
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  };
  /** 미리 만든 요약이 지금도 `history`의 앞쪽 `cut` 안을 그대로 덮으면 돌려준다. */
  const usablePrepared = (cut: number) =>
    prepared !== undefined &&
    prepared.end > firstEligible() &&
    prepared.end <= cut &&
    historySeqs[prepared.end - 1] === prepared.lastSeq
      ? prepared
      : undefined;
  const runRemote = async (
    window: number,
    modelSignal: AbortSignal,
    minimal = false,
  ): Promise<boolean> => {
    const port = await currentPort('compaction');
    if (port.compact === undefined) return false;
    const kept = keepCut(window, port.maxOutputTokens, minimal);
    if (kept === undefined) return false;
    const { cut, cap } = kept;
    await guardCost(port.model);
    const started = clock.now().getTime();
    let result;
    try {
      result = await port.compact(
        { system, messages: history.slice(0, cut), tools: specs, maxOutputTokens: cap },
        modelSignal,
      );
    } catch (error) {
      if (signal.aborted || softStop.aborted) throw error;
      return false;
    }
    if (result === undefined) return false;
    await noteUse('compaction');
    await emit('model', {
      type: 'model_request',
      payload: {
        model: port.model,
        adapter: port.adapter,
        chainPosition: stateOf('compaction').position,
        role: 'compaction',
        nativeToolCalls: false,
        usage: result.usage,
        ...addSpend(port.model, result.usage),
        durationMs: Math.max(0, clock.now().getTime() - started),
        purpose: 'compaction',
      },
    });
    const text = scrubText(result.text.trim()).text;
    if (text === '' || estimateTokens(text) > cap) return false;
    await commit('remote', cut, { narrative: text });
    return true;
  };
  const runSummary = async (
    window: number,
    modelSignal: AbortSignal,
    minimal = false,
  ): Promise<boolean> => {
    const port = await currentPort('compaction');
    const kept = keepCut(window, port.maxOutputTokens, minimal);
    if (kept === undefined) return false;
    const { cut, cap } = kept;
    const start = firstEligible();
    const previous = previousNarrative();
    const turnStart = findTurnStart(history, cut, start);
    // 턴 중간에서 잘랐고 그 앞에 요약할 메시지가 있으면, 턴 앞부분은 따로 요약해 붙인다. 상한을 나눠 쓰고 나눈 값이 너무 작으면 나누지 않는다.
    const splitAt =
      turnStart !== undefined && turnStart > start && Math.floor(cap / 3) >= MIN_OUTPUT_ROOM
        ? turnStart
        : undefined;
    const mainCap = splitAt === undefined ? cap : cap - Math.floor(cap / 3);
    const ready = splitAt === undefined ? usablePrepared(cut) : undefined;
    let narrative: string | undefined;
    if (ready === undefined) {
      narrative = await askSummary(
        port,
        modelSignal,
        SUMMARY_SYSTEM,
        history.slice(start, splitAt ?? cut),
        mainCap,
        previous,
      );
    } else if (ready.end === cut) {
      narrative = ready.narrative;
    } else {
      // 미리 만든 요약 뒤로 늘어난 메시지만 이어 붙인다.
      narrative = await askSummary(
        port,
        modelSignal,
        SUMMARY_SYSTEM,
        history.slice(ready.end, cut),
        mainCap,
        ready.narrative,
      );
    }
    if (narrative === undefined) return false;
    const turnPrefix =
      splitAt === undefined
        ? undefined
        : await askSummary(
            port,
            modelSignal,
            TURN_PREFIX_SYSTEM,
            history.slice(splitAt, cut),
            Math.floor(cap / 3),
          );
    if (splitAt !== undefined && turnPrefix === undefined) return false;
    await commit('summary', cut, {
      narrative: narrative === '' ? '(요약 모델이 내용을 쓰지 않았습니다.)' : narrative,
      ...(turnPrefix === undefined ? {} : { turnPrefix }),
      ...(ready === undefined ? {} : { prepared: ready.kind }),
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
      const previous = current;
      const moved = reconcileCurrent();
      const movedTo = todos.get(moved?.current ?? previous ?? '');
      if (moved !== undefined && movedTo !== undefined) {
        await emit('engine', {
          type: 'todo_update',
          payload: {
            todoId: movedTo.id,
            from: movedTo.status,
            to: movedTo.status,
            todo: movedTo,
            ...moved,
          },
        });
      }
      const resumed = [...todos.values()];
      if (
        plan.fromStatus === 'stopped' &&
        resumed.length > 0 &&
        resumed.every((todo) => isDone(todo.status))
      ) {
        if (resumed.every((todo) => todo.status === 'abandoned')) {
          return await finish('stopped', 'abandoned', '모든 todo를 포기했습니다.');
        }
        if (STAGES.indexOf(stage) < STAGES.indexOf('learn')) await enterStage('learn');
      }
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
            text: `${notice}${resume.steer === undefined ? '' : `\n사용자 지시: ${resume.steer}`}\n${describeState([...todos.values()])}\n현재 단계: ${stage}`,
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

      const window = (await currentPort('default')).contextWindow;
      if (window !== undefined) {
        const threshold = window * settings.compactAtRatio;
        // 시스템 프롬프트, 도구 명세, 필수 절만으로 창을 넘으면 더 줄일 곳이 없다 (SPEC 4.3절 넘침).
        const floor = estimateTokens(system) + estimateTokens(specs) + requiredTokens();
        if (floor > window) {
          return await finish(
            'stopped',
            'context_overflow',
            '지시가 너무 길어 이어 갈 수 없습니다. 지시를 나눠 다시 보냅니다.',
          );
        }
        await preparing;
        let estimate = estimateInput();
        if (estimate < threshold && estimate >= threshold * AHEAD_RATIO) {
          await prepareSummary('ahead', window);
        }
        if (estimate >= threshold) {
          const pruneIds = planPrune(history, settings.protectToolTokens, settings.minPruneSavings);
          const tokensBefore = estimateTokens(history);
          const pruned = pruneIds.length === 0 ? [] : applyPrune(history, new Set(pruneIds));
          if (pruned.length > 0) {
            await recordRewrite('prune', pruned, pruneIds, tokensBefore);
            estimate = estimateInput();
          }
        }
        // 가지치기만으로 기준선 아래로 내려가면 압축하지 않는다. 앞선 압축이 여유를 만들지 못했다면 창 안에서는 몇 응답 동안 다시 시도하지 않는다.
        if (
          estimate >= threshold &&
          (estimate > window || responsesSincePass >= PASS_RETRY_RESPONSES)
        ) {
          const passSignal = AbortSignal.any([signal, softStop]);
          const methods = {
            remote: runRemote,
            shake: runShake,
            handoff: runHandoff,
            summary: runSummary,
          };
          let reached = false;
          let lastCompressor: 'remote' | 'handoff' | 'summary' = 'summary';
          // 미리 만든 요약이 있으면 그 뒤로 늘어난 부분만 요약하면 되므로 다른 방식보다 먼저 시도한다.
          const order =
            usablePrepared(history.length) === undefined
              ? settings.methodOrder
              : ['summary' as const, ...settings.methodOrder.filter((name) => name !== 'summary')];
          for (const method of order) {
            if (!(await methods[method](window, passSignal))) continue;
            if (method !== 'shake') lastCompressor = method;
            estimate = estimateInput();
            if (estimate <= threshold * PROGRESS_RATIO) {
              reached = true;
              break;
            }
          }
          if (!reached) {
            // 마지막 단계: 원문으로 남기는 범위를 진행 중인 도구 호출과 결과 한 쌍까지 줄인다. 같은 모델로 이어 간다.
            if (await methods[lastCompressor](window, passSignal, true)) estimate = estimateInput();
            const lastIds = (history.at(-1)?.content ?? []).flatMap((block) =>
              block.type === 'tool_result' ? [block.callId] : [],
            );
            if (estimate > window && lastIds.length > 0) {
              const tokensBefore = estimateTokens(history);
              const touched = applyPrune(history, new Set(lastIds));
              if (touched.length > 0) {
                await recordRewrite('prune', touched, lastIds, tokensBefore);
                estimate = estimateInput();
              }
            }
            reached = estimate <= threshold * PROGRESS_RATIO;
          }
          responsesSincePass = reached ? Number.POSITIVE_INFINITY : 0;
        }
      }
      const modelSignal = AbortSignal.any([signal, softStop]);
      const { completed, port, chainPosition, durationMs } = await requestModel(
        'default',
        { system, messages: history, tools: specs },
        modelSignal,
      );
      const content = [...completed.content];
      await emit('model', {
        type: 'model_request',
        payload: {
          model: port.model,
          adapter: port.adapter,
          chainPosition,
          role: 'default',
          nativeToolCalls: completed.nativeToolCalls,
          usage: completed.usage,
          ...addSpend(port.model, completed.usage),
          durationMs,
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
      const accountPin = port.accountPin?.();
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
        const stopped = await judgeTodos();
        if (stopped !== undefined) return stopped;
        const list = [...todos.values()];
        if (
          getStage() === 'learn' &&
          list.length > 0 &&
          list.every((todo) => isDone(todo.status))
        ) {
          const abandoned = list.filter((todo) => todo.status === 'abandoned').length;
          return await finish(
            'completed',
            'passed',
            abandoned === 0 ? text : `${text}\n포기 ${abandoned}개`,
          );
        }
        const nudge =
          list.length === 0 || list.some((todo) => !isDone(todo.status))
            ? '아직 모든 todo가 verified가 아닙니다. 작업을 계속합니다.'
            : 'learn 단계까지 stage.advance로 진행한 뒤 마무리합니다.';
        await pushUser('engine', [
          { type: 'text', text: `${nudge}\n${describeState(list)}\n현재 단계: ${stage}` },
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
      await flushMcpNotices();
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
        text: `${describeState([...todos.values()])}\n현재 단계: ${stage}`,
      });
      await pushUser('tool', observations, pendingSteers.splice(0));
      const stopped = await judgeTodos();
      if (stopped !== undefined) return stopped;
    }
  } catch (error) {
    if (signal.aborted || softStop.aborted) return await finishCancelled();
    if (error instanceof CostStopError) {
      await emit('engine', {
        type: 'memory',
        payload: { learnSkipped: true, reason: 'cost_limit' },
      });
      return await finish('stopped', 'cost_limit', error.message);
    }
    return await finish('failed', 'error', error instanceof Error ? error.message : String(error));
  }
}
