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
  create(options: { cwd: string; cols: number; rows: number }): Terminal;
  list(): Terminal[];
  get(id: string): Terminal | undefined;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  kill(id: string): void;
  subscribe(id: string, listener: TerminalListener): TerminalSubscription | undefined;
  /** 열린 PTY를 모두 끝내고, 프로세스가 사라질 때까지 기다린다. */
  closeAll(): Promise<void>;
}

interface Entry {
  readonly pty: IPty;
  readonly info: Terminal;
  readonly chunks: Buffer[];
  bytes: number;
  exitCode: number | undefined;
  readonly listeners: Set<TerminalListener>;
  readonly exited: Promise<void>;
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

  return {
    create({ cwd, cols, rows }) {
      if (closing) throw new Error('서버를 닫는 중입니다.');
      ensureHelperExecutable();
      const shell = env.SHELL !== undefined && env.SHELL !== '' ? env.SHELL : FALLBACK_SHELL;
      const pty = spawn(shell, ['-l'], {
        cwd,
        cols,
        rows,
        env: { ...env, TERM: 'xterm-256color' },
        encoding: null,
      });
      const resolvers = Promise.withResolvers<undefined>();
      const entry: Entry = {
        pty,
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
        listeners: new Set(),
        exited: resolvers.promise,
      };
      pty.onData((data: string | Buffer) => {
        const chunk = typeof data === 'string' ? Buffer.from(data) : data;
        entry.chunks.push(chunk);
        entry.bytes += chunk.length;
        while (entry.bytes > BUFFER_BYTES && entry.chunks.length > 1) {
          entry.bytes -= entry.chunks.shift()?.length ?? 0;
        }
        for (const listener of entry.listeners) listener.onOutput(chunk);
      });
      pty.onExit(({ exitCode, signal }) => {
        const code = signal !== undefined && signal > 0 ? 128 + signal : exitCode;
        entry.exitCode = code;
        for (const listener of entry.listeners) listener.onExit(code);
        entry.listeners.clear();
        resolvers.resolve(undefined);
      });
      entries.set(entry.info.id, entry);
      return view(entry);
    },
    list: () => [...entries.values()].map(view),
    get: (id) => {
      const entry = entries.get(id);
      return entry === undefined ? undefined : view(entry);
    },
    write(id, data) {
      requireRunning(id).pty.write(data);
    },
    resize(id, cols, rows) {
      const entry = requireRunning(id);
      entry.pty.resize(cols, rows);
      Object.assign(entry.info, { cols, rows });
    },
    kill(id) {
      requireRunning(id).pty.kill();
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
      for (const entry of running) entry.pty.kill();
      await Promise.all(running.map((entry) => entry.exited));
    },
  };
}
