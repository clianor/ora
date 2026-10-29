import { createHash } from 'node:crypto';
import { chmod, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { defineTool } from '@ora/core';
import type { CommandRunner, Tool } from '@ora/core';
import { z } from 'zod';

export { createCommandRunner } from './command-runner.ts';
export type { CommandRunnerHooks } from './command-runner.ts';

export interface BuiltinToolOptions {
  readonly runner: CommandRunner;
  readonly shellTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxFileBytes: number;
  /** `file_write`·`file_edit`이 쓰지 못하는 파일과 디렉터리다 (SPEC 5.7절). 디렉터리는 안쪽 전체를 막는다. */
  readonly protectedPaths: readonly string[];
  /** 읽기와 쓰기를 모두 막는 파일이다. 모델 프로바이더 토큰을 담은 `<oraHome>/auth.json`이 여기에 든다 (SPEC 5.2절). */
  readonly secretPaths: readonly string[];
  /** 이 세션의 디렉터리다. `history.read`는 이 안의 `transcript.jsonl`과 `artifacts/`만 읽는다. */
  readonly sessionDir: string;
  /** `file_write`·`file_edit`이 파일을 쓰기 직전에 부른다. 새 파일이면 `before`가 `undefined`다. */
  readonly onBeforeWrite?: (path: string, before: string | undefined) => Promise<void>;
}

const FORBIDDEN_SEGMENTS = ['.ssh', '.aws'];

function matchesForbiddenName(path: string): boolean {
  const name = basename(path);
  return (
    name === '.env' ||
    name.startsWith('.env.') ||
    name.endsWith('.pem') ||
    name.endsWith('.key') ||
    path.split(sep).some((segment) => FORBIDDEN_SEGMENTS.includes(segment))
  );
}

async function isForbiddenPath(path: string): Promise<boolean> {
  const real = await realpath(path).catch(() => path);
  return matchesForbiddenName(path) || matchesForbiddenName(real);
}

/** 아직 없는 경로는 가장 가까운 기존 조상을 `realpath`로 풀고 나머지를 다시 붙인다. 링크 폴더 안의 새 파일도 실제 위치로 비교하려는 것이다. */
async function resolveThroughSymlinks(path: string): Promise<string> {
  const rest: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    try {
      return join(await realpath(current), ...rest.reverse());
    } catch {
      if (dirname(current) === current) return path;
      rest.push(basename(current));
    }
  }
}

/** macOS와 Windows의 기본 파일시스템은 대소문자를 구분하지 않으므로 그 플랫폼에서는 소문자로 맞춰 비교한다. */
function foldCase(path: string): string {
  return process.platform === 'darwin' || process.platform === 'win32' ? path.toLowerCase() : path;
}

function hashContent(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** 앞부분과 뒷부분만 남기고 가운데를 자른다. */
function truncateMiddle(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  const half = Math.floor(maxBytes / 2);
  const head = bytes.subarray(0, half).toString('utf8');
  const tail = bytes.subarray(bytes.length - half).toString('utf8');
  return `${head}\n[... 가운데 ${bytes.length - 2 * half}바이트를 잘랐습니다 ...]\n${tail}`;
}

/** 공통 접두·접미 줄을 뺀 단순 diff다. 최소 diff는 아니다. */
function simpleDiff(path: string, before: string, after: string): string {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start += 1;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const removed = oldLines.slice(start, oldEnd).map((line) => `-${line}`);
  const added = newLines.slice(start, newEnd).map((line) => `+${line}`);
  return [`--- ${path}`, `@@ line ${start + 1} @@`, ...removed, ...added].join('\n');
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const target = await realpath(path).catch(() => path);
  const mode = (await stat(target).catch(() => undefined))?.mode;
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, content, 'utf8');
    if (mode !== undefined) await chmod(temporary, mode & 0o7777);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

interface HistoryBlock {
  type?: string;
  text?: string;
  callId?: string;
  tool?: string;
  input?: unknown;
}

interface HistoryEvent {
  seq: number;
  type: string;
  payload?: { role?: string; content?: HistoryBlock[]; callId?: string; outputRef?: string };
}

function renderHistoryBlocks(event: HistoryEvent): string {
  return (event.payload?.content ?? [])
    .flatMap((block) => {
      if (block.type === 'text') return [block.text ?? ''];
      if (block.type === 'tool_use')
        return [`[도구 호출 ${block.tool} ${JSON.stringify(block.input)}]`];
      if (block.type === 'tool_result') return [`[도구 결과 ${block.callId}]\n${block.text ?? ''}`];
      return [];
    })
    .join('\n');
}
export function createBuiltinTools(options: BuiltinToolOptions): Tool[] {
  const isUnder = async (roots: readonly string[], path: string): Promise<boolean> => {
    const guarded = await Promise.all(roots.map(resolveThroughSymlinks));
    const candidates = [path, await resolveThroughSymlinks(path)].map(foldCase);
    return guarded
      .map(foldCase)
      .some((root) =>
        candidates.some((candidate) => candidate === root || candidate.startsWith(root + sep)),
      );
  };
  const isProtectedPath = (path: string) => isUnder(options.protectedPaths, path);
  const isSecretPath = (path: string) => isUnder(options.secretPaths, path);

  // file_edit이 읽은 뒤 바뀐 파일을 거부하도록 마지막으로 본 내용의 해시를 기억한다.
  const seenHashes = new Map<string, string>();

  const shell = defineTool({
    name: 'shell',
    description: '셸 명령을 실행한다. 종료 코드가 0이 아니어도 도구 오류가 아니라 결과다.',
    tier: 'exec',
    inputSchema: z.object({
      command: z.string().min(1),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().positive().optional(),
    }),
    async run(input, context) {
      const result = await options.runner.run({
        command: input.command,
        cwd: resolve(context.cwd, input.cwd ?? '.'),
        timeoutMs: input.timeoutMs ?? options.shellTimeoutMs,
        signal: context.signal,
      });
      const status = result.timedOut ? 'timeout' : `exit code: ${result.exitCode ?? 'signal'}`;
      const full = `${status}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
      return {
        status: result.timedOut ? 'timeout' : 'ok',
        text: truncateMiddle(full, options.maxOutputBytes),
        fullOutput: full,
      };
    },
  });

  const fileRead = defineTool({
    name: 'file_read',
    description: '파일을 줄 번호와 함께 읽는다. offset은 1부터 시작하는 줄 번호다.',
    tier: 'read',
    inputSchema: z.object({
      path: z.string().min(1),
      offset: z.number().int().positive().optional(),
      limit: z.number().int().positive().optional(),
    }),
    async run(input, context) {
      const path = resolve(context.cwd, input.path);
      if ((await isForbiddenPath(path)) || (await isSecretPath(path)))
        return { status: 'error', text: `금지 구역입니다: ${input.path}` };
      if ((await stat(path)).size > options.maxFileBytes) {
        return { status: 'error', text: `파일이 ${options.maxFileBytes}바이트를 넘습니다.` };
      }
      const bytes = await readFile(path);
      if (bytes.includes(0)) return { status: 'error', text: '바이너리 파일은 읽지 않습니다.' };
      seenHashes.set(path, hashContent(bytes));
      const first = input.offset ?? 1;
      const lines = bytes
        .toString('utf8')
        .split('\n')
        .slice(first - 1, input.limit === undefined ? undefined : first - 1 + input.limit);
      return {
        status: 'ok',
        text: lines.map((line, index) => `${first + index}\t${line}`).join('\n'),
      };
    },
  });

  const fileWrite = defineTool({
    name: 'file_write',
    description: '파일을 새로 만들거나 전체를 바꾼다. 임시 파일에 쓴 뒤 이름을 바꿔 적용한다.',
    tier: 'write',
    inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
    async run(input, context) {
      const path = resolve(context.cwd, input.path);
      if ((await isForbiddenPath(path)) || (await isSecretPath(path)))
        return { status: 'error', text: `금지 구역입니다: ${input.path}` };
      if (await isProtectedPath(path))
        return { status: 'error', text: `엔진이 관리하는 파일이라 쓸 수 없습니다: ${input.path}` };
      const before = await readFile(path, 'utf8').catch(() => undefined);
      await options.onBeforeWrite?.(path, before);
      await writeAtomic(path, input.content);
      seenHashes.set(path, hashContent(input.content));
      const bytes = Buffer.byteLength(input.content, 'utf8');
      const diff = before === undefined ? '' : `\n${simpleDiff(input.path, before, input.content)}`;
      return { status: 'ok', text: `${bytes}바이트를 썼습니다.${diff}` };
    },
  });

  const fileEdit = defineTool({
    name: 'file_edit',
    description:
      '파일에서 oldText가 정확히 한 곳과 일치할 때 newText로 바꾼다. 먼저 file_read로 읽어야 하고, 읽은 뒤 파일이 바뀌었으면 거부한다.',
    tier: 'write',
    inputSchema: z.object({
      path: z.string().min(1),
      oldText: z.string().min(1),
      newText: z.string(),
    }),
    async run(input, context) {
      const path = resolve(context.cwd, input.path);
      if ((await isForbiddenPath(path)) || (await isSecretPath(path)))
        return { status: 'error', text: `금지 구역입니다: ${input.path}` };
      if (await isProtectedPath(path))
        return { status: 'error', text: `엔진이 관리하는 파일이라 쓸 수 없습니다: ${input.path}` };
      const seen = seenHashes.get(path);
      if (seen === undefined)
        return { status: 'error', text: '먼저 file_read로 파일을 읽어야 합니다.' };
      const before = await readFile(path, 'utf8');
      if (hashContent(before) !== seen) {
        return { status: 'error', text: '읽은 뒤 파일이 바뀌었습니다. file_read로 다시 읽습니다.' };
      }
      const matches = before.split(input.oldText).length - 1;
      if (matches !== 1) {
        return {
          status: 'error',
          text: `oldText의 일치가 ${matches}곳입니다. 정확히 한 곳이어야 합니다.`,
        };
      }
      await options.onBeforeWrite?.(path, before);
      const after = before.replace(input.oldText, () => input.newText);
      await writeAtomic(path, after);
      seenHashes.set(path, hashContent(after));
      return { status: 'ok', text: simpleDiff(input.path, before, after) };
    },
  });

  const historyRead = defineTool({
    name: 'history.read',
    description:
      '압축이나 가지치기로 컨텍스트에서 빠진 원문을 다시 읽는다. 도구 호출 ID(callId)나 message seq 범위(fromSeq, toSeq) 중 하나를 준다. 이 세션의 기록만 읽는다.',
    tier: 'read',
    inputSchema: z.object({
      callId: z.string().min(1).optional(),
      fromSeq: z.number().int().positive().optional(),
      toSeq: z.number().int().positive().optional(),
    }),
    async run(input) {
      const hasRange = input.fromSeq !== undefined && input.toSeq !== undefined;
      if ((input.callId === undefined) === !hasRange) {
        return { status: 'error', text: 'callId 하나나 fromSeq와 toSeq 둘 중 하나만 줍니다.' };
      }
      const raw = await readFile(join(options.sessionDir, 'transcript.jsonl'), 'utf8').catch(
        () => undefined,
      );
      if (raw === undefined) return { status: 'error', text: '이 세션의 기록을 읽을 수 없습니다.' };
      const events = raw.split('\n').flatMap((line) => {
        try {
          return [JSON.parse(line) as HistoryEvent];
        } catch {
          return [];
        }
      });
      if (input.callId !== undefined) {
        const text = await readCallOutput(events, input.callId);
        if (text === undefined) {
          return {
            status: 'error',
            text: `이 세션에서 호출 ID를 찾을 수 없습니다: ${input.callId}`,
          };
        }
        return { status: 'ok', text: truncateMiddle(text, options.maxOutputBytes) };
      }
      const from = input.fromSeq ?? 0;
      const to = input.toSeq ?? 0;
      const text = events
        .filter((event) => event.type === 'message' && event.seq >= from && event.seq <= to)
        .map((event) => `[seq ${event.seq} ${event.payload?.role}]\n${renderHistoryBlocks(event)}`)
        .join('\n\n');
      if (text === '') return { status: 'error', text: `seq ${from}~${to}에 message가 없습니다.` };
      return { status: 'ok', text: truncateMiddle(text, options.maxOutputBytes) };
    },
  });

  /** 도구 호출의 원문 출력이다. 전체 출력을 artifact로 남겼으면 그 파일을 읽는다. */
  async function readCallOutput(
    events: readonly HistoryEvent[],
    callId: string,
  ): Promise<string | undefined> {
    const outputRef = events.find(
      (event) => event.type === 'tool_result' && event.payload?.callId === callId,
    )?.payload?.outputRef;
    if (outputRef !== undefined && /^artifacts\/[A-Za-z0-9_.-]+\.txt$/.test(outputRef)) {
      const full = await readFile(join(options.sessionDir, outputRef), 'utf8').catch(
        () => undefined,
      );
      if (full !== undefined) return full;
    }
    for (const event of events) {
      if (event.type !== 'message') continue;
      const block = event.payload?.content?.find(
        (candidate) => candidate.type === 'tool_result' && candidate.callId === callId,
      );
      if (block !== undefined) return block.text ?? '';
    }
    return undefined;
  }
  return [shell, fileRead, fileWrite, fileEdit, historyRead];
}
