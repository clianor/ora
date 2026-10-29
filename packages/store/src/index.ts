import { mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionStore, TranscriptSink } from '@ora/core';
import { oraEventSchema, sessionRecordSchema, todoSchema } from '@ora/protocol';
import type { SessionRecord, Todo } from '@ora/protocol';
import { z } from 'zod';

async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, path);
}

export interface SessionStorage {
  readonly transcript: TranscriptSink;
  readonly sessions: SessionStore;
}

/** 세션 디렉터리 하나의 transcript.jsonl, session.json, todos.json, artifacts/를 다룬다. */
export async function createSessionStorage(sessionDir: string): Promise<SessionStorage> {
  const artifactsDir = join(sessionDir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });

  // 하드 킬로 마지막 줄이 잘렸다면 새 이벤트가 그 줄에 붙지 않도록 첫 쓰기에서 줄을 바꾼다. 파일은 고치지 않는다.
  let checkedTail = false;
  const transcript: TranscriptSink = {
    async append(event) {
      const line = `${JSON.stringify(oraEventSchema.parse(event))}\n`;
      const handle = await open(join(sessionDir, 'transcript.jsonl'), 'a+');
      try {
        let prefix = '';
        if (!checkedTail) {
          const { size } = await handle.stat();
          if (size > 0) {
            const last = Buffer.alloc(1);
            await handle.read(last, 0, 1, size - 1);
            if (last[0] !== 0x0a) prefix = '\n';
          }
          checkedTail = true;
        }
        await handle.appendFile(prefix + line, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
  };

  const sessions: SessionStore = {
    async saveSession(session) {
      const parsed = sessionRecordSchema.parse(session);
      await writeFileAtomic(
        join(sessionDir, 'session.json'),
        `${JSON.stringify(parsed, null, 2)}\n`,
      );
    },
    async saveTodos(todos) {
      const parsed = z.array(todoSchema).parse(todos);
      await writeFileAtomic(join(sessionDir, 'todos.json'), `${JSON.stringify(parsed, null, 2)}\n`);
    },
    async writeArtifact(callId, content) {
      const base = callId.replace(/[^A-Za-z0-9_.-]/g, '_');
      for (let suffix = 1; ; suffix += 1) {
        const ref = `artifacts/${suffix === 1 ? base : `${base}-${suffix}`}.txt`;
        try {
          await writeFile(join(sessionDir, ref), content, { encoding: 'utf8', flag: 'wx' });
          return ref;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
    },
    async writeCompaction(content) {
      await mkdir(join(sessionDir, 'compactions'), { recursive: true });
      for (let number = 1; ; number += 1) {
        const ref = `compactions/${number}.md`;
        let handle;
        try {
          handle = await open(join(sessionDir, ref), 'wx');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw error;
        }
        try {
          await handle.writeFile(content, 'utf8');
          // `compaction` 이벤트가 이 파일을 가리키기 전에 디스크에 반영한다.
          await handle.sync();
        } finally {
          await handle.close();
        }
        return ref;
      }
    },
  };

  return { transcript, sessions };
}

/** 세션 디렉터리의 transcript.jsonl 본문이다. 파일이 없으면 `undefined`다. */
export async function readTranscriptText(sessionDir: string): Promise<string | undefined> {
  return readFile(join(sessionDir, 'transcript.jsonl'), 'utf8').catch(() => undefined);
}

/** session.json을 읽는다. 파일이 없으면 `undefined`이고, 형식이 틀리면 예외를 던진다. */
export async function readSessionRecord(sessionDir: string): Promise<SessionRecord | undefined> {
  const text = await readFile(join(sessionDir, 'session.json'), 'utf8').catch(() => undefined);
  return text === undefined ? undefined : sessionRecordSchema.parse(JSON.parse(text));
}

export async function readTodos(sessionDir: string): Promise<Todo[]> {
  const text = await readFile(join(sessionDir, 'todos.json'), 'utf8').catch(() => undefined);
  return text === undefined ? [] : z.array(todoSchema).parse(JSON.parse(text));
}

/** 세션 기록 목록이다. 최근에 만든 세션이 앞에 온다. session.json이 없거나 깨진 디렉터리는 건너뛴다. */
export async function listSessionRecords(sessionsDir: string): Promise<SessionRecord[]> {
  const names = await readdir(sessionsDir).catch(() => []);
  const records = await Promise.all(
    names.map((name) => readSessionRecord(join(sessionsDir, name)).catch(() => undefined)),
  );
  return records
    .filter((record) => record !== undefined)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function writeSessionRecord(
  sessionDir: string,
  session: SessionRecord,
): Promise<void> {
  await writeFileAtomic(
    join(sessionDir, 'session.json'),
    `${JSON.stringify(sessionRecordSchema.parse(session), null, 2)}\n`,
  );
}
