import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { createRecorder, formatKst, parseTranscript, reduceTodoState, scrubValue } from '@ora/core';
import type { EventDraft } from '@ora/core';
import { dropRewoundEvents, getUndoableRewind } from '@ora/protocol';
import type { EventOf, OraEvent, RewindPreview, RewindResult, SessionRecord } from '@ora/protocol';
import {
  createSessionStorage,
  listSessionRecords,
  readSessionRecordOrWarn,
  readTranscriptText,
  writeSessionRecord,
} from '@ora/store';
import { UsageError, loadConfig, resolveSessionsDir } from './config.ts';
import type { Config } from './config.ts';
import {
  appendHistory,
  applyFileState,
  describeFile,
  historyDir,
  isLargeState,
  readHistory,
} from './file-history.ts';
import type { HistoryLine } from './file-history.ts';
import { resolveOraHome } from './isolation/ora-home.ts';
import { recoverSession } from './recovery.ts';
import { SESSION_LOCK_FILE, tryLock } from './supervisor.ts';

/** 파일 하나를 되돌릴 상태다. `to`가 `null`이면 지운다. */
interface FileOperation {
  readonly path: string;
  readonly to: string | null;
}

interface RewindPlan {
  readonly preview: Omit<RewindPreview, 'blockedReason'>;
  readonly operations: readonly FileOperation[];
}

interface UndoManifest {
  rewindSeq?: number;
  files: { path: string; current: string | null }[];
}

export interface RewindApiOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly configPath?: string;
  /** 이 호스트에서 실행 중이거나 재개를 시작하는 세션의 ID다. */
  readonly listLiveIds: () => readonly string[];
  /** 호스트가 덧붙인 이벤트를 화면에 흘려 보낸다. */
  readonly publish: (event: OraEvent) => void;
}

const undoPath = (sessionDir: string) => join(historyDir(sessionDir), 'undo.json');

/** 세션이 끝난 뒤에도 이어 갈 수 있게 다시 여는 상태다. 이 밖의 상태(병합, 보관)는 되돌리지 않는다. */
const REWINDABLE_STATUSES: readonly SessionRecord['status'][] = [
  'running',
  'awaiting_approval',
  'awaiting_user',
  'interrupted',
  'completed',
  'stopped',
  'failed',
  'crashed',
];

interface Located {
  readonly config: Config;
  readonly sessionsDir: string;
  readonly sessionDir: string;
}

export function createRewindApi(options: RewindApiOptions) {
  const oraHome = resolveOraHome(options.env);

  const locate = async (sessionId: string): Promise<Located> => {
    const config = await loadConfig(options.configPath, oraHome);
    const sessionsDir = resolveSessionsDir(config, oraHome);
    return { config, sessionsDir, sessionDir: join(sessionsDir, sessionId) };
  };

  const readState = async (sessionDir: string) => {
    const record = await readSessionRecordOrWarn(sessionDir);
    const text = await readTranscriptText(sessionDir);
    if (record === undefined || text === undefined)
      throw new UsageError('세션 기록을 읽을 수 없습니다.');
    return { record, events: parseTranscript(text).events };
  };

  const displayPath = (record: SessionRecord, path: string) => {
    if (record.repo === undefined) return path;
    const rel = relative(record.repo, path);
    return rel.startsWith('..') || isAbsolute(rel) ? path : rel;
  };

  const getBlockedReason = async (
    sessionId: string,
    record: SessionRecord,
    sessionsDir: string,
  ) => {
    const live = options.listLiveIds();
    if (live.includes(sessionId)) return '세션을 멈춘 뒤 쓸 수 있습니다';
    if (record.repo === undefined || live.length === 0) return undefined;
    const others = await listSessionRecords(sessionsDir);
    const running = others.find(
      (other) => other.id !== sessionId && live.includes(other.id) && other.repo === record.repo,
    );
    return running === undefined ? undefined : '같은 워크트리의 다른 세션이 실행 중입니다';
  };

  const buildPlan = async (
    sessionDir: string,
    sessionsDir: string,
    record: SessionRecord,
    events: readonly OraEvent[],
    seq: number,
  ): Promise<RewindPlan> => {
    const visible = dropRewoundEvents(events);
    const target = visible.find(
      (event): event is EventOf<'message'> =>
        event.seq === seq &&
        event.type === 'message' &&
        event.actor === 'user' &&
        event.payload.role === 'user',
    );
    if (target === undefined)
      throw new UsageError(`되돌릴 수 있는 사용자 메시지가 아닙니다: ${seq}`);
    const text = target.payload.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    const removedMessages = visible.filter(
      (event) =>
        event.seq >= seq &&
        event.type === 'message' &&
        (event.payload.role === 'assistant' || event.actor === 'user'),
    ).length;

    const lines = (await readHistory(sessionDir)).filter((line) => line.tag > seq);
    const commitCount = lines.reduce((sum, line) => sum + (line.commits ?? 0), 0);
    const byPath = new Map<string, { first: HistoryLine; last: HistoryLine }>();
    for (const line of lines) {
      if (line.path === undefined) continue;
      byPath.set(line.path, { first: byPath.get(line.path)?.first ?? line, last: line });
    }

    const operations: FileOperation[] = [];
    const restore: string[] = [];
    const remove: string[] = [];
    const skipped: string[] = [];
    const overwritten = new Map<string, string>();
    for (const [path, { first, last }] of byPath) {
      const shown = displayPath(record, path);
      if (first.large === true || isLargeState(first.before)) {
        skipped.push(shown);
        continue;
      }
      const before = first.before ?? null;
      const current = await describeFile(path);
      if (before === current) continue;
      operations.push({ path, to: before });
      (before === null ? remove : restore).push(shown);
      if (current !== null && last.after !== current) {
        overwritten.set(shown, (await stat(path)).mtime.toISOString());
      }
    }

    const otherSessionFiles: RewindPreview['otherSessionFiles'] = [];
    const planned = new Set(operations.map((operation) => displayPath(record, operation.path)));
    if (record.repo !== undefined && planned.size > 0) {
      for (const other of await listSessionRecords(sessionsDir)) {
        if (other.id === record.id || other.repo !== record.repo) continue;
        const touched = new Set<string>();
        for (const line of await readHistory(join(sessionsDir, other.id))) {
          if (line.path === undefined || line.ts <= target.ts) continue;
          const shown = displayPath(record, line.path);
          if (planned.has(shown) && !touched.has(shown)) {
            touched.add(shown);
            otherSessionFiles.push({ sessionId: other.id, title: other.title, path: shown });
            overwritten.delete(shown);
          }
        }
      }
    }

    return {
      preview: {
        targetSeq: seq,
        text,
        isGitRepo: record.repo !== undefined,
        restoreFiles: restore,
        deleteFiles: remove,
        overwrittenFiles: [...overwritten].map(([path, modifiedAt]) => ({
          path,
          modifiedAt: formatKst(new Date(modifiedAt)),
        })),
        skippedFiles: skipped,
        removedMessages,
        commitCount,
        otherSessionFiles,
      },
      operations,
    };
  };

  /** 파일을 목표 상태로 바꾸고, 바꾸기 전 상태를 돌려준다. 실패하면 이미 바꾼 파일을 되돌리고 던진다. */
  const applyOperations = async (
    sessionDir: string,
    operations: readonly FileOperation[],
  ): Promise<{ path: string; current: string | null }[]> => {
    const previous: { path: string; current: string | null }[] = [];
    for (const operation of operations) {
      previous.push({
        path: operation.path,
        current: await describeFile(operation.path, { sessionDir }),
      });
    }
    const done: typeof previous = [];
    try {
      for (const [index, operation] of operations.entries()) {
        await applyFileState(sessionDir, operation.path, operation.to);
        const before = previous[index];
        if (before !== undefined) done.push(before);
      }
    } catch (error) {
      for (const item of done) await applyFileState(sessionDir, item.path, item.current);
      throw error;
    }
    return previous;
  };

  /** 되돌리기나 취소가 바꾼 파일을 세션 기록에 남겨, 뒤의 되돌리기가 이 변경을 이어 받게 한다. */
  const recordOperations = async (
    sessionDir: string,
    lastSeq: number,
    operations: readonly FileOperation[],
    previous: readonly { path: string; current: string | null }[],
  ) => {
    for (const [index, operation] of operations.entries()) {
      await appendHistory(sessionDir, {
        tag: lastSeq,
        ts: formatKst(new Date()),
        path: operation.path,
        before: previous[index]?.current ?? null,
        after: operation.to,
      });
    }
  };

  /** 세션 락을 잡고 `body`를 실행한다. 이전 실행이 기록을 봉인하지 못했으면 먼저 봉인한다. */
  const withStoppedSession = async <T>(
    sessionId: string,
    body: (context: Located) => Promise<T>,
  ): Promise<T> => {
    const context = await locate(sessionId);
    const release = await tryLock(join(context.sessionDir, SESSION_LOCK_FILE));
    if (release === undefined) throw new UsageError('세션을 멈춘 뒤 쓸 수 있습니다');
    try {
      await recoverSession(
        context.sessionDir,
        {
          sessionId,
          fallback: {
            permissionMode: context.config.permissions.mode,
            isolation: context.config.isolation,
          },
        },
        { hardKill: false, reason: '이전 실행이 기록을 닫지 못하고 끝났습니다.' },
      );
      return await body(context);
    } finally {
      await release();
    }
  };

  /** 이벤트 하나를 덧붙이고 todos.json을 가려지지 않은 이벤트에서 다시 만든다. */
  const emitAndSync = async (
    sessionId: string,
    sessionDir: string,
    events: readonly OraEvent[],
    draft: EventDraft,
  ): Promise<OraEvent> => {
    const storage = await createSessionStorage(sessionDir);
    let emitted: OraEvent | undefined;
    const recorder = createRecorder(
      sessionId,
      {
        async append(event) {
          await storage.transcript.append(event);
          emitted = event;
        },
      },
      { now: () => new Date() },
      events.at(-1)?.seq,
    );
    await recorder.emit('user', draft);
    if (emitted === undefined) throw new Error('이벤트를 기록하지 못했습니다.');
    const state = reduceTodoState(dropRewoundEvents([...events, emitted]));
    await storage.sessions.saveTodos(scrubValue([...state.todos.values()]));
    options.publish(emitted);
    return emitted;
  };

  return {
    async preview(sessionId: string, seq: number): Promise<RewindPreview> {
      const { sessionDir, sessionsDir } = await locate(sessionId);
      const { record, events } = await readState(sessionDir);
      const plan = await buildPlan(sessionDir, sessionsDir, record, events, seq);
      const blockedReason = await getBlockedReason(sessionId, record, sessionsDir);
      return { ...plan.preview, ...(blockedReason === undefined ? {} : { blockedReason }) };
    },

    async rewind(sessionId: string, seq: number): Promise<RewindResult> {
      return withStoppedSession(sessionId, async ({ sessionDir, sessionsDir }) => {
        const { record, events } = await readState(sessionDir);
        if (!REWINDABLE_STATUSES.includes(record.status)) {
          throw new UsageError(`${record.status} 상태의 세션은 되돌릴 수 없습니다.`);
        }
        const blocked = await getBlockedReason(sessionId, record, sessionsDir);
        if (blocked !== undefined) throw new UsageError(blocked);
        const plan = await buildPlan(sessionDir, sessionsDir, record, events, seq);
        const lastSeq = events.at(-1)?.seq ?? seq;

        const previous = await applyOperations(sessionDir, plan.operations);
        const manifest: UndoManifest = { files: previous };
        await mkdir(historyDir(sessionDir), { recursive: true });
        await writeFile(undoPath(sessionDir), JSON.stringify(manifest));
        await recordOperations(sessionDir, lastSeq, plan.operations, previous);

        const emitted = await emitAndSync(sessionId, sessionDir, events, {
          type: 'rewind',
          payload: {
            targetSeq: seq,
            fromSeq: seq,
            toSeq: lastSeq,
            text: plan.preview.text,
            removedMessages: plan.preview.removedMessages,
            restoredFiles: plan.preview.restoreFiles,
            deletedFiles: plan.preview.deleteFiles,
            isGitRepo: plan.preview.isGitRepo,
            previousStatus: record.status,
            ...(record.endReason === undefined ? {} : { previousEndReason: record.endReason }),
          },
        });
        manifest.rewindSeq = emitted.seq;
        await writeFile(undoPath(sessionDir), JSON.stringify(manifest));

        const next: SessionRecord = {
          ...record,
          rewinds: [...(record.rewinds ?? []), { at: formatKst(new Date()), targetSeq: seq }],
          updatedAt: formatKst(new Date()),
        };
        if (record.status === 'completed') {
          next.status = 'interrupted';
          delete next.endReason;
        }
        await writeSessionRecord(sessionDir, next);
        return {
          eventSeq: emitted.seq,
          text: plan.preview.text,
          restoredFiles: plan.preview.restoreFiles,
          deletedFiles: plan.preview.deleteFiles,
        };
      });
    },

    async undo(sessionId: string): Promise<{ eventSeq: number }> {
      return withStoppedSession(sessionId, async ({ sessionDir, sessionsDir }) => {
        const { record, events } = await readState(sessionDir);
        const rewind = getUndoableRewind(events);
        const manifest = await readFile(undoPath(sessionDir), 'utf8').then(
          (text) => JSON.parse(text) as UndoManifest,
          () => undefined,
        );
        if (rewind === undefined || manifest?.rewindSeq !== rewind.seq) {
          throw new UsageError('취소할 되돌리기가 없습니다.');
        }
        const blocked = await getBlockedReason(sessionId, record, sessionsDir);
        if (blocked !== undefined) throw new UsageError(blocked);

        const operations = manifest.files.map((file) => ({ path: file.path, to: file.current }));
        const lastSeq = events.at(-1)?.seq ?? rewind.seq;
        const previous = await applyOperations(sessionDir, operations);
        await recordOperations(sessionDir, lastSeq, operations, previous);
        const emitted = await emitAndSync(sessionId, sessionDir, events, {
          type: 'rewind_undo',
          payload: { rewindSeq: rewind.seq },
        });

        const now = formatKst(new Date());
        const next: SessionRecord = {
          ...record,
          status: rewind.payload.previousStatus,
          rewinds: (record.rewinds ?? []).map((entry, index, all) =>
            index === all.length - 1 ? { ...entry, undoneAt: now } : entry,
          ),
          updatedAt: now,
        };
        if (rewind.payload.previousEndReason === undefined) delete next.endReason;
        else next.endReason = rewind.payload.previousEndReason;
        await writeSessionRecord(sessionDir, next);
        await rm(undoPath(sessionDir), { force: true });
        return { eventSeq: emitted.seq };
      });
    },

    /** 다음 메시지를 보내면 되돌리기 취소 기록을 버린다. */
    async discardUndo(sessionId: string): Promise<void> {
      const { sessionDir } = await locate(sessionId);
      await rm(undoPath(sessionDir), { force: true });
    },
  };
}
