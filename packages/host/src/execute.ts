import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAccountStore,
  createCatalog,
  createFetchModel,
  loadScriptedModel,
} from '@ora/adapters';
import type { CatalogModel } from '@ora/adapters';
import { formatKst, parseTranscript, planResume, runSession, scrubValue } from '@ora/core';
import type {
  ApprovalPort,
  Clock,
  InstructionFile,
  ModelChainEntry,
  ModelPort,
  ModelRouter,
  PromptFile,
  QuestionPort,
  ResumeInput,
  RunOutcome,
  UserTodoAction,
  WorkspacePort,
} from '@ora/core';
import { createFileMemory } from '@ora/memory';
import type {
  ApprovalDecision,
  LaunchCommand,
  OraEvent,
  QuestionAnswer,
  SessionRecord,
  WorkerMessage,
} from '@ora/protocol';
import { createPermissionsStore, PERMISSIONS_FILE } from './permissions-store.ts';
import { createRestrictedFolders } from './restricted-folders.ts';
import { createSessionStorage, readSessionRecord, readTranscriptText } from '@ora/store';
import { createBuiltinTools, createCommandRunner, createMcpManager } from '@ora/tools';
import {
  ENGINE_VERSION,
  UsageError,
  loadConfig,
  resolveChains,
  resolveSessionsDir,
  resolveSkillsDir,
} from './config.ts';
import type { Config } from './config.ts';
import { createChildEnv, resolveIsolationRoot } from './isolation/child-env.ts';
import { findHarnessFiles, listSearchDirs } from './isolation/harness-files.ts';
import { resolveOraHome } from './isolation/ora-home.ts';
import { mergeSkills, readAllSkills } from './isolation/skill-files.ts';
import { SHELL_PIDS_FILE } from './recovery.ts';
import { SESSION_ENV } from './processes.ts';
import { findBaseRef } from './worktrees.ts';
import { createFileTracker } from './file-history.ts';

/** 번들한 앱은 소스 위치와 폴더 구조가 달라 `ORA_PROMPTS_DIR`로 프롬프트 폴더를 알려 준다. */
const PROMPTS_DIR =
  process.env.ORA_PROMPTS_DIR ?? fileURLToPath(new URL('../../../prompts/', import.meta.url));
const INSTRUCTION_NAMES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md'];

export function findGitRoot(start: string): string | undefined {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

const SKIPPED_SCOPE_DIRECTORIES = ['.git', 'node_modules'];

/** 쓰기 범위가 디렉터리면 안의 파일을 재귀로 펼친다. 모델이 파일을 하나씩 나열하지 않아도 되는 쪽이 단순하다. */
async function expandScope(root: string, path: string): Promise<string[]> {
  const info = await stat(resolve(root, path)).catch(() => undefined);
  if (!info?.isDirectory()) return [path];
  const names = (await readdir(resolve(root, path)))
    .filter((name) => !SKIPPED_SCOPE_DIRECTORIES.includes(name))
    .sort();
  return (await Promise.all(names.map((name) => expandScope(root, join(path, name))))).flat();
}

async function stamps(paths: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    paths.map(async (path) => {
      const info = await stat(path).catch(() => undefined);
      if (info?.isFile()) out[path] = `${info.size}:${info.mtimeMs}`;
    }),
  );
  return out;
}

function createWorkspace(
  cwd: string,
  gitRoot: string | undefined,
  maxFileBytes: number,
): WorkspacePort {
  const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
  return {
    async readPromptFiles(): Promise<PromptFile[]> {
      const names = (await readdir(PROMPTS_DIR)).filter((name) => name.endsWith('.md')).sort();
      return Promise.all(
        names.map(async (name) => ({
          name,
          content: await readFile(join(PROMPTS_DIR, name), 'utf8'),
        })),
      );
    },
    findHarnessFiles: () => Promise.resolve(findHarnessFiles(cwd, gitRoot)),
    async readInstructionFiles(): Promise<InstructionFile[]> {
      const searched = listSearchDirs(cwd, gitRoot);
      const seen = new Set<string>();
      const files: InstructionFile[] = [];
      for (const dir of searched) {
        for (const name of INSTRUCTION_NAMES) {
          const path = join(dir, name);
          if (!existsSync(path)) continue;
          const real = realpathSync(path);
          if (seen.has(real)) continue;
          seen.add(real);
          const bytes = await readFile(real);
          const cut = bytes.length > maxFileBytes;
          const content =
            bytes.subarray(0, maxFileBytes).toString('utf8') + (cut ? '\n[잘림]' : '');
          files.push({
            path: relative(gitRoot ?? cwd, path) || name,
            content,
            sha256: sha256(bytes),
          });
        }
      }
      return files;
    },
    hashText: (text) => Promise.resolve(sha256(text)),
    async hashFiles(paths) {
      const hash = createHash('sha256');
      const files = (await Promise.all(paths.map((path) => expandScope(cwd, path)))).flat().sort();
      for (const path of files) {
        const content = await readFile(resolve(cwd, path)).catch(() => undefined);
        hash.update(`${path}\0${content === undefined ? 'missing' : sha256(content)}\0`);
      }
      return `sha256:${hash.digest('hex')}`;
    },
    async listScopeFiles(paths) {
      const files = (await Promise.all(paths.map((path) => expandScope(cwd, path)))).flat();
      return [...new Set(files.map((path) => resolve(cwd, path)))].sort();
    },
    async snapshotFiles() {
      const files = await expandScope(cwd, '.');
      return stamps(files.map((path) => resolve(cwd, path)));
    },
    statFiles: (paths) => stamps(paths),
    readText: (path) => readFile(path, 'utf8').catch(() => undefined),
  };
}

/** 승인 요청과 질문을 호스트로 올리는 IPC 포트다. 응답은 호스트가 보낸 `resolveApproval`·`answerQuestion` 명령으로 온다. */
export function createIpcPorts(send: (message: WorkerMessage) => void) {
  const pendingApprovals = new Map<string, (decision: ApprovalDecision) => void>();
  const pendingQuestions = new Map<string, (answers: QuestionAnswer[]) => void>();
  const approval: ApprovalPort = {
    request: (request, signal) =>
      new Promise((resolve) => {
        if (signal.aborted) {
          resolve({ outcome: 'denied' });
          return;
        }
        const requestId = randomUUID();
        const settle = (decision: ApprovalDecision) => {
          pendingApprovals.delete(requestId);
          resolve(decision);
        };
        pendingApprovals.set(requestId, settle);
        signal.addEventListener('abort', () => {
          if (!pendingApprovals.has(requestId)) return;
          settle({ outcome: 'denied' });
          send({ type: 'request_withdrawn', requestId });
        });
        send({ type: 'approval_request', requestId, request });
      }),
  };
  const questions: QuestionPort = {
    ask: (request, signal) =>
      new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error('질문하기 전에 이미 중단했습니다.'));
          return;
        }
        const requestId = randomUUID();
        pendingQuestions.set(requestId, (answers) => {
          pendingQuestions.delete(requestId);
          resolve(answers);
        });
        signal.addEventListener('abort', () => {
          if (!pendingQuestions.delete(requestId)) return;
          reject(new Error('질문에 답하기 전에 중단했습니다.'));
          send({ type: 'request_withdrawn', requestId });
        });
        send({ type: 'question_request', requestId, request });
      }),
  };
  return {
    approval,
    questions,
    resolveApproval: (requestId: string, decision: ApprovalDecision) => {
      pendingApprovals.get(requestId)?.(decision);
    },
    answerQuestion: (requestId: string, answers: QuestionAnswer[]) => {
      pendingQuestions.get(requestId)?.(answers);
    },
  };
}

export interface ModelRouterOptions {
  readonly command: LaunchCommand;
  readonly config: Config;
  readonly chains: Record<string, ModelChainEntry[]>;
  readonly env: NodeJS.ProcessEnv;
  readonly oraHome: string;
  readonly pin: SessionRecord['accountPin'];
}

/** 가짜 모델 스크립트에 체인이 없을 때 쓰는 항목이다. */
const SCRIPTED_ENTRY: ModelChainEntry = {
  provider: 'fake',
  model: 'fake/scripted',
  source: 'config',
};

/** 역할의 체인을 내주고, 체인 항목으로 모델을 만든다. 같은 항목은 한 번만 만든다. `--model-script`가 있으면 모든 항목이 같은 스크립트를 재생한다. */
export function createModelRouter(options: ModelRouterOptions): ModelRouter {
  const { command, config, chains } = options;
  const catalog = createCatalog(config.models);
  const opened = new Map<string, Promise<ModelPort>>();
  let script: Promise<ModelPort> | undefined;
  const create = async (entry: ModelChainEntry): Promise<ModelPort> => {
    if (command.modelScriptPath !== undefined) {
      const path = command.modelScriptPath;
      script ??= loadScriptedModel(path, command.modelInputLogPath).catch((error: unknown) => {
        throw new UsageError(`가짜 모델 스크립트를 읽을 수 없습니다: ${String(error)}`);
      });
      return { ...(await script), model: entry.model };
    }
    if (entry.provider === 'claude') {
      return createFetchProviderModel({
        entry,
        settings: config.providers.claude,
        defaults: { wire: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' },
        loginHint: 'ora login claude를 실행합니다.',
        ...options,
      });
    }
    const codex = entry.provider === 'codex';
    return createFetchProviderModel({
      entry,
      settings: config.providers[codex ? 'codex' : 'grok'],
      defaults: codex
        ? { wire: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api' }
        : { wire: 'openai-responses', baseUrl: 'https://api.x.ai/v1' },
      loginHint: `ora login ${entry.provider}를 실행합니다.`,
      ...options,
    });
  };
  return {
    fallback: config.fallback,
    chain: (role) => {
      const own = chains[role];
      const list = own !== undefined && own.length > 0 ? own : (chains.default ?? []);
      return list.length > 0 ? list : [SCRIPTED_ENTRY];
    },
    open: (entry) => {
      const key = `${entry.provider}/${entry.model}:${entry.effort ?? ''}`;
      let port = opened.get(key);
      if (port === undefined) {
        port = create(entry).then((made) => {
          const contextWindow = made.contextWindow ?? catalog(entry.model)?.contextWindow;
          return contextWindow === undefined ? made : { ...made, contextWindow };
        });
        opened.set(key, port);
      }
      return port;
    },
  };
}

interface FetchProviderModelOptions extends ModelRouterOptions {
  readonly entry: ModelChainEntry;
  readonly settings: {
    readonly account?: string;
    readonly maxTokens: number;
    readonly cacheTtl?: '5m' | '1h';
  };
  /** 카탈로그에 없는 모델 id가 쓰는 전송 형식과 주소다. */
  readonly defaults: Pick<CatalogModel, 'wire' | 'baseUrl'>;
  readonly loginHint: string;
}

/** 로그인한 계정으로 직접 호출하는 모델을 만든다. 로그인한 계정이 없으면 세션을 시작하지 않는다. */
async function createFetchProviderModel(options: FetchProviderModelOptions): Promise<ModelPort> {
  const { entry, settings, config } = options;
  const provider = entry.provider;
  const known = createCatalog(config.models)(entry.model);
  const store = createAccountStore({ path: join(options.oraHome, AUTH_FILE), env: options.env });
  const accounts = await store.list(provider);
  if (
    settings.account === undefined
      ? accounts.length === 0
      : !accounts.some((a) => a.name === settings.account)
  ) {
    throw new UsageError(
      settings.account === undefined
        ? `로그인한 ${provider} 계정이 없습니다. ${options.loginHint}`
        : `${provider} 계정을 찾을 수 없습니다: ${settings.account}. ora accounts로 확인합니다.`,
    );
  }
  const catalog: CatalogModel = {
    id: entry.model,
    provider,
    ...options.defaults,
    contextWindow: 200_000,
    maxOutputTokens: settings.maxTokens,
    cacheTtl: '1h',
    ...known,
    ...(settings.cacheTtl === undefined ? {} : { cacheTtl: settings.cacheTtl }),
  };
  return createFetchModel({
    catalog,
    store,
    ...(settings.account === undefined ? {} : { account: settings.account }),
    policies: config.accountPolicies.filter((policy) => policy.provider === provider),
    reservePct: config.retry.usageReservePct,
    ...(options.pin === undefined ? {} : { pin: options.pin }),
    wireOptions: {
      maxTokens: Math.min(settings.maxTokens, catalog.maxOutputTokens),
      ...(entry.effort === undefined ? {} : { effort: entry.effort }),
    },
  });
}

const AUTH_FILE = 'auth.json';

const systemClock: Clock = { now: () => new Date() };

export interface ExecuteHooks {
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly softStop: AbortSignal;
  readonly onEvent: (event: OraEvent) => void;
  readonly approval?: ApprovalPort;
  readonly questions?: QuestionPort;
  /** 사용자가 보낸 포기·포기 취소를 엔진이 스텝이 끝날 때 꺼내 가는 대기열이다. */
  readonly userTodoActions?: { drain(): readonly UserTodoAction[] };
}

/** 워커 프로세스 안에서 세션 하나를 끝까지 실행한다. 재개는 호스트가 transcript를 봉인한 뒤에 부른다. */
export async function executeSession(
  command: LaunchCommand,
  hooks: ExecuteHooks,
): Promise<RunOutcome> {
  const oraHome = resolveOraHome(hooks.env);
  const config = await loadConfig(command.configPath, oraHome);
  const gitRoot = findGitRoot(command.cwd);
  const baseRef = gitRoot === undefined ? undefined : await findBaseRef(oraHome, gitRoot);
  const sessionDir = join(resolveSessionsDir(config, oraHome), command.sessionId);
  const memoryDir = config.paths.memory ?? join(oraHome, 'memory');

  if (!(await stat(command.cwd)).isDirectory())
    throw new UsageError('작업 폴더가 디렉터리가 아닙니다.');

  let resume: ResumeInput | undefined;
  if (command.type === 'resumeSession') {
    const text = await readTranscriptText(sessionDir);
    const session = await readSessionRecord(sessionDir);
    if (text === undefined || session === undefined) {
      throw new UsageError(`세션 기록을 읽을 수 없습니다: ${command.sessionId}`);
    }
    const events = parseTranscript(text).events;
    const plan = planResume(events, (path) => {
      if (!/^compactions\/\d+\.md$/.test(path)) return undefined;
      try {
        return readFileSync(join(sessionDir, path), 'utf8');
      } catch {
        return undefined;
      }
    });
    resume = {
      plan,
      session,
      ...(command.steer === undefined ? {} : { steer: command.steer }),
    };
  }
  const isolation = command.isolation ?? resume?.session.isolation ?? config.isolation;
  if (resume !== undefined && isolation !== resume.session.isolation) {
    process.stderr.write(
      `--isolation ${isolation}이 세션 기록의 ${resume.session.isolation}을 대체합니다. 새 값을 session.json에 기록합니다.\n`,
    );
  }
  let userModel = command.type === 'createSession' ? command.model : undefined;
  // 재개하는 세션은 만들 때 사용자가 고른 모델을 기록에서 되살린다.
  const chosen = resume?.session.models.find(
    (used) => used.role === 'default' && used.source === 'user',
  );
  if (chosen !== undefined) {
    userModel = `${chosen.provider}/${chosen.model}${chosen.effort === undefined ? '' : `:${chosen.effort}`}`;
  }
  const chains = resolveChains(config, {
    scripted: command.modelScriptPath !== undefined,
    ...(userModel === undefined ? {} : { userModel }),
  });
  const models = createModelRouter({
    command,
    config,
    chains,
    env: hooks.env,
    oraHome,
    pin: resume?.session.accountPin,
  });
  // 첫 모델은 세션을 시작하기 전에 만들어 계정이나 설정이 틀리면 사용 오류로 멈춘다. 나머지 체인은 필요할 때 만든다.
  const [firstModel] = models.chain('default');
  if (firstModel === undefined) throw new UsageError('default 체인에 모델이 없습니다.');
  await models.open(firstModel);

  const storage = await createSessionStorage(sessionDir);
  // 워커가 죽으면 호스트가 이 파일의 셸 그룹을 종료한다. 셸은 워커와 다른 프로세스 그룹이라 워커 그룹 종료로는 닿지 않는다.
  const shellPids = new Set<number>();
  const writeShellPids = () => {
    writeFileSync(join(sessionDir, SHELL_PIDS_FILE), [...shellPids].join('\n'));
  };
  const runner = createCommandRunner({
    env: {
      ...createChildEnv({
        isolation,
        parentEnv: hooks.env,
        isolationRoot: resolveIsolationRoot(config.paths.isolationRoot, oraHome),
      }),
      [SESSION_ENV]: '1',
    },
    onSpawn: (pid) => {
      shellPids.add(pid);
      writeShellPids();
    },
    onClose: (pid) => {
      shellPids.delete(pid);
      writeShellPids();
    },
  });
  let lastSeq = resume?.plan.lastSeq ?? 0;
  const tracker =
    gitRoot === undefined
      ? undefined
      : createFileTracker({
          sessionDir,
          gitRoot,
          currentSeq: () => lastSeq,
          now: () => formatKst(new Date()),
        });
  const trackedRunner = tracker === undefined ? runner : tracker.wrapRunner(runner);
  const mcp = createMcpManager({
    env: hooks.env,
    connectTimeoutMs: config.mcp.connectTimeoutMs,
    callTimeoutMs: config.tools.shellTimeoutMs,
    maxOutputBytes: config.tools.maxOutputBytes,
    now: () => formatKst(new Date()),
  });
  await mcp.configure(config.mcpServers);
  const outcome = await runSession(
    {
      models,
      mcpNotices: mcp,
      tools: [
        ...createBuiltinTools({
          runner: trackedRunner,
          shellTimeoutMs: config.tools.shellTimeoutMs,
          maxOutputBytes: config.tools.maxOutputBytes,
          maxFileBytes: config.tools.maxFileBytes,
          secretPaths: [join(oraHome, AUTH_FILE)],
          sessionDir,
          onBeforeWrite: async (path, before) => {
            await storage.recordBaseline(path, before);
            await tracker?.beforeWrite(path, before);
          },
          onAfterWrite: async (path, after) => {
            await tracker?.afterWrite(path, after);
          },
          protectedPaths: [
            join(oraHome, PERMISSIONS_FILE),
            join(oraHome, 'engine.config.json'),
            join(oraHome, 'vault'),
            resolveSessionsDir(config, oraHome),
            memoryDir,
            ...(command.configPath === undefined ? [] : [resolve(command.configPath)]),
          ],
        }),
        ...mcp.tools(),
      ],
      runner: trackedRunner,
      sink: {
        async append(event) {
          await storage.transcript.append(event);
          lastSeq = event.seq;
          hooks.onEvent(event);
        },
      },
      store: storage.sessions,
      workspace: createWorkspace(command.cwd, gitRoot, config.tools.maxFileBytes),
      skills: {
        list: async () =>
          mergeSkills(
            await readAllSkills({
              projectDir: join(command.cwd, '.ora', 'skills'),
              globalDir: resolveSkillsDir(config, oraHome),
            }),
          ),
      },
      memory: createFileMemory({
        memoryDir,
        projectId: config.projectId ?? (gitRoot ?? command.cwd).split('/').pop() ?? 'project',
        clock: systemClock,
      }),
      clock: systemClock,
      alwaysApprovals: createPermissionsStore(join(oraHome, PERMISSIONS_FILE)),
      restrictedFolders: createRestrictedFolders(config.permissions.restrictedFolders),
      ...(hooks.approval === undefined ? {} : { approval: hooks.approval }),
      ...(hooks.questions === undefined ? {} : { questions: hooks.questions }),
    },
    {
      sessionId: command.sessionId,
      task: resume?.plan.task ?? (command.type === 'createSession' ? command.task : ''),
      cwd: command.cwd,
      ...(gitRoot === undefined ? {} : { repo: gitRoot }),
      ...(baseRef === undefined ? {} : { baseRef }),
      settings: {
        permissionMode:
          resume?.session.permissionMode ??
          (command.type === 'createSession' ? command.permissionMode : undefined) ??
          config.permissions.mode,
        toolPolicies: config.permissions.tools,
        isolation,
        engineVersion: ENGINE_VERSION,
        maxSteps: config.limits.maxSteps,
        maxRepairsPerTodo: config.limits.maxRepairsPerTodo,
        noProgressSteps: config.limits.noProgressSteps,
        shellTimeoutMs: config.tools.shellTimeoutMs,
        recallTokenBudget: config.recall.tokenBudget,
        reviewEnabled: config.verify.review,
        compactAtRatio: config.context.compactAtRatio,
        keepRecentTokens: config.context.keepRecentTokens,
        protectToolTokens: config.context.protectToolTokens,
        minPruneSavings: config.context.minPruneSavings,
        methodOrder: config.context.methodOrder,
        idleEnabled: config.context.idleEnabled,
        idleThresholdTokens: config.context.idleThresholdTokens,
        idleTimeoutSeconds: config.context.idleTimeoutSeconds,
        ...(config.session.maxCost === null ? {} : { maxCost: config.session.maxCost }),
        ...(config.session.warnCost === null ? {} : { warnCost: config.session.warnCost }),
        pricing: config.pricing,
      },
      configSummary: {
        limits: config.limits,
        tools: config.tools,
        permissionTools: config.permissions.tools,
      },
      signal: hooks.signal,
      softStop: hooks.softStop,
      ...(resume === undefined ? {} : { resume }),
      ...(hooks.userTodoActions === undefined ? {} : { userTodoActions: hooks.userTodoActions }),
    },
  ).finally(() => mcp.close());
  return { ...outcome, todos: scrubValue(outcome.todos) };
}
