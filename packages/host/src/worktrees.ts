import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { withFileLock, writeFileAtomic } from '@ora/adapters';
import { worktreesFileSchema } from '@ora/protocol';
import type {
  CreateWorktreeBody,
  ReposSettings,
  ReposSettingsResponse,
  SetupCommand,
  Terminal,
  WorktreeOptionsResponse,
  WorktreeRecord,
  WorktreesFile,
} from '@ora/protocol';
import { UsageError, loadConfig } from './config.ts';
import { updateConfigFile } from './config-file.ts';
import { resolveOraHome } from './isolation/ora-home.ts';
import type { TerminalManager } from './terminal.ts';

const WORKTREES_FILE = 'worktrees.json';
const SERVER_STOPPED = '서버가 멈춰 끝까지 돌지 못함';
const BRANCH_PREFIX = 'ora/';
const TERMINAL_SIZE = { cols: 100, rows: 30 };

export interface WorktreeApiOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly configPath?: string;
  readonly terminals: TerminalManager;
  /** worktree의 탭 목록에 터미널 탭을 더한다. `replacedTerminalId`의 탭이 있으면 그 자리를 바꾼다. */
  readonly openTerminalTab: (
    cwd: string,
    terminalId: string,
    replacedTerminalId?: string,
  ) => Promise<void>;
  /** 서버가 아는 작업 폴더다(시작 폴더와 세션 기록의 저장소). 설정 › 저장소에 보일 저장소의 후보다. */
  readonly listKnownFolders: () => Promise<string[]>;
}

export interface WorktreeApi {
  list(): Promise<WorktreeRecord[]>;
  options(repo: string): Promise<WorktreeOptionsResponse>;
  create(body: CreateWorktreeBody): Promise<WorktreeRecord>;
  /** 실패한 명령부터 다시 돌린다. `setup-failed`가 아니면 `UsageError`다. */
  rerun(id: string): Promise<WorktreeRecord>;
  getRepos(): Promise<ReposSettingsResponse>;
  setRepos(next: ReposSettings): Promise<ReposSettingsResponse>;
  /** 삭제한 worktree 폴더의 기록을 `worktrees.json`에서 지운다. */
  forget(paths: string[]): Promise<void>;
  /** 서버를 닫기 전에 도는 초기 명령의 기록을 멈춘 상태로 남긴다. */
  close(): Promise<void>;
}

/** git 실패는 stderr 원문을 담은 오류로 돌려준다. */
function git(cwd: string, args: string[]): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile('git', ['-C', cwd, ...args], { maxBuffer: 10_000_000 }, (error, stdout, stderr) => {
    if (error === null) resolve(stdout.trim());
    else reject(new UsageError(stderr.trim() || error.message));
  });
  return promise;
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const canonical = (path: string): Promise<string> => realpath(path).catch(() => path);

/**
 * 파일에 남은 상태를 읽는다. 파일이 없으면 빈 목록이다.
 * 세션 워커도 `baseRef`를 찾으려고 같은 파일을 읽는다.
 */
async function readWorktreesFile(oraHome: string): Promise<WorktreesFile> {
  const text = await readFile(join(oraHome, WORKTREES_FILE), 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  return text === undefined
    ? { schemaVersion: 1, worktrees: [] }
    : worktreesFileSchema.parse(JSON.parse(text));
}

/** 이 폴더가 사용자가 만든 worktree 폴더이면 만든 시점의 기준 커밋 해시를 돌려준다. 아니면 `undefined`다. */
export async function findBaseRef(oraHome: string, folder: string): Promise<string | undefined> {
  const real = await canonical(folder);
  const file = await readWorktreesFile(oraHome).catch(() => undefined);
  return file?.worktrees.find((record) => record.path === real)?.baseRef;
}

export async function createWorktreeApi(options: WorktreeApiOptions): Promise<WorktreeApi> {
  const oraHome = resolveOraHome(options.env);
  const filePath = join(oraHome, WORKTREES_FILE);
  const configFile = options.configPath ?? join(oraHome, 'engine.config.json');
  const load = () => loadConfig(options.configPath, oraHome);
  let isClosing = false;

  const mutate = async <T>(change: (file: WorktreesFile) => T): Promise<T> => {
    await mkdir(oraHome, { recursive: true, mode: 0o700 });
    return withFileLock(`${filePath}.lock`, async () => {
      const file = await readWorktreesFile(oraHome);
      const result = change(file);
      await writeFileAtomic(filePath, `${JSON.stringify(file, null, 2)}\n`);
      return result;
    });
  };

  const patchRecord = (
    id: string,
    patch: (record: WorktreeRecord) => void,
  ): Promise<WorktreeRecord> =>
    mutate((file) => {
      const record = file.worktrees.find((item) => item.id === id);
      if (record === undefined) throw new UsageError(`worktree를 찾을 수 없습니다: ${id}`);
      patch(record);
      record.updatedAt = new Date().toISOString();
      return structuredClone(record);
    });

  /** 서버가 꺼져 돌지 못한 초기 명령은 멈춘 상태로 바꾼다. */
  const failInterrupted = (record: WorktreeRecord): void => {
    record.status = 'setup-failed';
    record.failure = SERVER_STOPPED;
    record.commands = record.commands.map((command) => {
      if (command.status === 'running') return { command: command.command, status: 'failed' };
      if (command.status === 'pending') return { command: command.command, status: 'skipped' };
      return command;
    });
  };

  const failAllInterrupted = async () => {
    const isBusy = (await readWorktreesFile(oraHome)).worktrees.some(
      (record) => record.status === 'creating' || record.status === 'setup',
    );
    if (!isBusy) return;
    await mutate((file) => {
      for (const record of file.worktrees) {
        if (record.status === 'creating' || record.status === 'setup') failInterrupted(record);
      }
    });
  };
  await failAllInterrupted();

  /**
   * 초기 명령을 한 터미널 탭에서 차례로 돌린다. 명령마다 로그인 셸을 `-lc`로 띄우고 그 종료 코드를 쓴다.
   * 끝나거나 실패로 멈추면 같은 탭에 쓸 수 있는 로그인 셸을 붙인다.
   */
  const runSetup = async (initial: WorktreeRecord, from: number): Promise<WorktreeRecord> => {
    const { id, path } = initial;
    const commands: SetupCommand[] = initial.commands.map((command, index) =>
      index < from
        ? command
        : { command: command.command, status: index === from ? 'running' : 'pending' },
    );
    const terminal: Terminal = options.terminals.create({
      cwd: path,
      ...TERMINAL_SIZE,
      isDeferred: true,
    });
    const record = await patchRecord(id, (item) => {
      item.status = 'setup';
      item.commands = commands;
      item.terminalId = terminal.id;
      delete item.failure;
    });
    await options.openTerminalTab(path, terminal.id, initial.terminalId).catch(() => undefined);

    const save = (change: (item: WorktreeRecord) => void) => {
      const snapshot = commands.map((command) => ({ ...command }));
      return patchRecord(id, (item) => {
        item.commands = snapshot;
        change(item);
      }).catch(() => undefined);
    };
    const runAll = async () => {
      for (let index = from; index < commands.length; index += 1) {
        const command = commands[index]?.command ?? '';
        commands[index] = { command, status: 'running' };
        await save(() => undefined);
        const exitCode = await options.terminals.runCommand(terminal.id, command);
        if (isClosing) return;
        const isTabClosed = options.terminals.get(terminal.id)?.status === 'exited';
        if (exitCode !== 0 || isTabClosed) {
          commands[index] = { command, status: 'failed', exitCode };
          for (let rest = index + 1; rest < commands.length; rest += 1) {
            commands[rest] = { command: commands[rest]?.command ?? '', status: 'skipped' };
          }
          await save((item) => {
            item.status = 'setup-failed';
            item.failure = isTabClosed
              ? `터미널이 exit ${String(exitCode)}로 끝남`
              : `${command} · exit ${String(exitCode)}`;
          });
          if (!isTabClosed) options.terminals.startShell(terminal.id);
          return;
        }
        commands[index] = { command, status: 'done' };
        await save(() => undefined);
      }
      await save((item) => {
        item.status = 'ready';
      });
      options.terminals.startShell(terminal.id);
    };
    runAll().catch(() => undefined);
    return record;
  };

  const getRepos = async (): Promise<ReposSettingsResponse> => {
    const config = await load();
    const records = (await readWorktreesFile(oraHome)).worktrees;
    const worktreePaths = new Set(records.map((item) => item.path));
    const worktreeRoot = config.paths.worktreeRoot ?? join(oraHome, 'worktrees');
    const roots = new Set<string>();
    for (const path of [
      ...config.repos.map((entry) => entry.path),
      ...records.map((item) => item.repo),
      ...(await options.listKnownFolders()),
    ]) {
      const real = await canonical(path);
      if (!worktreePaths.has(real) && (await exists(join(real, '.git')))) roots.add(real);
    }
    return {
      repos: [...roots].map((path) => ({
        path,
        name: basename(path),
        setupCommands: config.repos.find((entry) => entry.path === path)?.setupCommands ?? [],
        worktreeCount: records.filter((item) => item.repo === path).length,
        folder: join(worktreeRoot, basename(path)),
      })),
    };
  };

  const repoInfo = async (repo: string) => {
    const real = await canonical(repo);
    if (!(await exists(real))) throw new UsageError(`폴더가 없습니다: ${repo}`);
    const top = await git(real, ['rev-parse', '--show-toplevel']).catch(() => {
      throw new UsageError(`git 저장소가 아닙니다: ${repo}`);
    });
    const root = await canonical(top);
    const config = await load();
    const worktreeRoot = config.paths.worktreeRoot ?? join(oraHome, 'worktrees');
    const setupCommands = config.repos.find((entry) => entry.path === root)?.setupCommands ?? [];
    return { root, name: basename(root), worktreeRoot, setupCommands };
  };

  const listBranches = async (root: string): Promise<string[]> =>
    (await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']))
      .split('\n')
      .filter((line) => line !== '');

  return {
    async list() {
      return (await readWorktreesFile(oraHome)).worktrees;
    },
    async options(repo) {
      const info = await repoInfo(repo);
      const current = await git(info.root, ['branch', '--show-current']).catch(() => '');
      return {
        repoName: info.name,
        branches: await listBranches(info.root),
        ...(current === '' ? {} : { current }),
        folder: join(info.worktreeRoot, info.name),
        setupCommands: info.setupCommands,
      };
    },
    async create(body) {
      if (isClosing) throw new UsageError('서버를 닫는 중입니다.');
      const info = await repoInfo(body.repo);
      const branch = `${BRANCH_PREFIX}${body.name}`;
      const folder = join(info.worktreeRoot, info.name, body.name);
      const branches = await listBranches(info.root);
      const parent =
        body.parent ?? (await git(info.root, ['branch', '--show-current']).catch(() => ''));
      if (parent === '')
        throw new UsageError('부모 브랜치를 고릅니다. 지금 HEAD가 브랜치 위에 있지 않습니다.');
      if (!branches.includes(parent)) throw new UsageError(`부모 브랜치가 없습니다: ${parent}`);
      if (branches.includes(branch))
        throw new UsageError(`같은 이름의 브랜치가 이미 있습니다: ${branch}`);
      if (await exists(folder)) throw new UsageError(`같은 이름의 폴더가 이미 있습니다: ${folder}`);
      const baseRef = await git(info.root, ['rev-parse', `refs/heads/${parent}`]);
      const now = new Date().toISOString();
      const id = `w-${Array.from(randomBytes(8), (byte) => 'abcdefghijklmnopqrstuvwxyz0123456789'[byte % 36]).join('')}`;
      const record: WorktreeRecord = {
        id,
        repo: info.root,
        name: body.name,
        branch,
        path: folder,
        parent,
        baseRef,
        status: 'creating',
        createdAt: now,
        updatedAt: now,
        commands: info.setupCommands.map((command) => ({ command, status: 'pending' })),
      };
      await mutate((file) => {
        if (file.worktrees.some((item) => item.repo === info.root && item.name === body.name)) {
          throw new UsageError(`같은 이름의 worktree가 이미 있습니다: ${body.name}`);
        }
        file.worktrees.push(record);
      });
      try {
        await mkdir(join(info.worktreeRoot, info.name), { recursive: true });
        await git(info.root, ['worktree', 'add', '-b', branch, folder, parent]);
      } catch (error) {
        await mutate((file) => {
          file.worktrees = file.worktrees.filter((item) => item.id !== id);
        });
        throw error;
      }
      const real = await canonical(folder);
      const created = await patchRecord(id, (item) => {
        item.path = real;
        item.status = item.commands.length === 0 ? 'ready' : 'setup';
      });
      return created.commands.length === 0 ? created : runSetup(created, 0);
    },
    async rerun(id) {
      const record = (await readWorktreesFile(oraHome)).worktrees.find((item) => item.id === id);
      if (record === undefined) throw new UsageError(`worktree를 찾을 수 없습니다: ${id}`);
      if (record.status !== 'setup-failed') {
        throw new UsageError('초기 명령이 실패한 worktree만 다시 실행합니다.');
      }
      const from = record.commands.findIndex((command) => command.status === 'failed');
      if (from < 0) throw new UsageError('다시 실행할 명령이 없습니다.');
      return runSetup(record, from);
    },
    getRepos,
    async setRepos(next) {
      const known = new Set((await getRepos()).repos.map((entry) => entry.path));
      const repos: { path: string; setupCommands: string[] }[] = [];
      for (const entry of next.repos) {
        const real = await canonical(entry.path);
        if (!known.has(real)) throw new UsageError(`알 수 없는 저장소입니다: ${entry.path}`);
        repos.push({ path: real, setupCommands: entry.setupCommands });
      }
      await updateConfigFile(configFile, (file) => ({ ...file, repos }));
      return getRepos();
    },
    async forget(paths) {
      await mutate((file) => {
        file.worktrees = file.worktrees.filter((item) => !paths.includes(item.path));
      });
    },
    async close() {
      isClosing = true;
      await failAllInterrupted().catch(() => undefined);
    },
  };
}
