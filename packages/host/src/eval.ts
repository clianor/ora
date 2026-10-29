import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createCatalog } from '@ora/adapters';
import type { CatalogModel } from '@ora/adapters';
import { oraEventSchema, stageSchema } from '@ora/protocol';
import type { OraEvent, Todo } from '@ora/protocol';
import { z } from 'zod';
import { UsageError, loadConfig } from './config.ts';
import { resolveOraHome } from './isolation/ora-home.ts';
import { launchSession } from './supervisor.ts';
import type { SessionResult } from './supervisor.ts';

const run = promisify(execFile);

const HIDDEN_CHECK_TIMEOUT_MS = 120_000;
const HARD_CANCEL_GRACE_MS = 30_000;
const OUTPUT_SUMMARY_CHARS = 1000;
const PROVIDERS = ['claude', 'codex', 'grok'] as const;

/** `eval/tasks/<이름>/task.json`의 형식이다 (SPEC 6.3절). */
const taskSchema = z.strictObject({
  /** 모델에게 주는 작업 지시문이다. */
  instruction: z.string().min(1),
  /** 모델이 `ask_user`로 물으면 하네스가 질문마다 이 글을 답으로 준다. 없으면 `ask_user`는 headless 동작을 따른다. */
  answer: z.string().min(1).optional(),
  /** 세션이 끝난 뒤 `hidden/`을 섞은 작업 폴더 사본에서 실행하는 셸 명령이다. 종료 코드 0이 통과다. */
  hiddenCheck: z.string().min(1),
  timeLimitSeconds: z.number().int().positive().default(900),
  maxSteps: z.number().int().positive().optional(),
});

interface EvalTask {
  readonly name: string;
  readonly dir: string;
  readonly spec: z.infer<typeof taskSchema>;
}

interface Dimensions {
  readonly correctness: { passed: boolean; exitCode: number | null; outputSummary: string };
  readonly verification: {
    verifiedTodos: number;
    totalTodos: number;
    verifiedRatio: number | null;
    gateFailures: number;
    modelOnlyVerifiedTodos: number;
  };
  readonly completion: {
    status: string;
    endReason: string;
    todoCounts: Record<string, number>;
    blocked: string[];
  };
  readonly memory: { proposals: number; recalledLessons: null };
  readonly cost: {
    uncachedInputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    outputTokens: number;
  };
  readonly speed: { wallMs: number; steps: number };
  readonly interaction: { askUserCalls: number; answers: number; note?: string };
  readonly fallbacks: number;
  readonly stageRollbacks: number;
  readonly models: string[];
}

interface RunRecord {
  readonly task: string;
  readonly model: string;
  sessionId?: string;
  sessionDir?: string;
  workspace?: string;
  timedOut?: boolean;
  error?: string;
  dimensions?: Dimensions;
}

export interface EvalOptions {
  readonly setPath: string;
  readonly models: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly configPath?: string;
  /** 결과 폴더를 만들 상위 폴더다. 기본값은 `<cwd>/eval/results`다. */
  readonly outDir?: string;
  /** 있으면 실제 모델 대신 가짜 모델 스크립트를 쓴다. `--model`은 기록용 이름이 된다. */
  readonly modelScriptPath?: string;
  readonly log: (line: string) => void;
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

async function loadTasks(setPath: string): Promise<EvalTask[]> {
  const root = resolve(setPath);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => {
    throw new UsageError(`작업 세트 폴더를 읽을 수 없습니다: ${setPath}`);
  });
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) throw new UsageError(`작업 세트에 작업 폴더가 없습니다: ${setPath}`);
  return Promise.all(
    names.map(async (name) => {
      const dir = join(root, name);
      const raw = await readFile(join(dir, 'task.json'), 'utf8').catch(() => {
        throw new UsageError(`작업 ${name}: task.json을 읽을 수 없습니다.`);
      });
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch (error) {
        throw new UsageError(`작업 ${name}: task.json이 JSON이 아닙니다: ${String(error)}`);
      }
      const parsed = taskSchema.safeParse(json);
      if (!parsed.success) {
        throw new UsageError(
          `작업 ${name}: task.json 형식이 틀립니다.\n${z.prettifyError(parsed.error)}`,
        );
      }
      for (const sub of ['start', 'hidden']) {
        if (!(await isDirectory(join(dir, sub)))) {
          throw new UsageError(`작업 ${name}: ${sub}/ 폴더가 없습니다.`);
        }
      }
      return { name, dir, spec: parsed.data };
    }),
  );
}

const baseConfigSchema = z.looseObject({
  providers: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  paths: z.record(z.string(), z.unknown()).default({}),
  limits: z.record(z.string(), z.unknown()).default({}),
});
type BaseConfig = z.infer<typeof baseConfigSchema>;

/** 설정 파일의 다른 값은 그대로 두고, 실행마다 바꿀 `providers`·`paths`·`limits`만 꺼낸다. 파일 형식은 `loadConfig`가 이미 검사했다. */
async function readBaseConfig(
  configPath: string | undefined,
  oraHome: string,
): Promise<BaseConfig> {
  const raw = await readFile(configPath ?? join(oraHome, 'engine.config.json'), 'utf8').catch(
    () => '{}',
  );
  return baseConfigSchema.parse(JSON.parse(raw));
}

/** KST 날짜와 그날의 다음 번호로 결과 폴더를 만든다. */
async function createResultDir(outDir: string): Promise<{ dir: string; date: string }> {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  await mkdir(outDir, { recursive: true });
  const taken = (await readdir(outDir))
    .filter((name) => name.startsWith(`${date}-`))
    .map((name) => Number(name.slice(date.length + 1)))
    .filter((number) => Number.isInteger(number));
  for (let next = Math.max(0, ...taken) + 1; ; next += 1) {
    const dir = join(outDir, `${date}-${String(next).padStart(2, '0')}`);
    try {
      await mkdir(dir);
      return { dir, date };
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
  }
}

async function readGitCommit(cwd: string): Promise<string> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd });
    const { stdout: dirty } = await run('git', ['status', '--porcelain'], { cwd });
    return dirty.trim() === '' ? stdout.trim() : `${stdout.trim()} (커밋하지 않은 변경 있음)`;
  } catch {
    return '확인할 수 없음';
  }
}

const GIT_IDENTITY = [
  '-c',
  'user.name=ora-eval',
  '-c',
  'user.email=eval@ora.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
];

async function createWorkspace(task: EvalTask): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `ora-eval-${task.name}-`));
  await cp(join(task.dir, 'start'), dir, { recursive: true });
  await run('git', ['init', '--quiet'], { cwd: dir });
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', [...GIT_IDENTITY, 'commit', '--quiet', '--allow-empty', '-m', 'start'], {
    cwd: dir,
  });
  return dir;
}

/** 세션이 끝난 뒤에만 `hidden/`을 작업 폴더 사본에 넣어 검사를 돌린다. 원래 작업 폴더는 건드리지 않는다. */
async function runHiddenCheck(task: EvalTask, workspace: string) {
  const copy = `${workspace}-check`;
  await cp(workspace, copy, { recursive: true });
  try {
    await cp(join(task.dir, 'hidden'), copy, { recursive: true });
    const outcome = await run('sh', ['-c', task.spec.hiddenCheck], {
      cwd: copy,
      timeout: HIDDEN_CHECK_TIMEOUT_MS,
      env: process.env,
    }).then(
      ({ stdout, stderr }) => ({ exitCode: 0, output: `${stdout}${stderr}` }),
      (error: unknown) => {
        const failure = error as { code?: unknown; stdout?: string; stderr?: string };
        return {
          exitCode: typeof failure.code === 'number' ? failure.code : null,
          output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
        };
      },
    );
    return {
      passed: outcome.exitCode === 0,
      exitCode: outcome.exitCode,
      outputSummary: outcome.output.trim().slice(-OUTPUT_SUMMARY_CHARS),
    };
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}

const STAGE_ORDER: readonly string[] = stageSchema.options;

/** 세션 기록(이벤트와 todo)에서 SPEC 6.3절의 여섯 차원과 폴백·단계 되돌림을 계산한다. */
function summarizeSession(
  events: readonly OraEvent[],
  todos: readonly Todo[],
  result: SessionResult,
  correctness: Dimensions['correctness'],
  wallMs: number,
  hasAnswer: boolean,
): Dimensions {
  const requests = events.flatMap((event) =>
    event.type === 'model_request' ? [event.payload] : [],
  );
  const stepRequests = requests.filter((request) => request.purpose === undefined);
  const sum = (pick: (usage: (typeof requests)[number]['usage']) => number) =>
    requests.reduce((total, request) => total + pick(request.usage), 0);
  const verified = todos.filter((todo) => todo.status === 'verified');
  const todoCounts: Record<string, number> = {};
  for (const todo of todos) todoCounts[todo.status] = (todoCounts[todo.status] ?? 0) + 1;

  let stageRollbacks = 0;
  let lastStage = -1;
  for (const event of events) {
    if (event.type !== 'stage' || event.payload.outcome !== 'entered') continue;
    const index = STAGE_ORDER.indexOf(event.payload.stage);
    if (index < lastStage) stageRollbacks += 1;
    lastStage = index;
  }

  const askUserCalls = events.filter(
    (event) => event.type === 'tool_call' && event.payload.tool === 'ask_user',
  ).length;
  return {
    correctness,
    verification: {
      verifiedTodos: verified.length,
      totalTodos: todos.length,
      verifiedRatio: todos.length === 0 ? null : verified.length / todos.length,
      gateFailures: events.filter(
        (event) => event.type === 'verification' && event.payload.gate?.passed === false,
      ).length,
      modelOnlyVerifiedTodos: verified.filter((todo) => todo.evidence?.origin === 'model').length,
    },
    completion: {
      status: result.status,
      endReason: result.endReason,
      todoCounts,
      blocked: todos
        .filter((todo) => todo.status === 'blocked')
        .map((todo) => `${todo.id}: ${todo.blockedReason ?? '사유 없음'}`),
    },
    memory: {
      proposals: events.filter(
        (event) => event.type === 'tool_call' && event.payload.tool === 'memory.propose',
      ).length,
      // 엔진이 회상 팩을 기록에 남기지 않아 회상한 교훈 수는 세션 기록에서 구할 수 없다.
      recalledLessons: null,
    },
    cost: {
      uncachedInputTokens: sum((usage) => usage.uncachedInputTokens),
      cacheReadInputTokens: sum((usage) => usage.cacheReadInputTokens),
      cacheCreationInputTokens: sum((usage) => usage.cacheCreationInputTokens),
      outputTokens: sum((usage) => usage.outputTokens),
    },
    speed: { wallMs, steps: stepRequests.length },
    interaction: {
      askUserCalls,
      answers: events.filter((event) => event.type === 'answer').length,
      ...(hasAnswer && askUserCalls === 0 ? { note: '질문 없음' } : {}),
    },
    fallbacks: requests.filter((request) => request.chainPosition > 0).length,
    stageRollbacks,
    models: [...new Set(requests.map((request) => request.model))],
  };
}

interface RunContext {
  readonly options: EvalOptions;
  readonly resultDir: string;
  readonly baseConfig: BaseConfig;
  readonly catalog: (id: string) => CatalogModel | undefined;
}

/** 작업 × 모델 하나를 위한 설정 파일을 쓴다. 세션 기록과 기억은 결과 폴더 아래로 보내고, `auth.json`은 `ORA_HOME`에서 그대로 읽는다. */
async function writeRunConfig(context: RunContext, task: EvalTask, model: string, id: string) {
  const { baseConfig, resultDir, options } = context;
  const providers: Record<string, Record<string, unknown>> = { ...baseConfig.providers };
  if (options.modelScriptPath === undefined) {
    const provider = context.catalog(model)?.provider;
    for (const name of PROVIDERS) {
      const rest = { ...providers[name] };
      delete rest.model;
      providers[name] = name === provider ? { ...rest, model } : rest;
    }
  }
  const config = {
    ...baseConfig,
    schemaVersion: 1,
    paths: {
      ...baseConfig.paths,
      sessions: join(resultDir, 'sessions'),
      memory: join(resultDir, 'memory', id),
    },
    providers,
    ...(task.spec.maxSteps === undefined
      ? {}
      : { limits: { ...baseConfig.limits, maxSteps: task.spec.maxSteps } }),
  };
  const path = join(resultDir, 'configs', `${id}.json`);
  await mkdir(join(resultDir, 'configs'), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2));
  return path;
}

async function runTask(context: RunContext, task: EvalTask, model: string): Promise<RunRecord> {
  const { options } = context;
  const id = `${task.name}__${model.replace(/[^A-Za-z0-9._-]/g, '_')}`;
  const record: RunRecord = { task: task.name, model };
  try {
    const workspace = await createWorkspace(task);
    record.workspace = workspace;
    const configPath = await writeRunConfig(context, task, model, id);
    const hasAnswer = task.spec.answer !== undefined;

    const started = performance.now();
    const handle = launchSession({
      env: options.env,
      request: {
        type: 'createSession',
        task: task.spec.instruction,
        cwd: workspace,
        configPath,
        permissionMode: 'bypass-permissions',
        isolation: 'clean-home',
        ...(options.modelScriptPath === undefined
          ? {}
          : { modelScriptPath: options.modelScriptPath }),
        // 정해 둔 답이 있는 작업만 질문을 호스트로 올린다. 그 밖의 작업은 기존 headless 동작 그대로다.
        ...(hasAnswer ? { interactive: true } : {}),
      },
      onQuestionRequest: (requestId, request) => {
        handle.answerQuestion(
          requestId,
          request.questions.map(() => ({ choices: [], text: task.spec.answer ?? '' })),
        );
      },
      onApprovalRequest: (requestId) => {
        handle.resolveApproval(requestId, { outcome: 'denied' });
      },
    });
    let hardTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      record.timedOut = true;
      handle.cancel('soft');
      hardTimer = setTimeout(() => {
        handle.cancel('hard');
      }, HARD_CANCEL_GRACE_MS);
    }, task.spec.timeLimitSeconds * 1000);
    let result: SessionResult;
    try {
      result = await handle.result;
    } finally {
      clearTimeout(timer);
      clearTimeout(hardTimer);
    }
    const wallMs = Math.round(performance.now() - started);
    record.sessionId = result.sessionId;
    record.sessionDir = result.sessionDir;

    const events = (await readFile(join(result.sessionDir, 'transcript.jsonl'), 'utf8'))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => oraEventSchema.parse(JSON.parse(line)));
    const correctness = await runHiddenCheck(task, workspace);
    record.dimensions = summarizeSession(
      events,
      result.todos,
      result,
      correctness,
      wallMs,
      hasAnswer,
    );
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
  }
  return record;
}

const cell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ');

function formatRow(record: RunRecord): string {
  const { dimensions: d } = record;
  const session = record.sessionDir ?? '-';
  if (d === undefined) {
    return `| ${record.task} | ${record.model} | 실행 실패: ${cell(record.error ?? '')} | - | - | - | - | - | - | - | ${session} |`;
  }
  const ratio = d.verification.verifiedRatio;
  const counts = Object.entries(d.completion.todoCounts)
    .map(([status, count]) => `${status} ${count}`)
    .join(', ');
  const blocked =
    d.completion.blocked.length === 0 ? '' : `; blocked: ${d.completion.blocked.join(' / ')}`;
  const cost = d.cost;
  const asked =
    d.interaction.note ??
    (d.interaction.askUserCalls > 0 ? `질문 ${d.interaction.askUserCalls}회` : '-');
  return `| ${[
    record.task,
    record.model,
    d.correctness.passed ? '통과' : `실패 (exit ${d.correctness.exitCode ?? '없음'})`,
    `verified ${d.verification.verifiedTodos}/${d.verification.totalTodos}${ratio === null ? '' : ` (${Math.round(ratio * 100)}%)`}, 게이트 실패 ${d.verification.gateFailures}, 모델 검사로만 통과 ${d.verification.modelOnlyVerifiedTodos}`,
    `${d.completion.status} (${d.completion.endReason})${record.timedOut === true ? ', 시간 상한 도달' : ''}; ${counts || 'todo 없음'}${blocked}`,
    `제안 ${d.memory.proposals}, 회상 기록 없음`,
    `입력 ${cost.uncachedInputTokens}, 출력 ${cost.outputTokens}, 캐시 읽기 ${cost.cacheReadInputTokens}, 캐시 쓰기 ${cost.cacheCreationInputTokens}`,
    `${(d.speed.wallMs / 1000).toFixed(1)}초, ${d.speed.steps}스텝`,
    `폴백 ${d.fallbacks}, 단계 되돌림 ${d.stageRollbacks}`,
    asked,
    session,
  ]
    .map(cell)
    .join(' | ')} |`;
}

function formatReport(header: {
  date: string;
  commit: string;
  models: readonly string[];
  setPath: string;
  tasks: readonly string[];
  records: readonly RunRecord[];
}): string {
  return `${[
    '# ora eval 결과',
    '',
    `- 날짜(KST): ${header.date}`,
    `- 커밋: ${header.commit}`,
    `- 모델: ${header.models.join(', ')}`,
    `- 작업 세트: ${header.setPath} (${header.tasks.join(', ')})`,
    '',
    '| 작업 | 모델 | 정확성 | 검증 충실도 | 작업 완결도 | 기억 활용 | 비용 효율 | 속도 | 폴백·되돌림 | 사용자 질문 | 세션 폴더 |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...header.records.map(formatRow),
  ].join('\n')}\n`;
}

/**
 * 작업 세트의 모든 작업을 모델마다 한 번씩 실제 세션으로 돌리고 결과 폴더 경로를 돌려준다 (SPEC 6.3절).
 * 작업 하나가 실패해도 나머지는 계속 돌린다. 설정이나 작업 형식이 틀리면 시작 전에 `UsageError`를 던진다.
 */
export async function runEval(options: EvalOptions): Promise<string> {
  const oraHome = resolveOraHome(options.env);
  const tasks = await loadTasks(options.setPath);
  const config = await loadConfig(options.configPath, oraHome);
  const catalog = createCatalog(config.models);
  if (options.modelScriptPath === undefined) {
    for (const model of options.models) {
      const provider = catalog(model)?.provider;
      if (!PROVIDERS.some((name) => name === provider)) {
        throw new UsageError(
          `카탈로그에 없는 모델입니다: ${model}. 설정 파일의 models에 id와 provider(claude, codex, grok)를 추가합니다.`,
        );
      }
    }
  }
  const baseConfig = await readBaseConfig(options.configPath, oraHome);
  const { dir: resultDir, date } = await createResultDir(
    resolve(options.cwd, options.outDir ?? join('eval', 'results')),
  );
  const context: RunContext = { options, resultDir, baseConfig, catalog };

  const records: RunRecord[] = [];
  for (const task of tasks) {
    for (const model of options.models) {
      options.log(`실행: ${task.name} × ${model}`);
      records.push(await runTask(context, task, model));
    }
  }

  const commit = await readGitCommit(options.cwd);
  const taskNames = tasks.map((task) => task.name);
  await writeFile(
    join(resultDir, 'results.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        date,
        commit,
        models: options.models,
        taskSet: { path: resolve(options.setPath), tasks: taskNames },
        runs: records,
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(resultDir, 'report.md'),
    formatReport({
      date,
      commit,
      models: options.models,
      setPath: options.setPath,
      tasks: taskNames,
      records,
    }),
  );
  return resultDir;
}
