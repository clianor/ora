import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionStore, TranscriptSink } from '@ora/core';
import { oraEventSchema, sessionRecordSchema, todoSchema } from '@ora/protocol';
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

  const transcript: TranscriptSink = {
    async append(event) {
      const line = `${JSON.stringify(oraEventSchema.parse(event))}\n`;
      const handle = await open(join(sessionDir, 'transcript.jsonl'), 'a');
      try {
        await handle.appendFile(line, 'utf8');
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
  };

  return { transcript, sessions };
}
