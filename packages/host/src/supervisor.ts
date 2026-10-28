import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { formatKst } from '@ora/core';
import { workerMessageSchema } from '@ora/protocol';
import type {
  EndReason,
  LaunchCommand,
  OraEvent,
  SessionRecord,
  SessionStatus,
  Todo,
  WorkerCommand,
  WorkerMessage,
} from '@ora/protocol';
import { listSessionRecords, readSessionRecord, readTodos, readTranscriptText } from '@ora/store';
import { UsageError, loadConfig, resolveSessionsDir } from './config.ts';
import { resolveOraHome } from './isolation/ora-home.ts';
import { killOrphanShells, recoverSession } from './recovery.ts';

const WORKER_PATH = fileURLToPath(new URL('./worker.ts', import.meta.url));
const PID_FILE = 'worker.pid';
const SESSION_LOCK_FILE = 'session.lock';
const SLOT_POLL_MS = 200;
// 워커가 IPC 명령에 응답하지 못할 때 호스트가 프로세스 그룹을 직접 종료하기까지 기다리는 시간이다.
const HARD_KILL_GRACE_MS = 2000;
const RESUMABLE_STATUSES: readonly SessionStatus[] = [
  'created',
  'running',
  'awaiting_approval',
  'awaiting_user',
  'interrupted',
  'stopped',
  'failed',
  'crashed',
];

/** 대기열에서 기다리는 동안 취소해서 세션을 시작하지 않았다는 뜻이다. */
export class CancelledBeforeStartError extends Error {}

type CreateRequest = Omit<Extract<WorkerCommand, { type: 'createSession' }>, 'sessionId'>;
export type LaunchRequest = CreateRequest | Extract<WorkerCommand, { type: 'resumeSession' }>;

export interface LaunchOptions {
  readonly request: LaunchRequest;
  readonly env: NodeJS.ProcessEnv;
  readonly onEvent?: (event: OraEvent) => void;
  /** 동시 세션 상한에 걸려 대기열에 들어갈 때 한 번 부른다. */
  readonly onQueued?: () => void;
}

export interface SessionResult {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly status: SessionStatus;
  readonly endReason: EndReason;
  readonly summary: string;
  readonly todos: readonly Todo[];
}

export interface SessionHandle {
  cancel(mode: 'soft' | 'hard'): void;
  readonly result: Promise<SessionResult>;
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readPid(path: string): Promise<number> {
  return Number((await readFile(path, 'utf8').catch(() => '')).trim());
}

/**
 * 락 파일을 `wx`로 만들어 잡는다. 주인 PID가 이미 죽었으면 이전 실행이 남긴 락으로 보고 회수한다.
 * 이미 살아 있는 주인이 있으면 `undefined`를 돌려준다.
 * 회수는 `<락>.reclaim` 파일을 `wx`로 잡은 호스트 하나만 하고, 그 안에서 주인이 바뀌지 않았는지 다시 확인한 뒤 지운다.
 * 그래서 두 호스트가 같은 죽은 락을 동시에 지워도, 다른 호스트가 새로 만든 락을 지우지 않는다.
 * ponytail: 주인 PID가 다른 프로세스에 재사용되면 락이 풀리지 않고, `.reclaim` 주인이 지우는 도중에 죽으면 다음 호스트가 회수한다.
 */
async function tryLock(path: string): Promise<(() => Promise<void>) | undefined> {
  const guard = `${path}.reclaim`;
  for (;;) {
    try {
      await writeFile(path, String(process.pid), { flag: 'wx' });
      return () => rm(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = await readPid(path);
    if (isAlive(holder)) return undefined;
    try {
      await writeFile(guard, String(process.pid), { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!isAlive(await readPid(guard))) await rm(guard, { force: true });
      await sleep(20);
      continue;
    }
    try {
      if ((await readPid(path)) === holder) await rm(path, { force: true });
    } finally {
      await rm(guard, { force: true });
    }
  }
}

/** 슬롯 파일 `slots/<n>`을 락으로 잡아 동시 세션 수를 센다. 호스트 프로세스가 여러 개여도 상한이 지켜진다. */
async function acquireSlot(
  slotsDir: string,
  max: number,
  signal: AbortSignal,
  onQueued: (() => void) | undefined,
): Promise<() => Promise<void>> {
  await mkdir(slotsDir, { recursive: true });
  let queued = false;
  for (;;) {
    for (let index = 0; index < max; index += 1) {
      const release = await tryLock(join(slotsDir, String(index)));
      if (release !== undefined) return release;
    }
    if (!queued) onQueued?.();
    queued = true;
    try {
      await sleep(SLOT_POLL_MS, undefined, { signal });
    } catch {
      throw new CancelledBeforeStartError('세션을 시작하기 전에 취소했습니다.');
    }
  }
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // 이미 끝난 프로세스 그룹이다.
  }
}

/** 워커가 끝났거나 응답하지 않을 때 쓰는 공통 정리다. 워커 그룹과 워커가 남긴 셸 그룹을 모두 종료한다. */
async function killWorkerTree(pid: number | undefined, sessionDir: string): Promise<void> {
  killGroup(pid);
  await killOrphanShells(sessionDir);
}

async function assertResumable(sessionDir: string, sessionId: string): Promise<void> {
  if ((await readTranscriptText(sessionDir)) === undefined) {
    throw new UsageError(`세션을 찾을 수 없습니다: ${sessionId}`);
  }
  const session = await readSessionRecord(sessionDir).catch(() => undefined);
  if (session?.status === 'archived') {
    throw new UsageError(`archived 세션은 재개하지 않습니다: ${sessionId}`);
  }
}

function createSessionId(): string {
  const suffix = randomBytes(6)
    .toString('base64url')
    .replace(/[^A-Za-z0-9]/g, 'x')
    .slice(0, 6);
  return `s-${formatKst(new Date()).slice(0, 10).replaceAll('-', '')}-${suffix}`;
}

/**
 * 세션 하나를 별도 워커 프로세스에서 실행한다 (SPEC 2.2.1절). 워커는 새 프로세스 그룹의 리더다.
 * 워커가 결과 없이 죽으면 transcript를 봉인하고 `crashed`로 돌려준다.
 */
export function launchSession(options: LaunchOptions): SessionHandle {
  const queueAbort = new AbortController();
  let hardRequested = false;
  let earlyCancel: 'soft' | 'hard' | undefined;

  const sendCancel = (worker: ChildProcess, mode: 'soft' | 'hard', sessionDir: string) => {
    if (mode === 'hard') {
      hardRequested = true;
      setTimeout(() => {
        killWorkerTree(worker.pid, sessionDir).catch(() => undefined);
      }, HARD_KILL_GRACE_MS).unref();
    }
    if (worker.connected) worker.send({ type: 'cancel', mode } satisfies WorkerCommand);
  };
  let cancelWorker: ((mode: 'soft' | 'hard') => void) | undefined;

  const run = async (): Promise<SessionResult> => {
    const oraHome = resolveOraHome(options.env);
    const config = await loadConfig(options.request.configPath, oraHome);
    const { request } = options;
    const sessionId = request.type === 'resumeSession' ? request.sessionId : createSessionId();
    const sessionDir = join(resolveSessionsDir(config, oraHome), sessionId);
    const recovery = {
      sessionId,
      fallback: {
        permissionMode:
          (request.type === 'createSession' ? request.permissionMode : undefined) ??
          config.permissions.mode,
        isolation: config.isolation,
      },
    };

    // 같은 세션을 두 호스트가 동시에 재개하면 transcript에 같은 seq가 두 번 쓰이므로, 재개는 세션 락을 잡은 호스트 하나만 한다.
    const releases: (() => Promise<void>)[] = [];
    try {
      if (request.type === 'resumeSession') {
        await assertResumable(sessionDir, sessionId);
        const lock = await tryLock(join(sessionDir, SESSION_LOCK_FILE));
        if (lock === undefined) {
          throw new UsageError(`세션이 이미 실행 중입니다: ${sessionId}`);
        }
        releases.push(lock);
      }
      releases.push(
        await acquireSlot(
          join(oraHome, 'slots'),
          config.limits.maxConcurrentSessions,
          queueAbort.signal,
          options.onQueued,
        ),
      );
      if (request.type === 'resumeSession') {
        const { started } = await recoverSession(sessionDir, recovery, {
          hardKill: false,
          reason: '이전 실행이 기록을 닫지 못하고 끝났습니다.',
        });
        const session = await readSessionRecord(sessionDir);
        if (session?.status === 'archived') {
          throw new UsageError(`archived 세션은 재개하지 않습니다: ${sessionId}`);
        }
        if (!started) {
          throw new UsageError(
            `시작 기록이 없어 재개할 수 없습니다 (${session?.status}): ${sessionId}`,
          );
        }
        if (session === undefined || !RESUMABLE_STATUSES.includes(session.status)) {
          throw new UsageError(`${session?.status} 상태의 세션은 재개하지 않습니다: ${sessionId}`);
        }
      }
      return await runWorker(sessionId, sessionDir, recovery);
    } finally {
      for (const release of releases.reverse()) await release();
    }
  };

  const runWorker = async (
    sessionId: string,
    sessionDir: string,
    recovery: Parameters<typeof recoverSession>[1],
  ): Promise<SessionResult> => {
    const pidPath = join(sessionDir, PID_FILE);
    try {
      const command: LaunchCommand = { ...options.request, sessionId };
      const worker = fork(WORKER_PATH, [], {
        detached: true,
        env: options.env,
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      cancelWorker = (mode) => {
        sendCancel(worker, mode, sessionDir);
      };
      await mkdir(sessionDir, { recursive: true });
      await writeFile(pidPath, String(worker.pid));

      const state: {
        outcome?: Extract<WorkerMessage, { type: 'result' }>;
        usageError?: string;
        badMessage: boolean;
      } = { badMessage: false };
      worker.on('message', (raw) => {
        const parsed = workerMessageSchema.safeParse(raw);
        if (!parsed.success) {
          // 형식을 모르는 워커는 믿지 않는다. 호스트가 죽지 않도록 워커를 종료하고 crashed 경로로 보낸다.
          state.badMessage = true;
          killWorkerTree(worker.pid, sessionDir).catch(() => undefined);
          return;
        }
        const message = parsed.data;
        if (message.type === 'event') options.onEvent?.(message.event);
        else if (message.type === 'result') state.outcome = message;
        else state.usageError = message.message;
      });
      const exited = new Promise<string>((resolve) => {
        worker.once('exit', (code, signal) => {
          resolve(signal ?? `exit ${code ?? '?'}`);
        });
      });
      const disconnected = new Promise<void>((resolve) => {
        worker.once('disconnect', resolve);
      });
      worker.send(command);
      if (earlyCancel !== undefined) sendCancel(worker, earlyCancel, sessionDir);

      const [exit] = await Promise.all([exited, disconnected]);
      await killWorkerTree(worker.pid, sessionDir);
      const { outcome, usageError, badMessage } = state;
      if (usageError !== undefined) throw new UsageError(usageError);
      if (outcome !== undefined && !badMessage) {
        return {
          sessionId,
          sessionDir,
          status: outcome.status,
          endReason: outcome.endReason,
          summary: outcome.summary,
          todos: outcome.todos,
        };
      }

      let reason = `워커 프로세스가 예기치 않게 종료됐습니다 (${exit}).`;
      if (badMessage) reason = '워커가 형식에 맞지 않는 메시지를 보내 종료했습니다.';
      if (hardRequested) reason = '사용자가 강제 종료했습니다.';
      await recoverSession(sessionDir, recovery, { hardKill: hardRequested, reason });
      const record = await readSessionRecord(sessionDir);
      return {
        sessionId,
        sessionDir,
        status: record?.status ?? 'crashed',
        endReason: record?.endReason ?? (hardRequested ? 'user_cancel' : 'error'),
        summary: reason,
        todos: await readTodos(sessionDir),
      };
    } finally {
      await rm(pidPath, { force: true });
    }
  };

  return {
    cancel(mode) {
      if (cancelWorker === undefined) {
        earlyCancel = mode === 'hard' || earlyCancel === 'hard' ? 'hard' : 'soft';
        queueAbort.abort();
        return;
      }
      cancelWorker(mode);
    },
    result: run(),
  };
}

/** 세션 기록 목록이다. 최근에 만든 세션이 앞에 온다. */
export async function listSessions(
  env: NodeJS.ProcessEnv,
  configPath: string | undefined,
): Promise<SessionRecord[]> {
  const oraHome = resolveOraHome(env);
  const config = await loadConfig(configPath, oraHome);
  return listSessionRecords(resolveSessionsDir(config, oraHome));
}
