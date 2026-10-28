import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import {
  answerBodySchema,
  approvalBodySchema,
  cancelBodySchema,
  createSessionBodySchema,
  messageBodySchema,
  oraEventSchema,
  resumeSessionBodySchema,
  sessionIdSchema,
  sseEventNames,
} from '@ora/protocol';
import type {
  ApprovalRequest,
  InfoResponse,
  OraEvent,
  PendingApproval,
  PendingQuestion,
  QuestionRequest,
  SessionDetailResponse,
} from '@ora/protocol';
import { readSessionRecord, readTodos, readTranscriptText } from '@ora/store';
import { z } from 'zod';
import { UsageError, loadConfig, resolveSessionsDir } from './config.ts';
import { resolveOraHome } from './isolation/ora-home.ts';
import { launchSession, listSessions } from './supervisor.ts';
import type { LaunchRequest, SessionHandle } from './supervisor.ts';

const COOKIE_NAME = 'ora_token';
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
  readonly modelScriptPath: string;
  /** 정적 웹 결과물 디렉터리다. 없으면 API만 제공한다. */
  readonly webDir?: string;
  /** 생략하면 운영체제가 빈 포트를 고른다. */
  readonly port?: number;
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
  const sessionsDir = resolveSessionsDir(config, oraHome);
  const token = randomBytes(32).toString('hex');
  const webRoot = options.webDir === undefined ? undefined : resolve(options.webDir);
  const configArgs = options.configPath === undefined ? {} : { configPath: options.configPath };

  const live = new Map<string, LiveSession>();
  const subscribers = new Map<string, Set<Subscriber>>();
  const openStreams = new Set<ServerResponse>();
  // 실행 중인 세션에 보낸 조향 메시지다. 워커가 끝나면 모아서 한 번에 재개한다.
  const steers = new Map<string, string[]>();
  // 재개를 시작하는 중이라 아직 `live`에 들지 않은 세션이다.
  const resuming = new Set<string>();
  let closing = false;

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
    modelScriptPath: options.modelScriptPath,
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

  const route = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const method = req.method ?? 'GET';
    const segments = url.pathname.split('/').filter((part) => part !== '');
    if (segments[0] !== 'api') {
      if (method !== 'GET') throw new HttpError(405, '허용하지 않는 메서드입니다.');
      await serveStatic(url.pathname, res);
      return;
    }
    if (segments[1] === 'info' && segments.length === 2) {
      if (method !== 'GET') throw new HttpError(405, '허용하지 않는 메서드입니다.');
      const branch = await readBranch(options.cwd);
      const info: InfoResponse = {
        cwd: options.cwd,
        ...(branch === undefined ? {} : { branch }),
        permissionMode: config.permissions.mode,
        isolation: config.isolation,
        maxSteps: config.limits.maxSteps,
      };
      reply(res, 200, info);
      return;
    }
    if (segments[1] !== 'sessions') throw new HttpError(404, '알 수 없는 API입니다.');
    const [, , rawId, action] = segments;

    if (rawId === undefined) {
      if (method === 'GET') {
        reply(res, 200, { sessions: await listSessions(options.env, options.configPath) });
        return;
      }
      if (method === 'POST') {
        const body = parseBody(createSessionBodySchema, await readJson(req));
        const sessionId = await startSession({
          type: 'createSession',
          task: body.task,
          cwd: body.cwd ?? options.cwd,
          modelScriptPath: options.modelScriptPath,
          ...configArgs,
          ...(body.permissionMode === undefined ? {} : { permissionMode: body.permissionMode }),
        });
        reply(res, 201, { sessionId });
        return;
      }
      throw new HttpError(405, '허용하지 않는 메서드입니다.');
    }

    const sessionDir = sessionDirOf(rawId);
    const id = rawId;
    if (action === undefined && method === 'GET') {
      const session = await readSessionRecord(sessionDir).catch(() => undefined);
      if (session === undefined) throw new HttpError(404, `세션이 없습니다: ${id}`);
      const entry = live.get(id);
      const detail: SessionDetailResponse = {
        session,
        todos: await readTodos(sessionDir),
        live: entry !== undefined,
        maxSteps: config.limits.maxSteps,
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
