import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claudeResumeStateSchema,
  createAnthropicModel,
  createClaudeCliModel,
  createClaudeSdkModel,
  loadScriptedModel,
} from '@ora/adapters';
import type { ClaudeResumeState } from '@ora/adapters';
import { parseTranscript, planResume, ruleKey, runSession, scrubValue } from '@ora/core';
import type {
  AlwaysApprovalPort,
  ApprovalPort,
  Clock,
  InstructionFile,
  ModelPort,
  PromptFile,
  QuestionPort,
  ResumeInput,
  RunOutcome,
  WorkspacePort,
} from '@ora/core';
import { createFileMemory } from '@ora/memory';
import type {
  ApprovalDecision,
  Isolation,
  LaunchCommand,
  OraEvent,
  PermissionsFile,
  QuestionAnswer,
  WorkerMessage,
} from '@ora/protocol';
import { permissionsFileSchema } from '@ora/protocol';
import { createSessionStorage, readSessionRecord, readTranscriptText } from '@ora/store';
import { createBuiltinTools, createCommandRunner } from '@ora/tools';
import {
  ENGINE_VERSION,
  UsageError,
  loadConfig,
  resolveSessionsDir,
  selectProvider,
} from './config.ts';
import type { Config } from './config.ts';
import { createChildEnv, resolveIsolationRoot } from './isolation/child-env.ts';
import { findHarnessFiles, listSearchDirs } from './isolation/harness-files.ts';
import { resolveOraHome } from './isolation/ora-home.ts';
import { SHELL_PIDS_FILE } from './recovery.ts';

const PROMPTS_DIR = fileURLToPath(new URL('../../../prompts/', import.meta.url));
const INSTRUCTION_NAMES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md'];

function findGitRoot(start: string): string | undefined {
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

/** `--model-script`가 있으면 가짜 모델을, 없으면 설정이 고른 프로바이더의 모델을 만든다. */
async function createModel(
  command: LaunchCommand,
  config: Config,
  env: NodeJS.ProcessEnv,
  claudeResume: ClaudeResumeState | undefined,
  isolation: Isolation,
): Promise<ModelPort> {
  if (command.modelScriptPath !== undefined) {
    try {
      return await loadScriptedModel(command.modelScriptPath, command.modelInputLogPath);
    } catch (error) {
      throw new UsageError(`가짜 모델 스크립트를 읽을 수 없습니다: ${String(error)}`);
    }
  }
  const { claude, anthropic } = config.providers;
  const selected = selectProvider(config);
  if (selected === 'claude' && claude.model !== undefined) {
    const createClaudeModel = claude.via === 'cli' ? createClaudeCliModel : createClaudeSdkModel;
    return createClaudeModel({
      model: claude.model,
      cacheTtl: claude.cacheTtl,
      commands: claude.command,
      env,
      cwd: command.cwd,
      ...(claude.effort === undefined ? {} : { effort: claude.effort }),
      ...(claudeResume === undefined ? {} : { resumeFrom: claudeResume }),
      persistSession: isolation !== 'clean-home',
    });
  }
  if (anthropic.model === undefined) {
    throw new UsageError(
      '설정 providers.claude.model이나 providers.anthropic.model이 없습니다. 모델 이름을 설정하거나 --model-script를 줍니다.',
    );
  }
  const names = anthropic.credentialEnv;
  if (!names.some((name) => (env[name] ?? '') !== '')) {
    throw new UsageError(`API 키 환경변수가 비어 있습니다: ${names.join(', ')}`);
  }
  return createAnthropicModel({
    model: anthropic.model,
    maxTokens: anthropic.maxTokens,
    getApiKey: () => names.map((name) => env[name] ?? '').find((value) => value !== '') ?? '',
    ...(anthropic.effort === undefined ? {} : { effort: anthropic.effort }),
    ...(anthropic.baseUrl === undefined ? {} : { baseUrl: anthropic.baseUrl }),
  });
}

const PERMISSIONS_FILE = 'permissions.json';

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 3000;
// 락을 잡은 워커가 죽으면 락 파일이 남으므로 이 시간이 지난 락은 버리고 다시 잡는다.
const LOCK_STALE_MS = 10_000;

/** 락 파일을 `wx`로 만들어 잡는다. 시간 안에 잡지 못하면 예외를 던진다. */
async function withFileLock<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
  const deadline = performance.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await (await open(lockPath, 'wx')).close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const held = await stat(lockPath).catch(() => undefined);
      if (held !== undefined && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (performance.now() > deadline)
        throw new Error('permissions.json 락을 잡지 못했습니다.', { cause: error });
      await new Promise((done) => setTimeout(done, LOCK_RETRY_MS));
    }
  }
  try {
    return await action();
  } finally {
    await rm(lockPath, { force: true });
  }
}

/**
 * `<oraHome>/permissions.json`에 "항상 승인"을 저장한다 (SPEC 5.1절). 사용자가 파일을 직접 고칠 수 있으므로 읽을 때마다 파일을 다시 읽는다.
 * 읽지 못하는 파일(깨졌거나 권한 오류)은 규칙이 없는 것으로 보고 항상 묻는다. 그런 파일은 덮어쓰지 않으며, 저장에 실패하면 이유를 돌려준다.
 * 워커 여러 개가 동시에 쓸 수 있어서 읽고 고쳐 쓰는 구간을 락 파일로 직렬화한다.
 */
function createAlwaysApprovals(path: string): AlwaysApprovalPort {
  let warned = false;
  const warn = (reason: string) => {
    if (warned) return;
    warned = true;
    process.stderr.write(`경고: ${path}를 읽을 수 없어 항상 승인을 쓰지 않습니다: ${reason}\n`);
  };
  /** 파일이 없으면 빈 규칙, 읽지 못하면 이유를 돌려준다. */
  const read = async (): Promise<
    { file: PermissionsFile; error?: undefined } | { error: string }
  > => {
    try {
      const text = await readFile(path, 'utf8');
      return { file: permissionsFileSchema.parse(JSON.parse(text)) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { file: { schemaVersion: 1, rules: [] } };
      }
      const reason = error instanceof Error ? error.message : String(error);
      warn(reason);
      return { error: reason };
    }
  };
  return {
    async has(rule) {
      const key = ruleKey(rule);
      const result = await read();
      return (
        result.error === undefined && result.file.rules.some((entry) => ruleKey(entry) === key)
      );
    },
    async add(rule) {
      const temporary = `${path}.${process.pid}.tmp`;
      try {
        return await withFileLock(`${path}.lock`, async () => {
          const result = await read();
          if (result.error !== undefined) {
            return {
              saved: false as const,
              reason: `permissions.json을 읽을 수 없습니다: ${result.error}`,
            };
          }
          const key = ruleKey(rule);
          if (result.file.rules.some((entry) => ruleKey(entry) === key))
            return { saved: true as const };
          const body = `${JSON.stringify({ ...result.file, rules: [...result.file.rules, rule] }, null, 2)}\n`;
          const handle = await open(temporary, 'w');
          try {
            await handle.writeFile(body);
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(temporary, path);
          return { saved: true as const };
        });
      } catch (error) {
        await rm(temporary, { force: true });
        return { saved: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

const systemClock: Clock = { now: () => new Date() };

export interface ExecuteHooks {
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly softStop: AbortSignal;
  readonly onEvent: (event: OraEvent) => void;
  readonly approval?: ApprovalPort;
  readonly questions?: QuestionPort;
}

/** 워커 프로세스 안에서 세션 하나를 끝까지 실행한다. 재개는 호스트가 transcript를 봉인한 뒤에 부른다. */
export async function executeSession(
  command: LaunchCommand,
  hooks: ExecuteHooks,
): Promise<RunOutcome> {
  const oraHome = resolveOraHome(hooks.env);
  const config = await loadConfig(command.configPath, oraHome);
  const gitRoot = findGitRoot(command.cwd);
  const sessionDir = join(resolveSessionsDir(config, oraHome), command.sessionId);
  const memoryDir = config.paths.memory ?? join(oraHome, 'memory');

  if (!(await stat(command.cwd)).isDirectory())
    throw new UsageError('작업 폴더가 디렉터리가 아닙니다.');

  let resume: ResumeInput | undefined;
  let claudeResume: ClaudeResumeState | undefined;
  if (command.type === 'resumeSession') {
    const text = await readTranscriptText(sessionDir);
    const session = await readSessionRecord(sessionDir);
    if (text === undefined || session === undefined) {
      throw new UsageError(`세션 기록을 읽을 수 없습니다: ${command.sessionId}`);
    }
    const events = parseTranscript(text).events;
    const plan = planResume(events);
    resume = {
      plan,
      session,
      ...(command.steer === undefined ? {} : { steer: command.steer }),
    };
    // 하드 킬 뒤에는 Claude 세션이 기록과 어긋났을 수 있어서 `--resume`을 쓰지 않고 기록을 다시 넣는다.
    if (!plan.hardKilled) {
      claudeResume = events
        .toReversed()
        .flatMap((event) =>
          event.type === 'message'
            ? [claudeResumeStateSchema.safeParse(event.payload.providerMetadata)]
            : [],
        )
        .find((parsed) => parsed.success)?.data;
    }
  }
  const isolation = command.isolation ?? resume?.session.isolation ?? config.isolation;
  if (resume !== undefined && isolation !== resume.session.isolation) {
    process.stderr.write(
      `--isolation ${isolation}이 세션 기록의 ${resume.session.isolation}을 대체합니다. 새 값을 session.json에 기록합니다.\n`,
    );
  }
  // clean-home에서는 Claude Code 세션을 남기지 않고 기록 재주입으로만 재개한다.
  const model = await createModel(command, config, hooks.env, claudeResume, isolation);

  const storage = await createSessionStorage(sessionDir);
  // 워커가 죽으면 호스트가 이 파일의 셸 그룹을 종료한다. 셸은 워커와 다른 프로세스 그룹이라 워커 그룹 종료로는 닿지 않는다.
  const shellPids = new Set<number>();
  const writeShellPids = () => {
    writeFileSync(join(sessionDir, SHELL_PIDS_FILE), [...shellPids].join('\n'));
  };
  const runner = createCommandRunner({
    env: createChildEnv({
      isolation,
      parentEnv: hooks.env,
      isolationRoot: resolveIsolationRoot(config.paths.isolationRoot, oraHome),
    }),
    onSpawn: (pid) => {
      shellPids.add(pid);
      writeShellPids();
    },
    onClose: (pid) => {
      shellPids.delete(pid);
      writeShellPids();
    },
  });
  const outcome = await runSession(
    {
      model,
      tools: createBuiltinTools({
        runner,
        shellTimeoutMs: config.tools.shellTimeoutMs,
        maxOutputBytes: config.tools.maxOutputBytes,
        maxFileBytes: config.tools.maxFileBytes,
        protectedPaths: [
          join(oraHome, PERMISSIONS_FILE),
          join(oraHome, 'engine.config.json'),
          join(oraHome, 'vault'),
          resolveSessionsDir(config, oraHome),
          memoryDir,
          ...(command.configPath === undefined ? [] : [resolve(command.configPath)]),
        ],
      }),
      runner,
      sink: {
        async append(event) {
          await storage.transcript.append(event);
          hooks.onEvent(event);
        },
      },
      store: storage.sessions,
      workspace: createWorkspace(command.cwd, gitRoot, config.tools.maxFileBytes),
      memory: createFileMemory({
        memoryDir,
        projectId: config.projectId ?? (gitRoot ?? command.cwd).split('/').pop() ?? 'project',
        clock: systemClock,
      }),
      clock: systemClock,
      alwaysApprovals: createAlwaysApprovals(join(oraHome, PERMISSIONS_FILE)),
      ...(hooks.approval === undefined ? {} : { approval: hooks.approval }),
      ...(hooks.questions === undefined ? {} : { questions: hooks.questions }),
    },
    {
      sessionId: command.sessionId,
      task: resume?.plan.task ?? (command.type === 'createSession' ? command.task : ''),
      cwd: command.cwd,
      ...(gitRoot === undefined ? {} : { repo: gitRoot }),
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
        shellTimeoutMs: config.tools.shellTimeoutMs,
        recallTokenBudget: config.recall.tokenBudget,
      },
      configSummary: {
        limits: config.limits,
        tools: config.tools,
        permissionTools: config.permissions.tools,
      },
      signal: hooks.signal,
      softStop: hooks.softStop,
      ...(resume === undefined ? {} : { resume }),
    },
  );
  return { ...outcome, todos: scrubValue(outcome.todos) };
}
