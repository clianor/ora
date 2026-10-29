/**
 * Claude 구독 OAuth(PKCE) 로그인과 토큰 갱신이다. 값은 omp와 pi-mono의 공개 소스에서 확인한 것이다.
 * client id는 Claude Code가 공개 배포하는 값이다.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { scrubText } from '@ora/core';
import { z } from 'zod';
import { sendLoginResult } from './login-page.ts';
import type { LimitWindow, OAuthTokens, ProviderDef, UsageLimits, WireCredential } from './wire.ts';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// 설치된 Claude Code 2.1.312가 쓰는 claude.ai 로그인 주소(CLAUDE_AI_AUTHORIZE_URL)다.
const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const SCOPE =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
const MANUAL_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const PREFERRED_PORT = 54545;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const ERROR_BODY_MAX_CHARS = 300;

/**
 * 토큰 주소 후보가 둘 있다. 설치된 Claude Code 2.1.312가 쓰는 `platform.claude.com`(TOKEN_URL)을 먼저 쓴다.
 * 네트워크 오류나 5xx, 404이면 `api.anthropic.com`(omp가 쓰는 값)으로 한 번 더 보낸다.
 * 400과 401은 인증 거부이므로 다른 호스트로 재시도하지 않는다.
 */
const CLAUDE_TOKEN_URLS = [
  'https://platform.claude.com/v1/oauth/token',
  'https://api.anthropic.com/v1/oauth/token',
] as const;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
  account: z
    .object({ uuid: z.string().optional(), email_address: z.string().optional() })
    .optional(),
});

function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function buildAuthorizeUrl(options: {
  redirectUri: string;
  challenge: string;
  state: string;
}): string {
  const query = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: options.redirectUri,
    scope: SCOPE,
    code_challenge: options.challenge,
    code_challenge_method: 'S256',
    state: options.state,
  });
  return `${AUTHORIZE_URL}?${query.toString()}`;
}

async function requestToken(
  body: Record<string, string>,
  extraHeaders: Record<string, string>,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<OAuthTokens> {
  let lastError: Error | undefined;
  for (const url of CLAUDE_TOKEN_URLS) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...extraHeaders,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      lastError = new Error(`Claude 토큰 요청이 네트워크 오류로 실패했습니다: ${String(error)}`, {
        cause: error,
      });
      continue;
    }
    if (response.ok) {
      const parsed = tokenResponseSchema.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) throw new Error('Claude 토큰 응답의 형식이 올바르지 않습니다.');
      const { account } = parsed.data;
      return {
        accessToken: parsed.data.access_token,
        refreshToken: parsed.data.refresh_token,
        expiresAt: now() + parsed.data.expires_in * 1000,
        ...(account?.uuid === undefined ? {} : { accountUuid: account.uuid }),
        ...(account?.email_address === undefined ? {} : { email: account.email_address }),
      };
    }
    const text = await response.text().catch(() => '');
    lastError = new Error(
      `Claude 토큰 응답 ${response.status}: ${scrubText(text.slice(0, ERROR_BODY_MAX_CHARS)).text}`,
    );
    if (response.status !== 404 && response.status < 500) break;
  }
  throw lastError ?? new Error('Claude 토큰 요청이 실패했습니다.');
}

function exchangeClaudeCode(options: {
  code: string;
  state: string;
  redirectUri: string;
  verifier: string;
  fetch?: typeof fetch;
  now?: () => number;
}): Promise<OAuthTokens> {
  return requestToken(
    {
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code: options.code,
      state: options.state,
      redirect_uri: options.redirectUri,
      code_verifier: options.verifier,
    },
    {},
    options.fetch ?? fetch,
    options.now ?? Date.now,
  );
}

/** refresh token은 회전한다. 호출자가 돌려받은 새 값을 바로 저장해야 한다. */
function refreshClaudeToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<OAuthTokens> {
  return requestToken(
    { grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: refreshToken },
    {
      'anthropic-beta': 'oauth-2025-04-20',
      'user-agent': 'anthropic-sdk-typescript/0.112.1 userOAuthProvider',
    },
    fetchImpl,
    now,
  );
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const usageWindowSchema = z
  .object({
    utilization: z.number().nullable().optional(),
    resets_at: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .nullish();
const usageSchema = z.object({ five_hour: usageWindowSchema, seven_day: usageWindowSchema });

function toLimitWindow(window: z.infer<typeof usageWindowSchema>): LimitWindow | undefined {
  if (typeof window?.utilization !== 'number') return undefined;
  const resetsAt = typeof window.resets_at === 'string' ? Date.parse(window.resets_at) : Number.NaN;
  return {
    remainingPct: Math.min(100, Math.max(0, 100 - window.utilization)),
    ...(Number.isNaN(resetsAt) ? {} : { resetsAtMs: resetsAt }),
  };
}

/** 5시간 창과 7일 창의 남은 비율(%)과 리셋 시각이다. 구독 OAuth 토큰만 조회할 수 있다. */
async function readClaudeLimits(
  credential: WireCredential,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<UsageLimits | undefined> {
  if (credential.kind !== 'oauth') return undefined;
  const response = await fetchImpl(USAGE_URL, {
    headers: {
      authorization: `Bearer ${credential.token}`,
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
      accept: 'application/json',
    },
    signal,
  });
  if (!response.ok) throw new Error(`사용량 조회 실패: HTTP ${String(response.status)}`);
  const usage = usageSchema.parse(await response.json());
  const fiveHour = toLimitWindow(usage.five_hour);
  const sevenDay = toLimitWindow(usage.seven_day);
  if (fiveHour === undefined && sevenDay === undefined) return undefined;
  return {
    ...(fiveHour === undefined ? {} : { fiveHour }),
    ...(sevenDay === undefined ? {} : { sevenDay }),
  };
}

export const CLAUDE_PROVIDER: ProviderDef = {
  id: 'claude',
  wire: 'anthropic-messages',
  refresh: (refreshToken, fetchImpl, now) => refreshClaudeToken(refreshToken, fetchImpl, now),
  readLimits: readClaudeLimits,
};

export interface ClaudeLoginIo {
  print(line: string): void;
  /** 사용자가 붙여 넣은 한 줄을 돌려준다. 콜백이 먼저 오면 그 결과를 쓰므로 영원히 끝나지 않아도 된다. */
  readManualCode(): Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
  /** 0이면 임의 포트다. 기본은 54545이고 쓸 수 없으면 임의 포트로 바꾼다. */
  port?: number;
  timeoutMs?: number;
}

interface CallbackResult {
  code: string;
  redirectUri: string;
}

function parseManualInput(input: string, localRedirectUri: string, state: string): CallbackResult {
  const text = input.trim();
  if (text.includes('://')) {
    const url = new URL(text);
    const error = url.searchParams.get('error');
    if (error !== null) throw new Error(`로그인이 거부됐습니다: ${error}`);
    const code = url.searchParams.get('code');
    if (code === null || url.searchParams.get('state') !== state) {
      throw new Error('붙여 넣은 주소에 올바른 code와 state가 없습니다.');
    }
    return { code, redirectUri: localRedirectUri };
  }
  const [code, returnedState] = text.split('#');
  if (code === undefined || code === '') throw new Error('붙여 넣은 코드가 비어 있습니다.');
  if (returnedState !== undefined && returnedState !== state) {
    throw new Error('붙여 넣은 코드의 state가 일치하지 않습니다.');
  }
  return { code, redirectUri: MANUAL_REDIRECT_URI };
}

/**
 * 로컬 콜백 서버(127.0.0.1)와 수동 붙여넣기를 함께 열고 먼저 도착한 코드로 토큰을 교환한다.
 * 브라우저는 열지 않는다. 주소를 출력하면 사용자가 연다.
 */
export async function loginClaude(io: ClaudeLoginIo): Promise<OAuthTokens> {
  const { verifier, challenge } = createPkce();
  const state = randomBytes(32).toString('base64url');
  const callback = Promise.withResolvers<CallbackResult>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    // state가 다른 요청은 로그인과 무관하므로 400만 돌려주고 계속 기다린다.
    if (url.searchParams.get('state') !== state) {
      res.writeHead(400).end();
      return;
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const ok = error === null && code !== null;
    sendLoginResult(res, ok);
    if (ok) {
      callback.resolve({ code, redirectUri: localRedirectUri() });
    } else {
      callback.reject(new Error(`로그인이 거부됐습니다: ${error ?? 'code 없음'}`));
    }
  });
  const listen = (port: number) => {
    const { promise, resolve, reject } = Promise.withResolvers<undefined>();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(undefined);
    });
    return promise;
  };
  const localRedirectUri = () =>
    `http://localhost:${String((server.address() as AddressInfo).port)}/callback`;
  try {
    await listen(io.port ?? PREFERRED_PORT).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      return listen(0);
    });
    io.print('브라우저에서 아래 주소를 열어 로그인합니다.');
    io.print(buildAuthorizeUrl({ redirectUri: localRedirectUri(), challenge, state }));
    io.print('콜백이 오지 않으면 아래 주소로 로그인한 뒤 화면의 코드를 이 터미널에 붙여 넣습니다.');
    io.print(buildAuthorizeUrl({ redirectUri: MANUAL_REDIRECT_URI, challenge, state }));
    const manual = io
      .readManualCode()
      .then((input) => parseManualInput(input, localRedirectUri(), state));
    const timeout = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      timeout.reject(new Error('로그인 시간이 지났습니다.'));
    }, io.timeoutMs ?? LOGIN_TIMEOUT_MS);
    let result: CallbackResult;
    try {
      result = await Promise.race([callback.promise, manual, timeout.promise]);
    } finally {
      clearTimeout(timer);
    }
    return await exchangeClaudeCode({
      code: result.code,
      state,
      redirectUri: result.redirectUri,
      verifier,
      ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
      ...(io.now === undefined ? {} : { now: io.now }),
    });
  } finally {
    server.close();
    server.closeAllConnections();
  }
}
