import { createHash, randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScriptedModel } from '@ora/adapters';
import { formatKst, runSession, scrubValue } from '@ora/core';
import type { Clock, IdGenerator, InstructionFile, PromptFile, WorkspacePort } from '@ora/core';
import { createFileMemory } from '@ora/memory';
import { isolationSchema, permissionModeSchema } from '@ora/protocol';
import type { EndReason, OraEvent, PermissionMode, SessionStatus, Todo } from '@ora/protocol';
import { createSessionStorage } from '@ora/store';
import { createBuiltinTools, createCommandRunner } from '@ora/tools';
import { z } from 'zod';
import { resolveOraHome } from './isolation/ora-home.ts';

const ENGINE_VERSION = '0.0.0';
const PROMPTS_DIR = fileURLToPath(new URL('../../../prompts/', import.meta.url));
const INSTRUCTION_NAMES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md'];

export class UsageError extends Error {}

const configSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  projectId: z.string().nullable().default(null),
  paths: z
    .object({
      sessions: z.string().nullable().default(null),
      memory: z.string().nullable().default(null),
    })
    .default({ sessions: null, memory: null }),
  permissions: z
    .object({
      mode: permissionModeSchema.default('yolo'),
      tools: z.record(z.string(), z.enum(['allow', 'prompt', 'deny'])).default({}),
    })
    .default({ mode: 'yolo', tools: {} }),
  isolation: isolationSchema.default('harness'),
  limits: z
    .object({
      maxSteps: z.number().int().positive().default(50),
      maxRepairsPerTodo: z.number().int().nonnegative().default(3),
    })
    .default({ maxSteps: 50, maxRepairsPerTodo: 3 }),
  tools: z
    .object({
      shellTimeoutMs: z.number().int().positive().default(120000),
      maxOutputBytes: z.number().int().positive().default(30000),
      maxFileBytes: z.number().int().positive().default(1048576),
    })
    .default({ shellTimeoutMs: 120000, maxOutputBytes: 30000, maxFileBytes: 1048576 }),
  recall: z
    .object({ tokenBudget: z.number().int().nonnegative().default(2000) })
    .default({ tokenBudget: 2000 }),
});
type Config = z.infer<typeof configSchema>;

async function loadConfig(configPath: string | undefined, oraHome: string): Promise<Config> {
  const path = configPath ?? join(oraHome, 'engine.config.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    if (configPath !== undefined)
      throw new UsageError(`설정 파일을 읽을 수 없습니다: ${configPath}`);
    // 설정 파일이 없으면 fail-closed로 always-ask에서 시작한다 (SPEC 5.1절).
    return configSchema.parse({ permissions: { mode: 'always-ask' } });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new UsageError(`설정 파일이 JSON이 아닙니다: ${path}: ${String(error)}`);
  }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success)
    throw new UsageError(`설정 파일 형식이 틀립니다: ${path}\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

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
    async readInstructionFiles(): Promise<InstructionFile[]> {
      const dirs: string[] = [];
      for (let dir = cwd; ; dir = dirname(dir)) {
        dirs.unshift(dir);
        if (dir === gitRoot || dirname(dir) === dir) break;
      }
      const searched = gitRoot === undefined ? [cwd] : dirs;
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

const systemClock: Clock = { now: () => new Date() };

const idGenerator: IdGenerator = (() => {
  let calls = 0;
  return {
    createSessionId: () =>
      `s-${formatKst(new Date()).slice(0, 10).replaceAll('-', '')}-${randomBytes(6)
        .toString('base64url')
        .replace(/[^A-Za-z0-9]/g, 'x')
        .slice(0, 6)}`,
    createCallId: () => `call-${String((calls += 1)).padStart(4, '0')}`,
  };
})();

export interface RunTaskOptions {
  readonly task: string;
  readonly cwd: string;
  readonly modelScriptPath: string;
  readonly configPath?: string;
  readonly permissionMode?: PermissionMode;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly modelInputLogPath?: string;
  readonly onEvent?: (event: OraEvent) => void;
}

export interface RunTaskResult {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly status: SessionStatus;
  readonly endReason: EndReason;
  readonly summary: string;
  readonly todos: readonly Todo[];
}

/** 세션 하나를 호스트 프로세스 안에서 끝까지 실행한다. */
export async function runTask(options: RunTaskOptions): Promise<RunTaskResult> {
  const oraHome = resolveOraHome(options.env);
  const config = await loadConfig(options.configPath, oraHome);
  const permissionMode = options.permissionMode ?? config.permissions.mode;
  const gitRoot = findGitRoot(options.cwd);
  const sessionId = idGenerator.createSessionId();
  const sessionDir = join(config.paths.sessions ?? join(oraHome, 'sessions'), sessionId);
  const memoryDir = config.paths.memory ?? join(oraHome, 'memory');

  let model;
  try {
    model = await loadScriptedModel(options.modelScriptPath, options.modelInputLogPath);
  } catch (error) {
    throw new UsageError(`가짜 모델 스크립트를 읽을 수 없습니다: ${String(error)}`);
  }
  if (!(await stat(options.cwd)).isDirectory())
    throw new UsageError('작업 폴더가 디렉터리가 아닙니다.');

  const storage = await createSessionStorage(sessionDir);
  const outcome = await runSession(
    {
      model,
      tools: createBuiltinTools({
        runner: createCommandRunner(),
        shellTimeoutMs: config.tools.shellTimeoutMs,
        maxOutputBytes: config.tools.maxOutputBytes,
        maxFileBytes: config.tools.maxFileBytes,
      }),
      runner: createCommandRunner(),
      sink: {
        async append(event) {
          await storage.transcript.append(event);
          options.onEvent?.(event);
        },
      },
      store: storage.sessions,
      workspace: createWorkspace(options.cwd, gitRoot, config.tools.maxFileBytes),
      memory: createFileMemory({
        memoryDir,
        projectId: config.projectId ?? (gitRoot ?? options.cwd).split('/').pop() ?? 'project',
        clock: systemClock,
      }),
      clock: systemClock,
    },
    {
      sessionId,
      task: options.task,
      cwd: options.cwd,
      ...(gitRoot === undefined ? {} : { repo: gitRoot }),
      settings: {
        permissionMode,
        toolPolicies: config.permissions.tools,
        isolation: config.isolation,
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
      signal: options.signal,
    },
  );
  return { sessionId, sessionDir, ...outcome, todos: scrubValue(outcome.todos) };
}
