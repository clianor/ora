import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawn } from 'node-pty';
import type { IPty } from 'node-pty';
import type { Terminal } from '@ora/protocol';

const BUFFER_BYTES = 200 * 1024;
const FALLBACK_SHELL = '/bin/zsh';
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

interface TerminalListener {
  onOutput(chunk: Buffer): void;
  onExit(exitCode: number): void;
}

interface TerminalSubscription {
  /** 연결 시점에 링 버퍼에 남아 있던 최근 출력이다. */
  readonly snapshot: Buffer;
  /** 이미 끝난 터미널이면 종료 코드가 있고, 이 경우 구독이 리스너를 부르지 않는다. */
  readonly exitCode: number | undefined;
  unsubscribe(): void;
}

export interface TerminalManager {
  create(options: { cwd: string; cols: number; rows: number; isDeferred?: boolean }): Terminal;
  /** `isDeferred`로 만든 터미널에서 로그인 셸 `-lc <명령>`을 돌리고 종료 코드를 돌려준다. 출력은 같은 터미널에 이어 붙는다. */
  runCommand(id: string, command: string): Promise<number>;
  /** 명령을 마친 뒤 같은 터미널에 쓸 수 있는 로그인 셸을 붙인다. */
  startShell(id: string): void;
  list(): Terminal[];
  get(id: string): Terminal | undefined;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  kill(id: string): void;
  /** 셸이 명령을 돌리는 중이면 true다. 초기 명령이 도는 중이거나 셸의 자식 프로세스가 있으면 돌리는 중이고, 입력만 기다리는 셸은 false다. */
  isBusy(id: string): Promise<boolean>;
  subscribe(id: string, listener: TerminalListener): TerminalSubscription | undefined;
  /** 열린 PTY를 모두 끝내고, 프로세스가 사라질 때까지 기다린다. */
  closeAll(): Promise<void>;
}

interface Entry {
  /** 지금 붙어 있는 PTY다. 초기 명령 터미널은 명령마다 바뀌고, 처음에는 없을 수 있다. */
  pty: IPty | undefined;
  readonly info: Terminal;
  readonly chunks: Buffer[];
  bytes: number;
  exitCode: number | undefined;
  /** `kill`이나 `closeAll`이 불렀다. 명령 PTY가 이 상태로 끝나면 터미널도 끝난 것으로 본다. */
  isKilled: boolean;
  /** `runCommand`가 돌리는 명령이 아직 끝나지 않았다. */
  isRunningCommand: boolean;
  readonly listeners: Set<TerminalListener>;
  readonly exited: Promise<void>;
  readonly resolveExited: (value: undefined) => void;
}

/** pnpm이 풀어 놓은 darwin 사전 빌드의 spawn-helper는 실행 권한이 없어 spawn이 `posix_spawnp failed`로 실패한다. */
function ensureHelperExecutable(): void {
  const root = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  try {
    chmodSync(
      join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      0o755,
    );
  } catch {
    // 사전 빌드를 쓰지 않는 플랫폼에는 이 파일이 없다.
  }
}

export function createTerminalManager(env: NodeJS.ProcessEnv): TerminalManager {
  const entries = new Map<string, Entry>();
  let closing = false;
  const shell = env.SHELL !== undefined && env.SHELL !== '' ? env.SHELL : FALLBACK_SHELL;

  const requireRunning = (id: string): Entry => {
    const entry = entries.get(id);
    if (entry === undefined) throw new Error(`터미널이 없습니다: ${id}`);
    if (entry.exitCode !== undefined) throw new Error(`이미 끝난 터미널입니다: ${id}`);
    return entry;
  };

  const view = (entry: Entry): Terminal => ({
    ...entry.info,
    status: entry.exitCode === undefined ? 'running' : 'exited',
    ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
  });

  const emit = (entry: Entry, chunk: Buffer) => {
    entry.chunks.push(chunk);
    entry.bytes += chunk.length;
    while (entry.bytes > BUFFER_BYTES && entry.chunks.length > 1) {
      entry.bytes -= entry.chunks.shift()?.length ?? 0;
    }
    for (const listener of entry.listeners) listener.onOutput(chunk);
  };

  const finish = (entry: Entry, code: number) => {
    entry.exitCode = code;
    for (const listener of entry.listeners) listener.onExit(code);
    entry.listeners.clear();
    entry.resolveExited(undefined);
  };

  /** 같은 터미널 항목에 새 PTY를 붙인다. 출력은 같은 버퍼와 구독자에게 이어 붙는다. */
  const attach = (entry: Entry, args: string[], onExit: (code: number) => void) => {
    ensureHelperExecutable();
    const pty = spawn(shell, args, {
      cwd: entry.info.cwd,
      cols: entry.info.cols,
      rows: entry.info.rows,
      env: { ...env, TERM: 'xterm-256color' },
      encoding: null,
    });
    entry.pty = pty;
    pty.onData((data: string | Buffer) => {
      emit(entry, typeof data === 'string' ? Buffer.from(data) : data);
    });
    pty.onExit(({ exitCode, signal }) => {
      onExit(signal !== undefined && signal > 0 ? 128 + signal : exitCode);
    });
  };

  const startShell = (entry: Entry) => {
    attach(entry, ['-l'], (code) => {
      finish(entry, code);
    });
  };

  return {
    create({ cwd, cols, rows, isDeferred = false }) {
      if (closing) throw new Error('서버를 닫는 중입니다.');
      const resolvers = Promise.withResolvers<undefined>();
      const entry: Entry = {
        pty: undefined,
        info: {
          id: `t-${Array.from(randomBytes(8), (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('')}`,
          cwd,
          cols,
          rows,
          status: 'running',
          createdAt: new Date().toISOString(),
        },
        chunks: [],
        bytes: 0,
        exitCode: undefined,
        isKilled: false,
        isRunningCommand: false,
        listeners: new Set(),
        exited: resolvers.promise,
        resolveExited: resolvers.resolve,
      };
      entries.set(entry.info.id, entry);
      if (!isDeferred) startShell(entry);
      return view(entry);
    },
    runCommand(id, command) {
      const entry = requireRunning(id);
      emit(entry, Buffer.from(`$ ${command}\r\n`));
      const { promise, resolve } = Promise.withResolvers<number>();
      entry.isRunningCommand = true;
      attach(entry, ['-lc', command], (code) => {
        entry.isRunningCommand = false;
        if (entry.isKilled) finish(entry, code);
        resolve(code);
      });
      return promise;
    },
    startShell(id) {
      startShell(requireRunning(id));
    },
    list: () => [...entries.values()].map(view),
    get: (id) => {
      const entry = entries.get(id);
      return entry === undefined ? undefined : view(entry);
    },
    write(id, data) {
      requireRunning(id).pty?.write(data);
    },
    resize(id, cols, rows) {
      const entry = requireRunning(id);
      entry.pty?.resize(cols, rows);
      Object.assign(entry.info, { cols, rows });
    },
    kill(id) {
      const entry = requireRunning(id);
      entry.isKilled = true;
      entry.pty?.kill();
    },
    async isBusy(id) {
      const entry = entries.get(id);
      if (entry === undefined || entry.exitCode !== undefined) return false;
      if (entry.isRunningCommand) return true;
      if (entry.pty === undefined) return false;
      const { promise, resolve } = Promise.withResolvers<boolean>();
      execFile('pgrep', ['-P', String(entry.pty.pid)], (error, stdout) => {
        resolve(error === null && stdout.trim() !== '');
      });
      return promise;
    },
    subscribe(id, listener) {
      const entry = entries.get(id);
      if (entry === undefined) return undefined;
      const snapshot = Buffer.concat(entry.chunks);
      if (entry.exitCode !== undefined) {
        return { snapshot, exitCode: entry.exitCode, unsubscribe: () => undefined };
      }
      entry.listeners.add(listener);
      return {
        snapshot,
        exitCode: undefined,
        unsubscribe: () => {
          entry.listeners.delete(listener);
        },
      };
    },
    async closeAll() {
      closing = true;
      const running = [...entries.values()].filter((entry) => entry.exitCode === undefined);
      for (const entry of running) {
        entry.isKilled = true;
        // 붙은 PTY가 없는 터미널은 끝낼 프로세스가 없으므로 바로 끝낸 것으로 표시한다.
        if (entry.pty === undefined) finish(entry, 143);
        else entry.pty.kill();
      }
      // SIGHUP을 무시하는 셸은 잠시 뒤 SIGKILL로 끝낸다.
      const escalation = setTimeout(() => {
        for (const entry of running) if (entry.exitCode === undefined) entry.pty?.kill('SIGKILL');
      }, 2000);
      await Promise.all(running.map((entry) => entry.exited));
      clearTimeout(escalation);
    },
  };
}
