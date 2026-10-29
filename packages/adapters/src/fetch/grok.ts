/** xAI(SuperGrok) 디바이스 코드 OAuth(RFC 8628)와 토큰 갱신이다. 값은 pi-mono와 omp의 공개 소스에서 확인했다. */
import { scrubText } from '@ora/core';
import { z } from 'zod';
import type { OAuthTokens, ProviderDef } from './wire.ts';

const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const DEVICE_CODE_URL = 'https://auth.x.ai/oauth2/device/code';
const TOKEN_URL = 'https://auth.x.ai/oauth2/token';
const DEFAULT_POLL_SECONDS = 5;
const SLOW_DOWN_STEP_MS = 5000;
/** 응답에 `expires_in`이 없을 때 가정하는 수명(초)이다. */
const DEFAULT_LIFETIME_SECONDS = 3600;
const ERROR_BODY_MAX_CHARS = 300;

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
  id_token: z.string().optional(),
});
const errorSchema = z.looseObject({
  error: z.string().optional(),
  interval: z.number().optional(),
});

const postForm = (fetchImpl: typeof fetch, url: string, form: Record<string, string>) =>
  fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });

/** id_token의 `sub`와 `email`을 읽는다. 서명은 검증하지 않고, 계정 이름을 정할 때만 쓴다. */
function readIdentity(idToken: string | undefined): { accountUuid?: string; email?: string } {
  const payload = idToken?.split('.')[1];
  if (payload === undefined) return {};
  try {
    const claims = z
      .looseObject({ sub: z.string().optional(), email: z.string().optional() })
      .parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    return {
      ...(claims.sub === undefined ? {} : { accountUuid: claims.sub }),
      ...(claims.email === undefined ? {} : { email: claims.email }),
    };
  } catch {
    return {};
  }
}

/** 응답에 refresh token이 없으면 `fallbackRefresh`를 그대로 유지한다. */
function toTokens(
  data: z.infer<typeof tokenSchema>,
  now: () => number,
  fallbackRefresh: string | undefined,
): OAuthTokens {
  const refreshToken = data.refresh_token ?? fallbackRefresh;
  if (refreshToken === undefined) throw new Error('xAI 토큰 응답에 refresh token이 없습니다.');
  return {
    accessToken: data.access_token,
    refreshToken,
    expiresAt: now() + (data.expires_in ?? DEFAULT_LIFETIME_SECONDS) * 1000,
    ...readIdentity(data.id_token),
  };
}

async function refreshGrokToken(
  refreshToken: string,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<OAuthTokens> {
  const response = await postForm(fetchImpl, TOKEN_URL, {
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  }).catch((error: unknown) => {
    throw new Error(`xAI 토큰 요청이 네트워크 오류로 실패했습니다: ${String(error)}`, {
      cause: error,
    });
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `xAI 토큰 응답 ${response.status}: ${scrubText(text.slice(0, ERROR_BODY_MAX_CHARS)).text}`,
    );
  }
  const parsed = tokenSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new Error('xAI 토큰 응답의 형식이 올바르지 않습니다.');
  return toTokens(parsed.data, now, refreshToken);
}

export const GROK_PROVIDER: ProviderDef = {
  id: 'grok',
  wire: 'openai-responses',
  refresh: (refreshToken, fetchImpl = fetch, now = Date.now) =>
    refreshGrokToken(refreshToken, fetchImpl, now),
};

export interface GrokLoginIo {
  print(line: string): void;
  /** 인증 주소, 사용자 코드, 코드가 만료되는 시각(epoch ms)을 받는다. 웹 화면이 이 값을 직접 보여 준다. */
  onDeviceCode?(info: { url: string; code: string; expiresAt: number }): void;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const deviceSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().min(1),
  verification_uri_complete: z.string().optional(),
  interval: z.union([z.number(), z.string()]).transform(Number).optional(),
  expires_in: z.number().positive().optional(),
});

export async function loginGrok(io: GrokLoginIo): Promise<OAuthTokens> {
  const doFetch = io.fetch ?? fetch;
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const started = await postForm(doFetch, DEVICE_CODE_URL, {
    client_id: CLIENT_ID,
    scope: SCOPE,
  });
  if (!started.ok) throw new Error(`xAI 디바이스 코드 요청 ${started.status}이 실패했습니다.`);
  const device = deviceSchema.parse(await started.json());
  const uri = device.verification_uri_complete ?? device.verification_uri;
  if (!uri.startsWith('https://')) throw new Error('xAI가 https가 아닌 인증 주소를 돌려줬습니다.');
  io.print(`브라우저에서 ${uri} 를 열고 코드 ${device.user_code} 를 입력합니다.`);
  const deadline = now() + (device.expires_in ?? 900) * 1000;
  io.onDeviceCode?.({ url: uri, code: device.user_code, expiresAt: deadline });
  let intervalMs = (device.interval ?? DEFAULT_POLL_SECONDS) * 1000;
  for (;;) {
    await sleep(intervalMs);
    if (now() > deadline) throw new Error('로그인 시간이 지났습니다.');
    let polled: Response;
    try {
      polled = await postForm(doFetch, TOKEN_URL, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: CLIENT_ID,
        device_code: device.device_code,
      });
    } catch {
      continue;
    }
    if (polled.ok) return toTokens(tokenSchema.parse(await polled.json()), now, undefined);
    const text = await polled.text().catch(() => '');
    let failure: z.infer<typeof errorSchema> = {};
    try {
      failure = errorSchema.parse(JSON.parse(text));
    } catch {
      // 본문이 JSON이 아니면 아래에서 원문으로 오류를 낸다.
    }
    if (failure.error === 'authorization_pending') continue;
    if (failure.error === 'slow_down') {
      intervalMs = Math.max(intervalMs + SLOW_DOWN_STEP_MS, (failure.interval ?? 0) * 1000);
      continue;
    }
    throw new Error(
      `xAI 로그인이 실패했습니다 ${polled.status} ${failure.error ?? ''}: ${scrubText(text.slice(0, ERROR_BODY_MAX_CHARS)).text}`,
    );
  }
}
