import { createHash } from 'node:crypto';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScriptedModel } from '@ora/adapters';
import { parseTranscript, planResume, runSession, scrubValue } from '@ora/core';
import type {
  Clock,
  InstructionFile,
  PromptFile,
  ResumeInput,
  RunOutcome,
  WorkspacePort,
} from '@ora/core';
import { createFileMemory } from '@ora/memory';
import type { LaunchCommand, OraEvent } from '@ora/protocol';
import { createSessionStorage, readSessionRecord, readTranscriptText } from '@ora/store';
import { createBuiltinTools, createCommandRunner } from '@ora/tools';
import { ENGINE_VERSION, UsageError, loadConfig, resolveSessionsDir } from './config.ts';
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

export interface ExecuteHooks {
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly softStop: AbortSignal;
  readonly onEvent: (event: OraEvent) => void;
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

  let model;
  try {
    model = await loadScriptedModel(command.modelScriptPath, command.modelInputLogPath);
  } catch (error) {
    throw new UsageError(`가짜 모델 스크립트를 읽을 수 없습니다: ${String(error)}`);
  }
  if (!(await stat(command.cwd)).isDirectory())
    throw new UsageError('작업 폴더가 디렉터리가 아닙니다.');

  let resume: ResumeInput | undefined;
  if (command.type === 'resumeSession') {
    const text = await readTranscriptText(sessionDir);
    const session = await readSessionRecord(sessionDir);
    if (text === undefined || session === undefined) {
      throw new UsageError(`세션 기록을 읽을 수 없습니다: ${command.sessionId}`);
    }
    resume = {
      plan: planResume(parseTranscript(text).events),
      session,
      ...(command.steer === undefined ? {} : { steer: command.steer }),
    };
  }

  const storage = await createSessionStorage(sessionDir);
  // 워커가 죽으면 호스트가 이 파일의 셸 그룹을 종료한다. 셸은 워커와 다른 프로세스 그룹이라 워커 그룹 종료로는 닿지 않는다.
  const shellPids = new Set<number>();
  const writeShellPids = () => {
    writeFileSync(join(sessionDir, SHELL_PIDS_FILE), [...shellPids].join('\n'));
  };
  const runner = createCommandRunner({
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
        isolation: resume?.session.isolation ?? config.isolation,
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
