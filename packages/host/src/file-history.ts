import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { CommandRunner } from '@ora/core';

/** 이 크기를 넘는 파일은 내용을 남기지 않고 크기와 수정 시각으로만 비교한다. 되돌릴 수 없는 파일로 알린다. */
const MAX_TRACKED_BYTES = 32 * 1024 * 1024;
const LARGE_PREFIX = 'large:';

/** `sessions/<id>/file-history/log.jsonl`의 한 줄이다. 세션이 파일을 바꿀 때마다 직전 내용(`before`)과 바꾼 뒤 해시(`after`)를 남긴다. `null`은 파일이 없다는 뜻이다. */
export interface HistoryLine {
  /** 이 변경을 기록할 때 transcript의 마지막 seq다. 사용자 메시지의 seq보다 크면 그 메시지 뒤의 변경이다. */
  readonly tag: number;
  readonly ts: string;
  readonly path?: string;
  readonly before?: string | null;
  readonly after?: string | null;
  /** 너무 커서 직전 내용을 남기지 못했다. */
  readonly large?: true;
  /** 이 변경과 함께 세션이 만든 커밋 수다. `path` 없이 이 줄만 있다. */
  readonly commits?: number;
}

export const historyDir = (sessionDir: string) => join(sessionDir, 'file-history');

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

async function putBlob(sessionDir: string, bytes: Buffer): Promise<string> {
  const hash = sha256(bytes);
  const dir = join(historyDir(sessionDir), 'blobs');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, hash), bytes, { flag: 'wx' }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  return hash;
}

function readBlob(sessionDir: string, hash: string): Promise<Buffer> {
  return readFile(join(historyDir(sessionDir), 'blobs', hash));
}

export async function readHistory(sessionDir: string): Promise<HistoryLine[]> {
  const text = await readFile(join(historyDir(sessionDir), 'log.jsonl'), 'utf8').catch(() => '');
  return text.split('\n').flatMap((line) => {
    try {
      return line === '' ? [] : [JSON.parse(line) as HistoryLine];
    } catch {
      return [];
    }
  });
}

export async function appendHistory(sessionDir: string, line: HistoryLine): Promise<void> {
  await mkdir(historyDir(sessionDir), { recursive: true });
  await appendFile(join(historyDir(sessionDir), 'log.jsonl'), `${JSON.stringify(line)}\n`);
}

/** 파일의 해시다. 파일이 없으면 `null`이다. `keep`을 주면 내용을 블롭으로 남긴다. */
export async function describeFile(
  path: string,
  keep?: { sessionDir: string },
): Promise<string | null> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) return null;
  if (info.size > MAX_TRACKED_BYTES) return `${LARGE_PREFIX}${info.size}:${info.mtimeMs}`;
  const bytes = await readFile(path).catch(() => undefined);
  if (bytes === undefined) return null;
  return keep === undefined ? sha256(bytes) : putBlob(keep.sessionDir, bytes);
}

export const isLargeState = (hash: string | null | undefined): boolean =>
  hash?.startsWith(LARGE_PREFIX) === true;

function git(root: string, args: string[]): Promise<Buffer | undefined> {
  const { promise, resolve } = Promise.withResolvers<Buffer | undefined>();
  execFile(
    'git',
    ['-C', root, '-c', 'status.renames=false', ...args],
    { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
    (error, stdout) => {
      resolve(error === null ? stdout : undefined);
    },
  );
  return promise;
}

interface ShellSnapshot {
  readonly head: string | undefined;
  /** gitignore 대상을 뺀 바뀐 파일과 그 해시다. */
  readonly states: Map<string, string | null>;
}

export interface FileTracker {
  beforeWrite(path: string, before: string | undefined): Promise<void>;
  afterWrite(path: string, after: string): Promise<void>;
  /** 셸 명령 전후의 워크트리를 비교해 바뀐 파일을 기록하는 실행기를 돌려준다. */
  wrapRunner(runner: CommandRunner): CommandRunner;
}

/**
 * 세션이 파일을 바꿀 때마다 직전 내용을 `file-history/`에 남긴다 (SPEC 4.4절). git 저장소 안의 파일만 다룬다.
 * 셸은 명령 전후에 `git status`로 바뀐 파일만 해시하고, 이미 해시한 파일은 stat이 같으면 다시 읽지 않는다.
 */
export function createFileTracker(options: {
  sessionDir: string;
  gitRoot: string;
  currentSeq: () => number;
  now: () => string;
}): FileTracker {
  const { sessionDir, gitRoot } = options;
  const statCache = new Map<string, { mtimeMs: number; size: number; hash: string | null }>();
  const pending = new Map<string, string | null>();
  let warned = false;

  const isInside = (path: string) => {
    const rel = relative(gitRoot, path);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  };
  const record = (line: Omit<HistoryLine, 'tag' | 'ts'>) =>
    appendHistory(sessionDir, { tag: options.currentSeq(), ts: options.now(), ...line });

  /** 파일 상태의 해시다. 내용은 블롭으로 남긴다. */
  const stateOf = async (rel: string): Promise<string | null> => {
    const path = join(gitRoot, rel);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) return null;
    const cached = statCache.get(path);
    if (cached?.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.hash;
    const hash = await describeFile(path, { sessionDir });
    statCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, hash });
    return hash;
  };

  const snapshot = async (): Promise<ShellSnapshot> => {
    const head = (await git(gitRoot, ['rev-parse', '--verify', '-q', 'HEAD']))?.toString().trim();
    const status = await git(gitRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (status === undefined) throw new Error('git status를 실행하지 못했습니다.');
    const states = new Map<string, string | null>();
    for (const entry of status.toString('utf8').split('\0')) {
      if (entry.length > 3) states.set(entry.slice(3), await stateOf(entry.slice(3)));
    }
    return { head: head === '' ? undefined : head, states };
  };

  const headBlob = async (head: string | undefined, rel: string): Promise<string | null> => {
    if (head === undefined) return null;
    const bytes = await git(gitRoot, ['show', `${head}:${rel}`]);
    return bytes === undefined ? null : putBlob(sessionDir, bytes);
  };

  const compare = async (before: ShellSnapshot) => {
    const after = await snapshot();
    const paths = new Set([...before.states.keys(), ...after.states.keys()]);
    if (before.head !== undefined && after.head !== undefined && before.head !== after.head) {
      const names = await git(gitRoot, ['diff', '--name-only', '-z', before.head, after.head]);
      for (const name of names?.toString('utf8').split('\0') ?? [])
        if (name !== '') paths.add(name);
      const forward = await git(gitRoot, ['merge-base', '--is-ancestor', before.head, after.head]);
      const count = Number(
        (await git(gitRoot, ['rev-list', '--count', `${before.head}..${after.head}`]))?.toString(),
      );
      if (forward !== undefined && count > 0) await record({ commits: count });
    }
    for (const rel of paths) {
      const current = after.states.get(rel) ?? (await stateOf(rel));
      const previous = before.states.has(rel)
        ? (before.states.get(rel) ?? null)
        : await headBlob(before.head, rel);
      if (previous === current) continue;
      await record({
        path: join(gitRoot, rel),
        after: current,
        ...(isLargeState(previous) ? { large: true as const } : { before: previous }),
      });
    }
  };

  return {
    async beforeWrite(path, before) {
      if (!isInside(path)) return;
      pending.set(
        path,
        before === undefined ? null : await putBlob(sessionDir, Buffer.from(before)),
      );
    },
    async afterWrite(path, after) {
      const before = pending.get(path);
      if (before === undefined) return;
      pending.delete(path);
      await record({ path, before, after: sha256(after) });
    },
    wrapRunner(runner) {
      return {
        async run(request) {
          const before = await snapshot().catch((error: unknown) => {
            if (!warned) {
              warned = true;
              process.stderr.write(
                `경고: 셸이 바꾸는 파일을 기록하지 못합니다: ${String(error)}\n`,
              );
            }
            return undefined;
          });
          const result = await runner.run(request);
          if (before !== undefined) await compare(before).catch(() => undefined);
          return result;
        },
      };
    },
  };
}

/** 파일을 쓰거나(`hash`가 있음) 지운다(`null`). 위쪽 폴더가 없으면 만든다. */
export async function applyFileState(
  sessionDir: string,
  path: string,
  hash: string | null,
): Promise<void> {
  if (hash === null) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, await readBlob(sessionDir, hash));
}
