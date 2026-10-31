import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { appendFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createRecorder, formatKst, parseTranscript, planRecovery } from '@ora/core';
import type { StopCause } from '@ora/core';
import type { OraEvent, SessionRecord } from '@ora/protocol';
import {
  createSessionStorage,
  readSessionRecordOrWarn,
  readTranscriptText,
  writeSessionRecord,
} from '@ora/store';
import { ENGINE_VERSION } from './config.ts';

/** 워커가 실행 중인 셸의 PID를 적는 파일이다. 한 줄에 PID 하나다. */
export const SHELL_PIDS_FILE = 'shells.pid';

/** 셸이 끝난 뒤에도 살아남은 프로세스를 `pid|시작 시각` 한 줄로 적는 파일이다. */
const SURVIVORS_FILE = 'survivors.pid';

/**
 * 세션 셸이 끝난 직후, 그 셸의 프로세스 그룹에 남은 프로세스를 세션 폴더에 적는다. `nohup sleep &`처럼 SIP 보호 실행 파일은
 * 셸이 끝나면 환경변수 표지를 읽을 수 없으므로, 호스트가 이 기록으로 Ora 프로세스임을 안다.
 * ponytail: 파일은 줄어들지 않는다. 호스트는 시작 시각이 맞는 줄만 쓰므로 오래된 줄은 무해하다.
 */
export async function recordSurvivors(sessionDir: string, shellPid: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<string>();
  execFile('/bin/ps', ['-axo', 'pid=,pgid=,lstart='], { timeout: 5000 }, (_error, stdout) => {
    resolve(stdout);
  });
  const lines: string[] = [];
  for (const line of (await promise).split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match?.[2] === String(shellPid)) {
      lines.push(`${match[1] ?? ''}|${(match[3] ?? '').replace(/\s+/g, ' ')}`);
    }
  }
  if (lines.length > 0) await appendFile(join(sessionDir, SURVIVORS_FILE), `${lines.join('\n')}\n`);
}

/** 모든 세션 폴더의 생존 기록을 `pid|시작 시각` 집합으로 읽는다. */
export async function readSurvivors(sessionsDir: string): Promise<Set<string>> {
  const keys = new Set<string>();
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch {
    return keys;
  }
  for (const name of names) {
    try {
      const text = await readFile(join(sessionsDir, name, SURVIVORS_FILE), 'utf8');
      for (const line of text.split('\n')) if (line !== '') keys.add(line);
    } catch {
      // 기록이 없는 세션이다.
    }
  }
  return keys;
}

/**
 * 워커가 남긴 셸 프로세스 그룹을 모두 종료한다. 워커가 SIGKILL을 맞거나 응답하지 않아 호스트가 종료한 뒤에도
 * 셸은 다른 프로세스 그룹이라 살아남기 때문이다.
 * ponytail: 파일의 PID가 셸이 끝난 뒤 다른 프로세스에 재사용되는 경우는 막지 않는다. 워커가 셸이 끝날 때마다 PID를 지운다.
 */
export async function killOrphanShells(sessionDir: string): Promise<void> {
  const path = join(sessionDir, SHELL_PIDS_FILE);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const pid = Number(line);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // 이미 끝난 프로세스 그룹이다.
    }
  }
  await rm(path, { force: true });
}

export interface RecoveryContext {
  readonly sessionId: string;
  /** 세션이 시작 기록을 남기기 전에 죽었을 때 session.json을 만드는 값이다. 설정에서 구한다. */
  readonly fallback: Pick<SessionRecord, 'permissionMode' | 'isolation'>;
}

function createRecord(
  events: readonly OraEvent[],
  context: RecoveryContext,
  end: { status: SessionRecord['status']; endReason: SessionRecord['endReason'] },
  now: string,
): SessionRecord {
  const start = events.find((event) => event.type === 'session_start');
  const firstUser = events.find(
    (event) => event.type === 'message' && event.payload.role === 'user',
  );
  const text =
    firstUser?.type === 'message'
      ? firstUser.payload.content.find((block) => block.type === 'text')
      : undefined;
  return {
    schemaVersion: 1,
    id: context.sessionId,
    createdAt: start?.ts ?? now,
    updatedAt: now,
    title: text?.type === 'text' ? text.text.slice(0, 80) : '(시작하기 전에 끝남)',
    actor: 'user',
    ...end,
    models: [],
    permissionMode:
      start?.type === 'session_start'
        ? start.payload.permissionMode
        : context.fallback.permissionMode,
    isolation:
      start?.type === 'session_start' ? start.payload.isolation : context.fallback.isolation,
    promptHash: start?.type === 'session_start' ? start.payload.promptHash : 'unavailable',
    engineVersion: ENGINE_VERSION,
  };
}

/**
 * 멈춘 세션을 재개할 수 있는 상태로 맞춘다. transcript가 정본이다 (SPEC 4.1.1절).
 * 깨진 마지막 줄은 `recovered`로 남기고, 끝나지 않은 실행은 `crashed`로 봉인한다.
 * 그다음 session.json이 마지막 `session_end`와 다르거나 없으면 transcript에 맞춰 다시 쓴다.
 * 돌려주는 값은 세션이 시작 기록과 첫 사용자 메시지를 남겼는지다. 아니면 재개할 내용이 없다.
 */
export async function recoverSession(
  sessionDir: string,
  context: RecoveryContext,
  cause: StopCause,
): Promise<{ started: boolean }> {
  await killOrphanShells(sessionDir);
  const parsed = parseTranscript((await readTranscriptText(sessionDir)) ?? '');
  const drafts = planRecovery(parsed, cause);
  const clock = { now: () => new Date() };
  if (drafts.length > 0) {
    const storage = await createSessionStorage(sessionDir);
    const recorder = createRecorder(
      context.sessionId,
      storage.transcript,
      clock,
      parsed.events.at(-1)?.seq,
    );
    for (const { actor, draft } of drafts) await recorder.emit(actor, draft);
  }

  const sealed = drafts.find((entry) => entry.draft.type === 'session_end')?.draft;
  const end =
    sealed?.type === 'session_end'
      ? sealed.payload
      : parsed.events.findLast((event) => event.type === 'session_end')?.payload;
  if (end !== undefined) {
    const now = formatKst(clock.now());
    const session = await readSessionRecordOrWarn(sessionDir);
    if (session?.status !== end.status || session.endReason !== end.endReason) {
      const base =
        session ??
        createRecord(parsed.events, context, { status: end.status, endReason: end.endReason }, now);
      await writeSessionRecord(sessionDir, {
        ...base,
        status: end.status,
        endReason: end.endReason,
        updatedAt: now,
      });
    }
  }
  return {
    started:
      parsed.events.some((event) => event.type === 'session_start') &&
      parsed.events.some((event) => event.type === 'message' && event.payload.role === 'user'),
  };
}
