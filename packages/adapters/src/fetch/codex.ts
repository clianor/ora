/**
 * ChatGPT 구독(Codex) OAuth 로그인과 토큰 갱신이다. 값은 pi-mono와 omp의 공개 소스에서 확인했다.
 * client id는 Codex CLI가 공개 배포하는 값이다.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { scrubText } from '@ora/core';
import { z } from 'zod';
import { sendLoginResult } from './login-page.ts';
import type { OAuthTokens, ProviderDef } from './wire.ts';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const DEVICE_USERCODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
const DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
const DEVICE_VERIFY_URL = 'https://auth.openai.com/codex/device';
const DEVICE_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback';
const SCOPE = 'openid profile email offline_access';
/** Codex CLI와 공유하는 고정 포트다. */
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = '/auth/callback';
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_POLL_SECONDS = 5;
const ERROR_BODY_MAX_CHARS = 300;
const ACCOUNT_CLAIM = 'https://api.openai.com/auth';

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
  id_token: z.string().optional(),
});

const PROFILE_CLAIM = 'https://api.openai.com/profile';

/** 서명을 검증하지 않고 id_token에서 이메일을 읽는다. 계정 이름을 정할 때만 쓴다. */
function readCodexEmail(idToken: string | undefined): string | undefined {
  const payload = idToken?.split('.')[1];
  if (payload === undefined) return undefined;
  try {
    const claims = z
      .looseObject({
        email: z.string().min(1).optional(),
        [PROFILE_CLAIM]: z.looseObject({ email: z.string().min(1).optional() }).optional(),
      })
      .parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    return claims.email ?? claims[PROFILE_CLAIM]?.email;
  } catch {
    return undefined;
  }
}

/** 서명을 검증하지 않고 액세스 토큰 payload에서 ChatGPT 계정 id를 읽는다. */
function readCodexAccountId(accessToken: string): string {
  const payload = accessToken.split('.')[1];
  if (payload === undefined) throw new Error('Codex 액세스 토큰이 JWT 형식이 아닙니다.');
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Codex 액세스 토큰의 payload를 읽을 수 없습니다.');
  }
  const parsed = z
    .looseObject({
      [ACCOUNT_CLAIM]: z.looseObject({ chatgpt_account_id: z.string().min(1) }),
    })
    .safeParse(claims);
  if (!parsed.success) throw new Error('Codex 액세스 토큰에 chatgpt_account_id claim이 없습니다.');
  return parsed.data[ACCOUNT_CLAIM].chatgpt_account_id;
}

async function requestToken(
  form: Record<string, string>,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<OAuthTokens> {
  let response: Response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
  } catch (error) {
    throw new Error(`Codex 토큰 요청이 네트워크 오류로 실패했습니다: ${String(error)}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Codex 토큰 응답 ${response.status}: ${scrubText(text.slice(0, ERROR_BODY_MAX_CHARS)).text}`,
    );
  }
  const parsed = tokenResponseSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new Error('Codex 토큰 응답의 형식이 올바르지 않습니다.');
  const email = readCodexEmail(parsed.data.id_token);
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresAt: now() + parsed.data.expires_in * 1000,
    accountUuid: readCodexAccountId(parsed.data.access_token),
    ...(email === undefined ? {} : { email }),
  };
}

export const CODEX_PROVIDER: ProviderDef = {
  id: 'codex',
  wire: 'openai-codex-responses',
  refresh: (refreshToken, fetchImpl = fetch, now = Date.now) =>
    requestToken(
      { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID },
      fetchImpl,
      now,
    ),
};

export interface CodexLoginIo {
  print(line: string): void;
  /** 콜백이 오지 않을 때 사용자가 붙여 넣은 주소나 코드를 돌려준다. */
  readManualCode(): Promise<string>;
  /** 브라우저 로그인 대신 디바이스 코드 흐름을 쓴다. */
  device?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 0이면 임의 포트다. 기본은 1455이다. */
  port?: number;
  timeoutMs?: number;
}

function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function loginWithBrowser(io: CodexLoginIo): Promise<OAuthTokens> {
  const { verifier, challenge } = createPkce();
  const state = randomBytes(16).toString('hex');
  const callback = Promise.withResolvers<string>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const code = url.searchParams.get('code');
    if (
      url.pathname !== CALLBACK_PATH ||
      code === null ||
      url.searchParams.get('state') !== state
    ) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('올바르지 않은 요청입니다.');
      return;
    }
    sendLoginResult(res, true);
    callback.resolve(code);
  });
  const requestedPort = io.port ?? CALLBACK_PORT;
  const bound = Promise.withResolvers<undefined>();
  server.once('error', bound.reject);
  server.listen(requestedPort, '127.0.0.1', () => {
    bound.resolve(undefined);
  });
  let port = requestedPort;
  try {
    await bound.promise;
    const address = server.address();
    if (address !== null && typeof address === 'object') port = address.port;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    io.print(
      `콜백 포트 ${String(requestedPort)}가 사용 중입니다(Codex CLI가 쓰는 중일 수 있습니다). 로그인한 뒤 브라우저가 이동한 주소를 붙여 넣습니다.`,
    );
  }
  const redirectUri = `http://localhost:${String(port)}${CALLBACK_PATH}`;
  const authorize = `${AUTHORIZE_URL}?${new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'ora',
  }).toString()}`;
  try {
    io.print('브라우저에서 아래 주소를 열어 로그인합니다.');
    io.print(authorize);
    io.print(
      '콜백이 오지 않으면 브라우저가 이동한 주소 전체나 code 값을 이 터미널에 붙여 넣습니다.',
    );
    const manual = io.readManualCode().then((input) => {
      const text = input.trim();
      if (text === '') throw new Error('붙여 넣은 값이 비어 있습니다.');
      if (!text.includes('://')) return text;
      const url = new URL(text);
      const code = url.searchParams.get('code');
      if (code === null || url.searchParams.get('state') !== state) {
        throw new Error('붙여 넣은 주소에 올바른 code와 state가 없습니다.');
      }
      return code;
    });
    const timeout = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      timeout.reject(new Error('로그인 시간이 지났습니다.'));
    }, io.timeoutMs ?? LOGIN_TIMEOUT_MS);
    let code: string;
    try {
      code = await Promise.race([callback.promise, manual, timeout.promise]);
    } finally {
      clearTimeout(timer);
    }
    return await requestToken(
      {
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      },
      io.fetch ?? fetch,
      io.now ?? Date.now,
    );
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

const deviceCodeSchema = z.object({
  device_auth_id: z.string().min(1),
  user_code: z.string().min(1),
  interval: z.union([z.number(), z.string()]).optional(),
});
const devicePollSchema = z.object({
  authorization_code: z.string().min(1),
  code_verifier: z.string().min(1),
});

async function loginWithDeviceCode(io: CodexLoginIo): Promise<OAuthTokens> {
  const doFetch = io.fetch ?? fetch;
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const startedAt = now();
  const started = await doFetch(DEVICE_USERCODE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  if (!started.ok) throw new Error(`Codex 디바이스 코드 요청 ${started.status}이 실패했습니다.`);
  const device = deviceCodeSchema.parse(await started.json());
  let intervalMs = (Number(device.interval ?? DEFAULT_POLL_SECONDS) || DEFAULT_POLL_SECONDS) * 1000;
  io.print(`브라우저에서 ${DEVICE_VERIFY_URL} 를 열고 코드 ${device.user_code} 를 입력합니다.`);
  for (;;) {
    if (now() - startedAt > (io.timeoutMs ?? LOGIN_TIMEOUT_MS)) {
      throw new Error('로그인 시간이 지났습니다.');
    }
    await sleep(intervalMs);
    let polled: Response;
    try {
      polled = await doFetch(DEVICE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          device_auth_id: device.device_auth_id,
          user_code: device.user_code,
        }),
      });
    } catch {
      continue;
    }
    if (polled.ok) {
      const granted = devicePollSchema.parse(await polled.json());
      return await requestToken(
        {
          grant_type: 'authorization_code',
          client_id: CLIENT_ID,
          code: granted.authorization_code,
          code_verifier: granted.code_verifier,
          redirect_uri: DEVICE_REDIRECT_URI,
        },
        doFetch,
        now,
      );
    }
    const text = await polled.text().catch(() => '');
    if (
      polled.status === 403 ||
      polled.status === 404 ||
      text.includes('deviceauth_authorization_pending')
    ) {
      continue;
    }
    if (text.includes('slow_down')) {
      intervalMs += 5000;
      continue;
    }
    throw new Error(
      `Codex 디바이스 로그인 ${polled.status}: ${scrubText(text.slice(0, ERROR_BODY_MAX_CHARS)).text}`,
    );
  }
}

export function loginCodex(io: CodexLoginIo): Promise<OAuthTokens> {
  return io.device === true ? loginWithDeviceCode(io) : loginWithBrowser(io);
}
