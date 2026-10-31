import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  applyUserTodoAction,
  createRecorder,
  formatKst,
  parseTranscript,
  reconcileCurrent,
  reduceTodoState,
  scrubValue,
} from '@ora/core';
import type { UserTodoAction } from '@ora/core';
import { dropRewoundEvents, workerMessageSchema } from '@ora/protocol';
import type {
  ApprovalDecision,
  ApprovalRequest,
  EndReason,
  LaunchCommand,
  OraEvent,
  QuestionAnswer,
  QuestionRequest,
  SessionRecord,
  SessionStatus,
  Todo,
  WorkerCommand,
  WorkerMessage,
} from '@ora/protocol';
import {
  createSessionStorage,
  listSessionRecords,
  readSessionRecord,
  readSessionRecordOrWarn,
  readTodos,
  readTranscriptText,
} from '@ora/store';
import { UsageError, loadConfig, resolveSessionsDir } from './config.ts';
import { resolveOraHome } from './isolation/ora-home.ts';
import { killOrphanShells, recoverSession } from './recovery.ts';

const WORKER_PATH = fileURLToPath(new URL('./worker.ts', import.meta.url));
const PID_FILE = 'worker.pid';
export const SESSION_LOCK_FILE = 'session.lock';
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
  /** 세션 워커 진입 파일이다. 생략하면 이 패키지의 `worker.ts`다. 번들한 앱이 번들한 워커를 가리킨다. */
  readonly workerPath?: string;
  readonly onEvent?: (event: OraEvent) => void;
  /** 워커가 승인을 요청하면 부른다. `request.interactive`가 true인 세션에서만 온다. */
  readonly onApprovalRequest?: (requestId: string, request: ApprovalRequest) => void;
  readonly onQuestionRequest?: (requestId: string, request: QuestionRequest) => void;
  /** 워커가 응답 없이 신호가 취소돼 거둔 승인·질문이다. */
  readonly onRequestWithdrawn?: (requestId: string) => void;
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
  resolveApproval(requestId: string, decision: ApprovalDecision): void;
  answerQuestion(requestId: string, answers: QuestionAnswer[]): void;
  /** 실행 중인 워커에 사용자의 포기·포기 취소를 보낸다. 워커가 지금 스텝이 끝난 뒤 반영한다. */
  sendTodoAction(action: UserTodoAction): void;
  /** 실행 중인 부모 워커에 하위 세션 하나만 멈추라고 보낸다. */
  cancelDelegate(sessionId: string): void;
  /** 세션 ID가 정해지면 풀린다. 재개 요청이 시작 전에 실패하면 거부로 끝난다. */
  readonly sessionId: Promise<string>;
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
export async function tryLock(path: string): Promise<(() => Promise<void>) | undefined> {
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

/** 자리가 있으면 슬롯을 잡고, 없으면 기다리지 않고 `undefined`를 돌려준다. 하위 세션이 부모 슬롯을 기다리며 교착하지 않게 한다. */
export async function tryAcquireSlot(
  slotsDir: string,
  max: number,
): Promise<(() => Promise<void>) | undefined> {
  await mkdir(slotsDir, { recursive: true });
  for (let index = 0; index < max; index += 1) {
    const release = await tryLock(join(slotsDir, String(index)));
    if (release !== undefined) return release;
  }
  return undefined;
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
  const session = await readSessionRecordOrWarn(sessionDir);
  if (session?.status === 'archived') {
    throw new UsageError(`archived 세션은 재개하지 않습니다: ${sessionId}`);
  }
}

export function createSessionId(): string {
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
  const idReady = Promise.withResolvers<string>();
  idReady.promise.catch(() => undefined);
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
  let sendToWorker: ((command: WorkerCommand) => void) | undefined;

  const run = async (): Promise<SessionResult> => {
    const oraHome = resolveOraHome(options.env);
    const config = await loadConfig(options.request.configPath, oraHome);
    const { request } = options;
    const sessionId = request.type === 'resumeSession' ? request.sessionId : createSessionId();
    if (request.type === 'createSession') idReady.resolve(sessionId);
    const sessionDir = join(resolveSessionsDir(config, oraHome), sessionId);
    const recovery = {
      sessionId,
      fallback: {
        permissionMode:
          (request.type === 'createSession' ? request.permissionMode : undefined) ??
          config.permissions.mode,
        isolation: request.isolation ?? config.isolation,
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
        idReady.resolve(sessionId);
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
      const worker = fork(options.workerPath ?? WORKER_PATH, [], {
        detached: true,
        // 패키징한 앱에는 시스템 node가 없어 Electron 실행 파일이 node처럼 돌아야 한다.
        env:
          process.versions.electron === undefined
            ? options.env
            : { ...options.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      // 이미 끝난 워커에 명령을 쓰면 EPIPE가 나므로 오류로 호스트를 죽이지 않는다. 종료 상태는 exit 이벤트로 판정한다.
      worker.on('error', () => undefined);
      cancelWorker = (mode) => {
        sendCancel(worker, mode, sessionDir);
      };
      sendToWorker = (message) => {
        if (worker.connected) worker.send(message);
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
        else if (message.type === 'usage_error') state.usageError = message.message;
        else if (message.type === 'approval_request') {
          options.onApprovalRequest?.(message.requestId, message.request);
        } else if (message.type === 'question_request') {
          options.onQuestionRequest?.(message.requestId, message.request);
        } else options.onRequestWithdrawn?.(message.requestId);
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

  const handle: SessionHandle = {
    cancel(mode) {
      if (cancelWorker === undefined) {
        earlyCancel = mode === 'hard' || earlyCancel === 'hard' ? 'hard' : 'soft';
        queueAbort.abort();
        return;
      }
      cancelWorker(mode);
    },
    resolveApproval(requestId, decision) {
      sendToWorker?.({ type: 'resolveApproval', requestId, decision });
    },
    answerQuestion(requestId, answers) {
      sendToWorker?.({ type: 'answerQuestion', requestId, answers });
    },
    sendTodoAction(action) {
      sendToWorker?.({ type: 'todoAction', ...action });
    },
    cancelDelegate(sessionId) {
      sendToWorker?.({ type: 'cancelDelegate', sessionId });
    },
    sessionId: idReady.promise,
    result: run().catch((error: unknown) => {
      idReady.reject(error);
      throw error;
    }),
  };
  return handle;
}

/** 세션 기록 목록이다. 최근에 만든 세션이 앞에 온다. */
export async function listSessions(
  env: NodeJS.ProcessEnv,
  configPath: string | undefined,
): Promise<SessionRecord[]> {
  const oraHome = resolveOraHome(env);
  const config = await loadConfig(configPath, oraHome);
  const records = await listSessionRecords(resolveSessionsDir(config, oraHome));
  return records.filter((record) => record.actor !== 'routine:memory');
}

/**
 * 멈춘 세션의 todo를 사용자가 포기하거나 포기를 취소한다. 세션 락을 잡고 `todo_update`를 transcript에 덧붙이고 todos.json을 고친다.
 * 거부하면 거부 사유를 돌려주고, 기록에는 남기지 않는다.
 */
export async function applyTodoActionToStoppedSession(
  env: NodeJS.ProcessEnv,
  configPath: string | undefined,
  sessionId: string,
  action: UserTodoAction,
): Promise<{ readonly rejected?: string }> {
  const oraHome = resolveOraHome(env);
  const config = await loadConfig(configPath, oraHome);
  const sessionDir = join(resolveSessionsDir(config, oraHome), sessionId);
  await assertResumable(sessionDir, sessionId);
  const release = await tryLock(join(sessionDir, SESSION_LOCK_FILE));
  if (release === undefined) throw new UsageError(`세션이 이미 실행 중입니다: ${sessionId}`);
  try {
    await recoverSession(
      sessionDir,
      {
        sessionId,
        fallback: { permissionMode: config.permissions.mode, isolation: config.isolation },
      },
      { hardKill: false, reason: '이전 실행이 기록을 닫지 못하고 끝났습니다.' },
    );
    const events = dropRewoundEvents(
      parseTranscript((await readTranscriptText(sessionDir)) ?? '').events,
    );
    const state = reduceTodoState(events);
    const outcome = applyUserTodoAction(state.todos, action, formatKst(new Date()));
    if (outcome === undefined) throw new UsageError(`todo ${action.todoId}가 없습니다.`);
    if (outcome.rejected !== undefined) return { rejected: outcome.rejected };
    const fragment =
      reconcileCurrent(
        [...state.todos.values()],
        state.phases.map((phase) => phase.name),
        state.current,
      ) ?? {};
    const storage = await createSessionStorage(sessionDir);
    const recorder = createRecorder(
      sessionId,
      storage.transcript,
      { now: () => new Date() },
      events.at(-1)?.seq,
    );
    await recorder.emit('user', {
      type: 'todo_update',
      payload: {
        todoId: action.todoId,
        ...(outcome.from === undefined ? {} : { from: outcome.from }),
        to: outcome.to,
        todo: outcome.todo,
        ...fragment,
      },
    });
    await storage.sessions.saveTodos(scrubValue([...state.todos.values()]));
    return {};
  } finally {
    await release();
  }
}
