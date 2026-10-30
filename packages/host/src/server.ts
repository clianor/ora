import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import {
  BUILTIN_MODELS,
  createAccountStore,
  createCatalog,
  withFileLock,
  writeFileAtomic,
} from '@ora/adapters';
import {
  answerBodySchema,
  approvalBodySchema,
  cancelBodySchema,
  createSessionBodySchema,
  createTerminalBodySchema,
  messageBodySchema,
  oraEventSchema,
  resumeSessionBodySchema,
  sessionIdSchema,
  sseEventNames,
  terminalIdSchema,
  terminalInputBodySchema,
  terminalResizeBodySchema,
  terminalSseEventNames,
  putTabsBodySchema,
  tabsFileSchema,
  tabsQuerySchema,
  todoActionBodySchema,
} from '@ora/protocol';
import {
  accountProviderSchema,
  addApiKeyBodySchema,
  costSettingsSchema,
  mcpServerAddBodySchema,
  mcpServerPatchBodySchema,
  setPriorityBodySchema,
  startLoginBodySchema,
} from '@ora/protocol';
import type {
  ApprovalRequest,
  BranchResponse,
  ChangesResponse,
  TabsFile,
  InfoResponse,
  Isolation,
  OraEvent,
  PendingApproval,
  PendingQuestion,
  QuestionRequest,
  RoutingResponse,
  SessionDetailResponse,
} from '@ora/protocol';
import { readSessionRecordOrWarn, readTodos, readTranscriptText } from '@ora/store';
import { z } from 'zod';
import { UsageError, loadConfig, resolveChains, resolveSessionsDir } from './config.ts';
import { resolveOraHome } from './isolation/ora-home.ts';
import { applyTodoActionToStoppedSession, launchSession, listSessions } from './supervisor.ts';
import type { UserTodoAction } from '@ora/core';
import type { LaunchRequest, SessionHandle } from './supervisor.ts';
import { AccountApiError, createAccountApi } from './account-api.ts';
import { createCostApi } from './cost-api.ts';
import { createMcpApi } from './mcp-api.ts';
import { createMemoryApi } from './memory-api.ts';
import { createSkillsApi } from './skills-api.ts';
import { createTerminalManager } from './terminal.ts';

const COOKIE_NAME = 'ora_token';
/** 호스트가 전체 패스 실행 조건을 확인하는 간격이다. 하루 한 번, 새 메모리 20개 조건은 이 간격마다 본다. */
const MEMORY_TICK_MS = 10 * 60_000;
const MAX_BODY_BYTES = 1_048_576;
const HEARTBEAT_MS = 15_000;
const BIND_HOST = '127.0.0.1';
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export interface LocalServerOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly configPath?: string;
  /** 새 세션과 재개의 기본 작업 폴더다. */
  readonly cwd: string;
  /** 없으면 설정의 실제 모델을 쓴다. */
  readonly modelScriptPath?: string;
  /** `--isolation` 플래그 값이다. 새 세션은 설정 기본값보다 이 값을 앞세운다. */
  readonly isolation?: Isolation;
  /** 정적 웹 결과물 디렉터리다. 없으면 API만 제공한다. */
  readonly webDir?: string;
  /** 생략하면 운영체제가 빈 포트를 고른다. */
  readonly port?: number;
  /** 사용량 조회, 토큰 갱신, 로그인에 쓰는 fetch다. 테스트가 가짜 서버로 바꿔 끼운다. */
  readonly fetch?: typeof fetch;
  /** Claude와 Codex 로그인 콜백 서버의 포트다. 생략하면 각 프로바이더의 기본 포트다. */
  readonly loginPort?: number;
}

export interface LocalServer {
  /** 토큰이 든 시작 URL이다. 브라우저가 이 주소를 열면 쿠키로 옮기고 토큰 없는 주소로 이동한다. */
  readonly startUrl: string;
  readonly origin: string;
  readonly port: number;
  close(): Promise<void>;
}

interface LiveSession {
  readonly handle: SessionHandle;
  readonly approvals: Map<string, ApprovalRequest>;
  readonly questions: Map<string, QuestionRequest>;
}

interface Subscriber {
  send(name: string | undefined, data: unknown, id?: number): void;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** `cwd`가 git 저장소이고 브랜치 위에 있으면 브랜치 이름을 돌려준다. 저장소가 아니거나 detached HEAD면 `undefined`다. */
function readBranch(cwd: string): Promise<string | undefined> {
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  execFile('git', ['-C', cwd, 'symbolic-ref', '--short', '-q', 'HEAD'], (error, stdout) => {
    const name = stdout.trim();
    resolve(error !== null || name === '' ? undefined : name);
  });
  return promise;
}

/** git 출력 전체를 돌려준다. 명령이 실패하면 `undefined`다. -z 출력의 NUL을 지키려고 trim하지 않는다. */
function runGit(cwd: string, args: string[]): Promise<string | undefined> {
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  execFile('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
    resolve(error === null ? stdout : undefined);
  });
  return promise;
}

/** `origin/HEAD`가 가리키는 브랜치, 없으면 로컬 `main`, `master` 순으로 기본 브랜치를 찾는다. 찾지 못하면 `undefined`다. */
async function readDefaultBranch(cwd: string): Promise<string | undefined> {
  const remote = (
    await runGit(cwd, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])
  )?.trim();
  if (remote) return remote.replace(/^origin\//, '');
  for (const name of ['main', 'master']) {
    if ((await runGit(cwd, ['rev-parse', '--verify', '-q', `refs/heads/${name}`])) !== undefined)
      return name;
  }
  return undefined;
}

/** HEAD 기준으로 바뀐 파일과 추적하지 않는 파일의 증감 줄 수를 모은다. 바이너리 파일은 0줄로 센다. */
async function readChanges(cwd: string): Promise<ChangesResponse> {
  if ((await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])) === undefined) {
    return { isRepo: false, files: [] };
  }
  const files: ChangesResponse['files'] = [];
  const numstat = (await runGit(cwd, ['diff', '--numstat', '-z', 'HEAD'])) ?? '';
  const fields = numstat.split('\0');
  for (let index = 0; index < fields.length; index += 1) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(fields[index] ?? '');
    if (match === null) continue;
    const [, add, del, path] = match;
    // 이름을 바꾼 파일은 경로 칸이 비고 뒤에 이전 경로, 새 경로가 이어진다.
    const target = path === '' ? fields[index + 2] : path;
    if (path === '') index += 2;
    if (target === undefined) continue;
    files.push({
      path: target,
      add: add === '-' ? 0 : Number(add),
      del: del === '-' ? 0 : Number(del),
    });
  }
  const untracked = (
    (await runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])) ?? ''
  )
    .split('\0')
    .filter((path) => path !== '');
  for (const path of untracked) {
    const bytes = await readFile(join(cwd, path)).catch(() => undefined);
    const isText = bytes !== undefined && !bytes.includes(0);
    const lines = isText
      ? bytes.toString('utf8').split('\n').length - (bytes.at(-1) === 0x0a ? 1 : 0)
      : 0;
    files.push({ path, add: bytes?.length === 0 ? 0 : lines, del: 0 });
  }
  return { isRepo: true, files };
}

/** 워크트리 키로 쓰는 경로의 단일 정규화 지점이다. `/tmp` 같은 심볼릭 링크를 풀어 한 폴더가 한 워크트리가 되게 하고, 풀지 못하면 받은 경로를 쓴다. */
const canonicalPath = (path: string): Promise<string> => realpath(path).catch(() => path);

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}

function reply(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'Content-Type은 application/json이어야 합니다.');
  }
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    throw new HttpError(413, '요청 본문이 너무 큽니다.');
  }
  const body = Promise.withResolvers<Buffer>();
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      chunks.length = 0;
      body.reject(new HttpError(413, '요청 본문이 너무 큽니다.'));
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    body.resolve(Buffer.concat(chunks));
  });
  req.on('error', body.reject);
  try {
    return JSON.parse((await body.promise).toString('utf8'));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, '요청 본문이 JSON이 아닙니다.');
  }
}

function parseBody<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
  return parsed.data;
}

/** 로컬 서버를 띄운다. 127.0.0.1에만 바인딩하고 토큰·Host·Origin을 검사한다 (SPEC 2.6.2절). */
export async function startLocalServer(options: LocalServerOptions): Promise<LocalServer> {
  const oraHome = resolveOraHome(options.env);
  const config = await loadConfig(options.configPath, oraHome);
  resolveChains(config, { scripted: options.modelScriptPath !== undefined });
  const sessionsDir = resolveSessionsDir(config, oraHome);
  const catalogOf = createCatalog(config.models);
  const token = randomBytes(32).toString('hex');
  const webRoot = options.webDir === undefined ? undefined : resolve(options.webDir);
  const modelArgs =
    options.modelScriptPath === undefined ? {} : { modelScriptPath: options.modelScriptPath };
  const configArgs = options.configPath === undefined ? {} : { configPath: options.configPath };
  const isolationArgs = options.isolation === undefined ? {} : { isolation: options.isolation };

  const live = new Map<string, LiveSession>();
  const subscribers = new Map<string, Set<Subscriber>>();
  const openStreams = new Set<ServerResponse>();
  // 실행 중인 세션에 보낸 조향 메시지다. 워커가 끝나면 모아서 한 번에 재개한다.
  const steers = new Map<string, string[]>();
  // 재개를 시작하는 중이라 아직 `live`에 들지 않은 세션이다.
  const resuming = new Set<string>();
  let closing = false;
  const accountApi = createAccountApi({
    env: options.env,
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.loginPort === undefined ? {} : { loginPort: options.loginPort }),
    listPinnedAccounts: async () => {
      const records = await Promise.all(
        [...live.keys()].map((id) => readSessionRecordOrWarn(join(sessionsDir, id))),
      );
      return records.flatMap((record) =>
        record?.accountPin === undefined ? [] : [record.accountPin],
      );
    },
  });
  const mcpApi = createMcpApi({
    env: options.env,
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
  });
  const costApi = createCostApi({
    env: options.env,
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
  });
  const skillsApi = createSkillsApi({
    env: options.env,
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
  });
  const memoryApi = createMemoryApi({
    env: options.env,
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.modelScriptPath === undefined ? {} : { modelScriptPath: options.modelScriptPath }),
    hasLiveSession: () => live.size > 0 || resuming.size > 0,
  });
  const tickMemory = () => {
    if (closing) return;
    memoryApi.tick().catch((error: unknown) => {
      process.stderr.write(
        `메모리 다듬기를 건너뜁니다: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  };
  tickMemory();
  const memoryTimer = setInterval(tickMemory, MEMORY_TICK_MS);
  memoryTimer.unref();

  const publish = (sessionId: string, name: string | undefined, data: unknown, id?: number) => {
    for (const subscriber of subscribers.get(sessionId) ?? []) subscriber.send(name, data, id);
  };

  /** 세션 워커를 띄우고 세션 ID를 돌려준다. 시작 전에 실패하면 거부로 끝난다. */
  const startSession = async (request: LaunchRequest): Promise<string> => {
    if (closing) throw new HttpError(503, '서버를 닫는 중입니다.');
    const entry: { live?: LiveSession; sessionId?: string } = {};
    const approvals = new Map<string, ApprovalRequest>();
    const questions = new Map<string, QuestionRequest>();
    const handle = launchSession({
      request: { ...request, interactive: true },
      env: options.env,
      onEvent: (event: OraEvent) => {
        publish(event.sessionId, undefined, event, event.seq);
      },
      onApprovalRequest: (requestId, approval) => {
        approvals.set(requestId, approval);
        if (entry.sessionId !== undefined) {
          publish(entry.sessionId, sseEventNames.approvalRequest, { requestId, request: approval });
        }
      },
      onRequestWithdrawn: (requestId) => {
        approvals.delete(requestId);
        questions.delete(requestId);
        if (entry.sessionId !== undefined) {
          publish(entry.sessionId, sseEventNames.requestResolved, { requestId });
        }
      },
      onQuestionRequest: (requestId, question) => {
        questions.set(requestId, question);
        if (entry.sessionId !== undefined) {
          publish(entry.sessionId, sseEventNames.questionRequest, { requestId, request: question });
        }
      },
    });
    const sessionId = await Promise.race([
      handle.sessionId,
      handle.result.then((result) => result.sessionId),
    ]);
    if (live.has(sessionId)) {
      handle.cancel('hard');
      throw new HttpError(409, `세션이 이미 실행 중입니다: ${sessionId}`);
    }
    entry.sessionId = sessionId;
    live.set(sessionId, { handle, approvals, questions });
    handle.result
      .finally(() => {
        live.delete(sessionId);
        for (const requestId of [...approvals.keys(), ...questions.keys()]) {
          publish(sessionId, sseEventNames.requestResolved, { requestId });
        }
        drainSteers(sessionId);
      })
      .catch(() => undefined);
    return sessionId;
  };

  const resumeRequest = (id: string, steer?: string): LaunchRequest => ({
    type: 'resumeSession',
    sessionId: id,
    cwd: options.cwd,
    ...modelArgs,
    ...isolationArgs,
    ...configArgs,
    ...(steer === undefined ? {} : { steer }),
  });

  const resumeWith = async (id: string, text: string) => {
    resuming.add(id);
    try {
      await startSession(resumeRequest(id, text));
    } finally {
      resuming.delete(id);
    }
    // 재개하는 동안 쌓인 메시지가 있으면 새 워커를 멈춰 다음 재개로 넘긴다.
    if ((steers.get(id)?.length ?? 0) > 0) live.get(id)?.handle.cancel('soft');
  };

  /** 워커가 끝난 세션에 쌓인 조향 메시지를 한 번에 재개한다. 실패하면 SSE로 알리고 메시지를 돌려준다. */
  function drainSteers(id: string) {
    const texts = steers.get(id);
    steers.delete(id);
    if (texts === undefined || texts.length === 0 || closing) return;
    resumeWith(id, texts.join('\n')).catch((error: unknown) => {
      publish(id, sseEventNames.steerFailed, {
        error: error instanceof Error ? error.message : String(error),
        texts,
      });
    });
  }

  const sessionDirOf = (rawId: string): string => {
    const parsed = sessionIdSchema.safeParse(rawId);
    if (!parsed.success) throw new HttpError(404, '세션 ID 형식이 틀립니다.');
    return join(sessionsDir, parsed.data);
  };

  const requireLive = (id: string): LiveSession => {
    const session = live.get(id);
    if (session === undefined)
      throw new HttpError(409, `이 서버에서 실행 중인 세션이 아닙니다: ${id}`);
    return session;
  };

  const streamEvents = async (id: string, req: IncomingMessage, res: ServerResponse) => {
    const sessionDir = sessionDirOf(id);
    const recorded = await stat(join(sessionDir, 'transcript.jsonl')).catch(() => undefined);
    if (recorded === undefined && !live.has(id)) throw new HttpError(404, `세션이 없습니다: ${id}`);
    const isGone = () => req.destroyed;
    if (isGone()) return;

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.on('error', () => undefined);
    openStreams.add(res);

    const resumeFrom = Number.parseInt(String(req.headers['last-event-id'] ?? ''), 10);
    let lastSeq = Number.isNaN(resumeFrom) ? 0 : Math.max(0, resumeFrom);
    let replaying = true;
    const buffered: Parameters<Subscriber['send']>[] = [];
    const sentRequests = new Set<string>();
    const deliver: Subscriber['send'] = (name, data, seq) => {
      if (name === undefined) {
        if (seq === undefined || seq <= lastSeq) return;
        lastSeq = seq;
      } else if (name === sseEventNames.approvalRequest || name === sseEventNames.questionRequest) {
        const { requestId } = z.object({ requestId: z.string() }).parse(data);
        if (sentRequests.has(requestId)) return;
        sentRequests.add(requestId);
      }
      res.write(
        `${seq === undefined ? '' : `id: ${seq}\n`}${name === undefined ? '' : `event: ${name}\n`}data: ${JSON.stringify(data)}\n\n`,
      );
    };
    // 구독을 먼저 등록해야 transcript를 읽는 동안 도착한 실시간 이벤트가 버퍼에 남는다.
    const subscriber: Subscriber = {
      send: (...args) => {
        if (replaying) buffered.push(args);
        else deliver(...args);
      },
    };
    const set = subscribers.get(id) ?? new Set<Subscriber>();
    set.add(subscriber);
    subscribers.set(id, set);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    heartbeat.unref();
    const cleanup = () => {
      clearInterval(heartbeat);
      set.delete(subscriber);
      openStreams.delete(res);
    };
    req.on('close', cleanup);
    if (isGone()) {
      cleanup();
      return;
    }

    const transcript = await readTranscriptText(sessionDir);
    if (isGone()) return;
    // 하드 킬로 잘린 마지막 줄은 읽지 않고 건너뛴다.
    for (const line of (transcript ?? '').split('\n')) {
      if (line === '') continue;
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        continue;
      }
      const event = oraEventSchema.safeParse(json);
      if (event.success) deliver(undefined, event.data, event.data.seq);
    }
    replaying = false;
    for (const args of buffered) deliver(...args);
    const session = live.get(id);
    for (const [requestId, request] of session?.approvals ?? []) {
      deliver(sseEventNames.approvalRequest, { requestId, request });
    }
    for (const [requestId, request] of session?.questions ?? []) {
      deliver(sseEventNames.questionRequest, { requestId, request });
    }
  };

  const serveStatic = async (pathname: string, res: ServerResponse) => {
    if (webRoot === undefined)
      throw new HttpError(404, '웹 결과물 디렉터리 없이 API만 제공합니다.');
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, '경로를 해석할 수 없습니다.');
    }
    let file = resolve(webRoot, `.${decoded}`);
    if (file !== webRoot && !file.startsWith(webRoot + sep))
      throw new HttpError(404, '찾을 수 없습니다.');
    const found = await stat(file).catch(() => undefined);
    if (found === undefined || found.isDirectory()) {
      if (extname(decoded) !== '' && found === undefined)
        throw new HttpError(404, '찾을 수 없습니다.');
      file = join(webRoot, 'index.html');
    }
    const body = await readFile(file).catch(() => {
      throw new HttpError(404, '찾을 수 없습니다.');
    });
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  };

  const routeAccounts = async (
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    segments: string[],
  ) => {
    const [, , rawProvider, rawName, action] = segments;
    if (rawProvider === undefined) {
      if (method !== 'GET') throw new HttpError(405, '허용하지 않는 메서드입니다.');
      reply(res, 200, await accountApi.list());
      return;
    }
    const provider = accountProviderSchema.safeParse(rawProvider);
    if (!provider.success)
      throw new HttpError(404, `지원하지 않는 프로바이더입니다: ${rawProvider}`);
    if (rawName === 'login' && action === undefined) {
      if (method === 'GET') {
        const state = accountApi.getLogin(provider.data);
        if (state === undefined) throw new HttpError(404, '진행한 로그인이 없습니다.');
        reply(res, 200, state);
        return;
      }
      if (method !== 'POST') throw new HttpError(405, '허용하지 않는 메서드입니다.');
      const body = parseBody(startLoginBodySchema, await readJson(req));
      reply(res, 201, await accountApi.startLogin(provider.data, body));
      return;
    }
    if (method !== 'POST') throw new HttpError(405, '허용하지 않는 메서드입니다.');
    if (rawName === 'login' && action === 'cancel') {
      reply(res, 200, await accountApi.cancelLogin(provider.data));
      return;
    }
    if (rawName === 'api-key' && action === undefined) {
      const body = parseBody(addApiKeyBodySchema, await readJson(req));
      reply(res, 201, await accountApi.addApiKey(provider.data, body));
      return;
    }
    if (rawName === undefined) throw new HttpError(404, '알 수 없는 API입니다.');
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      throw new HttpError(400, '계정 이름을 해석할 수 없습니다.');
    }
    if (action === 'logout') {
      await accountApi.logout(provider.data, name);
      reply(res, 200, { ok: true });
      return;
    }
    if (action === 'priority') {
      const body = parseBody(setPriorityBodySchema, await readJson(req));
      await accountApi.setPriority(provider.data, name, body.priority);
      reply(res, 200, { ok: true });
      return;
    }
    throw new HttpError(404, '알 수 없는 API입니다.');
  };

  const terminals = createTerminalManager(options.env);

  /** 서버 시작 폴더, 세션 기록의 저장소, 그 저장소들의 git worktree와 그 하위 폴더만 터미널 작업 폴더로 허용한다. */
  const assertKnownWorktree = async (cwd: string) => {
    const real = await realpath(cwd).catch(() => undefined);
    if (real === undefined || !(await stat(real)).isDirectory())
      throw new HttpError(400, `폴더가 없습니다: ${cwd}`);
    const sessions = await listSessions(options.env, options.configPath);
    const roots = new Set([
      options.cwd,
      ...sessions.flatMap((session) => (session.repo === undefined ? [] : [session.repo])),
    ]);
    const worktrees = await Promise.all(
      [...roots].map((root) => {
        const { promise, resolve } = Promise.withResolvers<string[]>();
        execFile('git', ['-C', root, 'worktree', 'list', '--porcelain'], (error, stdout) => {
          resolve(
            error === null
              ? stdout
                  .split('\n')
                  .flatMap((line) => (line.startsWith('worktree ') ? [line.slice(9)] : []))
              : [],
          );
        });
        return promise;
      }),
    );
    const known = [...roots, ...worktrees.flat()];
    for (const root of known) {
      const realRoot = await realpath(root).catch(() => undefined);
      if (realRoot !== undefined && (real === realRoot || real.startsWith(realRoot + sep))) return;
    }
    throw new HttpError(403, `알려진 worktree 밖의 폴더입니다: ${cwd}`);
  };

  const streamTerminal = (id: string, req: IncomingMessage, res: ServerResponse) => {
    if (terminals.get(id) === undefined) throw new HttpError(404, `터미널이 없습니다: ${id}`);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.on('error', () => undefined);
    openStreams.add(res);
    const send = (name: string, data: unknown) => {
      res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const subscription = terminals.subscribe(id, {
      onOutput: (chunk) => {
        send(terminalSseEventNames.output, { data: chunk.toString('base64') });
      },
      onExit: (exitCode) => {
        send(terminalSseEventNames.exit, { exitCode });
        res.end();
      },
    });
    if (subscription === undefined) {
      res.end();
      return;
    }
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    heartbeat.unref();
    req.on('close', () => {
      clearInterval(heartbeat);
      subscription.unsubscribe();
      openStreams.delete(res);
    });
    if (subscription.snapshot.length > 0) {
      send(terminalSseEventNames.output, { data: subscription.snapshot.toString('base64') });
    }
    if (subscription.exitCode !== undefined) {
      send(terminalSseEventNames.exit, { exitCode: subscription.exitCode });
      res.end();
    }
  };

  const routeTerminals = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    method: string,
    segments: string[],
  ) => {
    const [, , rawId, action] = segments;
    if (rawId === undefined) {
      if (method === 'GET') {
        const rawCwd = url.searchParams.get('cwd');
        const cwd = rawCwd === null ? null : await canonicalPath(rawCwd);
        reply(res, 200, {
          terminals: terminals.list().filter((terminal) => cwd === null || terminal.cwd === cwd),
        });
        return;
      }
      if (method !== 'POST') throw new HttpError(405, '허용하지 않는 메서드입니다.');
      const body = parseBody(createTerminalBodySchema, await readJson(req));
      if (closing) throw new HttpError(503, '서버를 닫는 중입니다.');
      await assertKnownWorktree(body.cwd);
      reply(res, 201, {
        terminal: terminals.create({ ...body, cwd: await canonicalPath(body.cwd) }),
      });
      return;
    }
    const parsedId = terminalIdSchema.safeParse(rawId);
    const terminal = parsedId.success ? terminals.get(parsedId.data) : undefined;
    if (terminal === undefined) throw new HttpError(404, `터미널이 없습니다: ${rawId}`);
    if (action === 'output' && method === 'GET') {
      streamTerminal(terminal.id, req, res);
      return;
    }
    if (method !== 'POST') throw new HttpError(405, '허용하지 않는 메서드입니다.');
    if (action !== 'input' && action !== 'resize' && action !== 'kill')
      throw new HttpError(404, '알 수 없는 API입니다.');
    if (terminal.status === 'exited')
      throw new HttpError(409, `이미 끝난 터미널입니다: ${terminal.id}`);
    if (action === 'input') {
      terminals.write(terminal.id, parseBody(terminalInputBodySchema, await readJson(req)).data);
    } else if (action === 'resize') {
      const body = parseBody(terminalResizeBodySchema, await readJson(req));
      terminals.resize(terminal.id, body.cols, body.rows);
    } else {
      terminals.kill(terminal.id);
    }
    reply(res, 200, { ok: true });
  };

  const route = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const method = req.method ?? 'GET';
    const segments = url.pathname.split('/').filter((part) => part !== '');
    if (segments[0] !== 'api') {
      if (method !== 'GET') throw new HttpError(405, '허용하지 않는 메서드입니다.');
      await serveStatic(url.pathname, res);
      return;
    }
    if (segments[1] === 'routing' && segments.length === 2) {
      if (method !== 'GET') throw new HttpError(405, '허용하지 않는 메서드입니다.');
      const store = createAccountStore({ path: join(oraHome, 'auth.json'), env: options.env });
      const chains = resolveChains(config, { scripted: options.modelScriptPath !== undefined });
      const roles: RoutingResponse['roles'] = {};
      for (const [role, chain] of Object.entries(chains)) {
        roles[role] = await Promise.all(
          chain.map(async ({ provider, model, effort }) => ({
            provider,
            model,
            ...(effort === undefined ? {} : { effort }),
            hasAccount: (await store.list(provider)).length > 0,
          })),
        );
      }
      const catalogModels = new Map([...BUILTIN_MODELS, ...config.models].map((m) => [m.id, m]));
      const catalog = await Promise.all(
        [...catalogModels.values()].map(async ({ provider, id }) => ({
          provider,
          model: id,
          hasAccount: (await store.list(provider)).length > 0,
        })),
      );
      const routing: RoutingResponse = { roles, catalog, fallback: config.fallback };
      reply(res, 200, routing);
      return;
    }
    if (segments[1] === 'terminals') {
      await routeTerminals(req, res, url, method, segments);
      return;
    }
    if (segments[1] === 'tabs' && segments.length === 2) {
      const tabsPath = join(oraHome, 'tabs.json');
      const readTabsFile = async (): Promise<TabsFile> => {
        const text = await readFile(tabsPath, 'utf8').catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        });
        return text === undefined
          ? { schemaVersion: 1, worktrees: {} }
          : tabsFileSchema.parse(JSON.parse(text));
      };
      if (method === 'GET') {
        const query = parseBody(tabsQuerySchema, { cwd: url.searchParams.get('cwd') ?? '' });
        const cwd = await canonicalPath(query.cwd);
        const file = await readTabsFile();
        reply(res, 200, { tabs: file.worktrees[cwd] ?? { tabs: [] } });
        return;
      }
      if (method !== 'PUT') throw new HttpError(405, '허용하지 않는 메서드입니다.');
      const body = parseBody(putTabsBodySchema, await readJson(req));
      await withFileLock(`${tabsPath}.lock`, async () => {
        const file = await readTabsFile();
        file.worktrees[await canonicalPath(body.cwd)] = body.tabs;
        await writeFileAtomic(tabsPath, `${JSON.stringify(file, null, 2)}\n`);
      });
      reply(res, 200, { tabs: body.tabs });
      return;
    }
    if (segments[1] === 'branch' && segments.length === 2) {
      if (method !== 'GET') throw new HttpError(405, '허용하지 않는 메서드입니다.');
      const { cwd } = parseBody(tabsQuerySchema, { cwd: url.searchParams.get('cwd') ?? '' });
      await assertKnownWorktree(cwd);
      const branch = await readBranch(cwd);
      const defaultBranch = await readDefaultBranch(cwd);
      const body: BranchResponse = {
        ...(branch === undefined ? {} : { branch }),
        ...(defaultBranch === undefined ? {} : { defaultBranch }),
      };
      reply(res, 200, body);
      return;
    }
    if (segments[1] === 'changes' && segments.length === 2) {
      if (method !== 'GET') throw new HttpError(405, '허용하지 않는 메서드입니다.');
      const { cwd } = parseBody(tabsQuerySchema, { cwd: url.searchParams.get('cwd') ?? '' });
      await assertKnownWorktree(cwd);
      reply(res, 200, await readChanges(await canonicalPath(cwd)));
      return;
    }
    if (segments[1] === 'info' && segments.length === 2) {
      if (method !== 'GET') throw new HttpError(405, '허용하지 않는 메서드입니다.');
      const branch = await readBranch(options.cwd);
      const info: InfoResponse = {
        cwd: await canonicalPath(options.cwd),
        ...(branch === undefined ? {} : { branch }),
        permissionMode: config.permissions.mode,
        isolation: options.isolation ?? config.isolation,
        maxSteps: config.limits.maxSteps,
      };
      reply(res, 200, info);
      return;
    }
    if (segments[1] === 'skills' && segments.length === 2) {
      if (method !== 'GET') throw new HttpError(405, '허용하지 않는 메서드입니다.');
      const rawCwd = url.searchParams.get('cwd');
      if (rawCwd === null) {
        reply(res, 200, await skillsApi.list());
        return;
      }
      await assertKnownWorktree(rawCwd);
      reply(res, 200, await skillsApi.list(await canonicalPath(rawCwd)));
      return;
    }
    if (segments[1] === 'memory') {
      const [, , action] = segments;
      if (action === undefined) {
        if (method !== 'GET') throw new HttpError(405, '허용하지 않는 메서드입니다.');
        const rawCwd = url.searchParams.get('cwd');
        if (rawCwd === null) {
          reply(res, 200, await memoryApi.list());
          return;
        }
        await assertKnownWorktree(rawCwd);
        reply(res, 200, await memoryApi.list(await canonicalPath(rawCwd)));
        return;
      }
      if (action === 'tidy') {
        if (method !== 'POST') throw new HttpError(405, '허용하지 않는 메서드입니다.');
        reply(res, 200, await memoryApi.tidy());
        return;
      }
      if (method !== 'DELETE') throw new HttpError(405, '허용하지 않는 메서드입니다.');
      if (!(await memoryApi.remove(decodeURIComponent(action)))) {
        throw new HttpError(404, '메모리를 찾을 수 없습니다.');
      }
      reply(res, 200, { deleted: true });
      return;
    }
    if (segments[1] === 'cost-settings' && segments.length === 2) {
      if (method === 'GET') {
        reply(res, 200, await costApi.get());
        return;
      }
      if (method !== 'PUT') throw new HttpError(405, '허용하지 않는 메서드입니다.');
      reply(res, 200, await costApi.set(parseBody(costSettingsSchema, await readJson(req))));
      return;
    }
    if (segments[1] === 'mcp-servers') {
      const [, , rawName, action] = segments;
      if (rawName === undefined) {
        if (method === 'GET') {
          reply(res, 200, await mcpApi.list());
          return;
        }
        if (method !== 'POST') throw new HttpError(405, '허용하지 않는 메서드입니다.');
        reply(res, 201, await mcpApi.add(parseBody(mcpServerAddBodySchema, await readJson(req))));
        return;
      }
      const name = decodeURIComponent(rawName);
      const missing = () => new HttpError(404, `MCP 서버를 찾을 수 없습니다: ${name}`);
      if (action === 'reconnect') {
        if (method !== 'POST') throw new HttpError(405, '허용하지 않는 메서드입니다.');
        const result = await mcpApi.reconnect(name);
        if (result === undefined) throw missing();
        reply(res, 200, result);
        return;
      }
      if (action !== undefined) throw new HttpError(404, '알 수 없는 API입니다.');
      if (method === 'PATCH') {
        const body = parseBody(mcpServerPatchBodySchema, await readJson(req));
        const result = await mcpApi.setEnabled(name, body.enabled);
        if (result === undefined) throw missing();
        reply(res, 200, result);
        return;
      }
      if (method === 'DELETE') {
        const result = await mcpApi.remove(name);
        if (result === undefined) throw missing();
        reply(res, 200, result);
        return;
      }
      throw new HttpError(405, '허용하지 않는 메서드입니다.');
    }
    if (segments[1] === 'accounts') {
      await routeAccounts(req, res, method, segments);
      return;
    }
    if (segments[1] !== 'sessions') throw new HttpError(404, '알 수 없는 API입니다.');
    const [, , rawId, action] = segments;

    if (rawId === undefined) {
      if (method === 'GET') {
        const records = await listSessions(options.env, options.configPath);
        reply(res, 200, {
          sessions: await Promise.all(
            records.map(async (record) =>
              record.repo === undefined
                ? record
                : { ...record, repo: await canonicalPath(record.repo) },
            ),
          ),
        });
        return;
      }
      if (method === 'POST') {
        const body = parseBody(createSessionBodySchema, await readJson(req));
        if (body.model !== undefined) {
          try {
            resolveChains(config, {
              userModel: body.model,
              scripted: options.modelScriptPath !== undefined,
            });
          } catch (error) {
            if (error instanceof UsageError) throw new HttpError(400, error.message);
            throw error;
          }
        }
        const sessionId = await startSession({
          type: 'createSession',
          task: body.task,
          cwd: body.cwd ?? options.cwd,
          ...modelArgs,
          ...configArgs,
          ...isolationArgs,
          ...(body.permissionMode === undefined ? {} : { permissionMode: body.permissionMode }),
          ...(body.model === undefined ? {} : { model: body.model }),
        });
        reply(res, 201, { sessionId });
        return;
      }
      throw new HttpError(405, '허용하지 않는 메서드입니다.');
    }

    const sessionDir = sessionDirOf(rawId);
    const id = rawId;
    if (action === undefined && method === 'GET') {
      const session = await readSessionRecordOrWarn(sessionDir);
      if (session === undefined) throw new HttpError(404, `세션이 없습니다: ${id}`);
      const entry = live.get(id);
      const modelId = session.models[0]?.model;
      // 모델 스크립트 세션은 창 크기를 스크립트가 정하므로 알 수 없다. 카탈로그에 없는 실제 모델은 실행 때와 같은 200k를 쓴다.
      const contextWindow =
        modelId === undefined || options.modelScriptPath !== undefined
          ? undefined
          : (catalogOf(modelId)?.contextWindow ?? 200_000);
      const detail: SessionDetailResponse = {
        session,
        todos: await readTodos(sessionDir),
        live: entry !== undefined,
        maxSteps: config.limits.maxSteps,
        ...(contextWindow === undefined ? {} : { contextWindow }),
        compactAtRatio: config.context.compactAtRatio,
        keepRecentTokens: config.context.keepRecentTokens,
        pendingApprovals: [...(entry?.approvals ?? [])].map(
          ([requestId, request]): PendingApproval => ({ requestId, request }),
        ),
        pendingQuestions: [...(entry?.questions ?? [])].map(
          ([requestId, request]): PendingQuestion => ({ requestId, request }),
        ),
      };
      reply(res, 200, detail);
      return;
    }
    if (action === 'compaction' && method === 'GET') {
      const ref = url.searchParams.get('path') ?? '';
      // 요약 파일은 세션 디렉터리의 compactions/<번호>.md 뿐이다. 심볼릭 링크로 밖을 가리켜도 거부한다.
      if (!/^compactions\/\d+\.md$/.test(ref))
        throw new HttpError(400, '요약 파일 경로가 아닙니다.');
      const file = resolve(sessionDir, ref);
      const [realFile, realDir] = await Promise.all([
        realpath(file).catch(() => undefined),
        realpath(sessionDir).catch(() => undefined),
      ]);
      if (realFile === undefined || realDir === undefined)
        throw new HttpError(404, '요약 파일이 없습니다.');
      if (!realFile.startsWith(realDir + sep))
        throw new HttpError(400, '세션 디렉터리 밖의 경로입니다.');
      reply(res, 200, { text: await readFile(realFile, 'utf8') });
      return;
    }
    if (action === 'events' && method === 'GET') {
      await streamEvents(id, req, res);
      return;
    }
    if (method !== 'POST') throw new HttpError(405, '허용하지 않는 메서드입니다.');

    switch (action) {
      case 'resume': {
        const body = parseBody(resumeSessionBodySchema, await readJson(req));
        reply(res, 200, { sessionId: await startSession(resumeRequest(id, body.steer)) });
        return;
      }
      case 'cancel': {
        const body = parseBody(cancelBodySchema, await readJson(req));
        requireLive(id).handle.cancel(body.mode);
        reply(res, 200, { ok: true });
        return;
      }
      case 'approval': {
        const body = parseBody(approvalBodySchema, await readJson(req));
        const session = requireLive(id);
        if (!session.approvals.delete(body.requestId)) {
          throw new HttpError(409, `대기 중인 승인 요청이 아닙니다: ${body.requestId}`);
        }
        session.handle.resolveApproval(body.requestId, body.decision);
        publish(id, sseEventNames.requestResolved, { requestId: body.requestId });
        reply(res, 200, { ok: true });
        return;
      }
      case 'answer': {
        const body = parseBody(answerBodySchema, await readJson(req));
        const session = requireLive(id);
        const question = session.questions.get(body.requestId);
        if (question === undefined) {
          throw new HttpError(409, `대기 중인 질문이 아닙니다: ${body.requestId}`);
        }
        if (body.answers.length !== question.questions.length) {
          throw new HttpError(400, '답의 개수가 질문의 개수와 다릅니다.');
        }
        question.questions.forEach((entry, index) => {
          const choices = body.answers[index]?.choices ?? [];
          if (choices.some((choice) => !entry.options.includes(choice))) {
            throw new HttpError(400, `${index + 1}번 질문에 없는 선택지입니다.`);
          }
          if (entry.multiSelect !== true && choices.length > 1) {
            throw new HttpError(400, `${index + 1}번 질문은 하나만 고를 수 있습니다.`);
          }
        });
        session.questions.delete(body.requestId);
        session.handle.answerQuestion(body.requestId, body.answers);
        publish(id, sseEventNames.requestResolved, { requestId: body.requestId });
        reply(res, 200, { ok: true });
        return;
      }
      case 'todo-abandon':
      case 'todo-restore': {
        const body = parseBody(todoActionBodySchema, await readJson(req));
        const todoAction: UserTodoAction = {
          todoId: body.todoId,
          action: action === 'todo-abandon' ? 'abandon' : 'restore',
        };
        if (closing) throw new HttpError(503, '서버를 닫는 중입니다.');
        const todo = (await readTodos(sessionDir)).find((item) => item.id === body.todoId);
        if (todo === undefined) throw new HttpError(404, `todo가 없습니다: ${body.todoId}`);
        if (
          todoAction.action === 'abandon' &&
          (todo.status === 'verified' || todo.status === 'abandoned')
        ) {
          throw new HttpError(409, `${todo.status} todo는 포기할 수 없습니다.`);
        }
        if (todoAction.action === 'restore' && todo.status !== 'abandoned') {
          throw new HttpError(409, 'abandoned가 아닌 todo는 포기를 취소할 수 없습니다.');
        }
        const entry = live.get(id);
        if (entry !== undefined) {
          // 실행 중이면 엔진이 지금 스텝이 끝난 뒤 반영한다 (SPEC 2.3.3절).
          entry.handle.sendTodoAction(todoAction);
          reply(res, 202, { ok: true, applied: false });
          return;
        }
        if (resuming.has(id)) throw new HttpError(409, `세션을 재개하는 중입니다: ${id}`);
        const result = await applyTodoActionToStoppedSession(
          options.env,
          options.configPath,
          id,
          todoAction,
        );
        if (result.rejected !== undefined) throw new HttpError(409, result.rejected);
        reply(res, 200, { ok: true, applied: true });
        return;
      }
      case 'message': {
        const body = parseBody(messageBodySchema, await readJson(req));
        if (closing) throw new HttpError(503, '서버를 닫는 중입니다.');
        if (live.has(id) || resuming.has(id)) {
          // 실행 중이면 소프트 스톱이 끝난 뒤 쌓인 메시지로 같은 세션을 잇는다 (SPEC 2.9절).
          steers.set(id, [...(steers.get(id) ?? []), body.text]);
          live.get(id)?.handle.cancel('soft');
          reply(res, 202, { sessionId: id });
          return;
        }
        await resumeWith(id, body.text);
        reply(res, 200, { sessionId: id });
        return;
      }
      default:
        throw new HttpError(404, '알 수 없는 API입니다.');
    }
  };

  const server: Server = createServer((req, res) => {
    const origin = `http://${BIND_HOST}:${(server.address() as AddressInfo).port}`;
    const fail = (status: number, message: string, headers?: Record<string, string>) => {
      reply(res, status, { error: message }, headers);
    };
    // Host와 Origin은 DNS 리바인딩과 다른 웹 페이지의 요청을 막는다. 토큰보다 먼저 검사한다.
    if (req.headers.host !== new URL(origin).host) {
      fail(403, 'Host 헤더가 서버 주소와 다릅니다.');
      return;
    }
    if (req.headers.origin !== undefined && req.headers.origin !== origin) {
      fail(403, '허용하지 않는 Origin입니다.');
      return;
    }
    const url = new URL(req.url ?? '/', origin);
    const queryToken = url.searchParams.get('token');
    if (url.pathname === '/' && queryToken !== null) {
      if (!safeEqual(queryToken, token)) {
        fail(401, '토큰이 틀립니다.');
        return;
      }
      res.writeHead(302, {
        'set-cookie': `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        location: '/',
      });
      res.end();
      return;
    }
    const cookie = readCookie(req.headers.cookie, COOKIE_NAME);
    if (cookie === undefined || !safeEqual(cookie, token)) {
      fail(401, '인증이 필요합니다. 시작 URL로 접속합니다.');
      return;
    }
    route(req, res, url).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof HttpError && error.status === 413) {
        // 본문을 더 읽지 않으므로 응답을 보낸 뒤 연결을 닫는다.
        res.once('finish', () => {
          req.destroy();
        });
        fail(413, error.message, { connection: 'close' });
      } else if (error instanceof HttpError) fail(error.status, error.message);
      else if (error instanceof AccountApiError) fail(error.status, error.message);
      else if (error instanceof UsageError) fail(409, error.message);
      else fail(500, error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(options.port ?? 0, BIND_HOST, done);
  });
  const port = (server.address() as AddressInfo).port;
  const origin = `http://${BIND_HOST}:${port}`;

  return {
    startUrl: `${origin}/?token=${token}`,
    origin,
    port,
    async close() {
      clearInterval(memoryTimer);
      await accountApi.close();
      await mcpApi.close();
      await terminals.closeAll();
      closing = true;
      for (const session of live.values()) session.handle.cancel('soft');
      await Promise.allSettled([...live.values()].map((session) => session.handle.result));
      for (const stream of openStreams) stream.end();
      server.closeAllConnections();
      const stopped = Promise.withResolvers<undefined>();
      server.close(() => {
        stopped.resolve(undefined);
      });
      await stopped.promise;
    },
  };
}
