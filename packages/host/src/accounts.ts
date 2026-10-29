import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAccountStore, getProvider, loginClaude, loginCodex, loginGrok } from '@ora/adapters';
import type { AccountStore, OAuthTokens } from '@ora/adapters';
import { UsageError } from './config.ts';
import { resolveOraHome } from './isolation/ora-home.ts';

export interface LoginIo {
  print: (line: string) => void;
  readLine: () => Promise<string>;
  /** 로그인 서버와 토큰 교환에 쓸 fetch다. 테스트가 바꿔 끼운다. */
  fetch?: typeof fetch;
  /** Claude와 Codex 콜백 서버의 포트다. 0이면 임의 포트다. */
  port?: number;
  /** 신호를 보내면 Grok과 Codex 디바이스 코드 로그인의 대기가 멈춘다. */
  signal?: AbortSignal;
  /** Grok이 디바이스 코드를 받으면 주소, 코드, 만료 시각(epoch ms)을 넘긴다. */
  onDeviceCode?: (info: { url: string; code: string; expiresAt: number }) => void;
}

function openStore(env: NodeJS.ProcessEnv): AccountStore {
  return createAccountStore({ path: join(resolveOraHome(env), 'auth.json'), env });
}

function requireProvider(provider: string): void {
  if (getProvider(provider) === undefined) {
    throw new UsageError(`지원하지 않는 프로바이더입니다: ${provider}`);
  }
}

/** 프로바이더별 로그인 함수를 부르고 토큰을 돌려준다. 저장은 호출한 쪽이 한다. */
export function loginTokens(provider: string, options: { device?: boolean }, io: LoginIo) {
  const shared = {
    print: io.print,
    ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
    ...(io.signal === undefined
      ? {}
      : { sleep: (ms: number) => delay(ms, undefined, { signal: io.signal }) }),
  };
  const callback = {
    ...shared,
    readManualCode: io.readLine,
    ...(io.port === undefined ? {} : { port: io.port }),
  };
  if (provider === 'codex') {
    return loginCodex({
      ...callback,
      ...(options.device === undefined ? {} : { device: options.device }),
    });
  }
  if (provider === 'grok') {
    return loginGrok({
      ...shared,
      ...(io.onDeviceCode === undefined ? {} : { onDeviceCode: io.onDeviceCode }),
    });
  }
  return loginClaude(callback);
}

/** `ora login <프로바이더>`다. `apiKeyEnv`를 주면 브라우저 로그인 대신 환경변수 이름만 저장하는 API 키 계정을 만든다. */
export async function loginAccount(
  provider: string,
  options: { name?: string; apiKeyEnv?: string; device?: boolean },
  env: NodeJS.ProcessEnv,
  io: LoginIo,
): Promise<string> {
  requireProvider(provider);
  const store = openStore(env);
  if (options.apiKeyEnv !== undefined) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.apiKeyEnv)) {
      throw new UsageError('--api-key-env에는 환경변수 이름을 적습니다. 키 값을 적으면 안 됩니다.');
    }
    const name = options.name ?? options.apiKeyEnv;
    await store.save(provider, { kind: 'apiKey', name, credentialEnv: options.apiKeyEnv });
    return name;
  }
  const tokens = await loginTokens(provider, options, io);
  return saveLoginTokens(store, provider, tokens, options.name);
}

/** 로그인으로 받은 토큰을 계정으로 저장하고 계정 이름을 돌려준다. */
export async function saveLoginTokens(
  store: AccountStore,
  provider: string,
  tokens: OAuthTokens,
  requestedName?: string,
): Promise<string> {
  const existing = await store.list(provider);
  const base =
    requestedName ?? tokens.email ?? `account-${(tokens.accountUuid ?? 'new').slice(0, 8)}`;
  const sameAccount =
    requestedName === undefined && tokens.accountUuid !== undefined
      ? existing.find(
          (account) => account.kind === 'oauth' && account.accountUuid === tokens.accountUuid,
        )
      : undefined;
  let name = base;
  if (sameAccount !== undefined) {
    // 이메일을 몰라 자동 이름(`account-…`)으로 저장된 계정은 이메일 이름으로 바꾸고, 그 밖의 계정은 저장된 이름 그대로 갱신한다.
    if (sameAccount.name.startsWith('account-') && tokens.email !== undefined) {
      await store.remove(provider, sameAccount.name);
    } else {
      name = sameAccount.name;
    }
  } else {
    // 이름을 지정하지 않았으면 다른 계정의 이름을 덮어쓰지 않도록 번호를 붙인다.
    for (let suffix = 2; requestedName === undefined; suffix += 1) {
      if (!existing.some((account) => account.name === name)) break;
      name = `${base}-${String(suffix)}`;
    }
  }
  await store.save(provider, {
    kind: 'oauth',
    name,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    ...(tokens.accountUuid === undefined ? {} : { accountUuid: tokens.accountUuid }),
    ...(tokens.email === undefined ? {} : { email: tokens.email }),
  });
  return name;
}

export async function logoutAccount(
  provider: string,
  name: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  requireProvider(provider);
  const store = openStore(env);
  const targets =
    name === undefined ? (await store.list(provider)).map((account) => account.name) : [name];
  const removed: string[] = [];
  for (const target of targets) {
    if (await store.remove(provider, target)) removed.push(target);
  }
  if (name !== undefined && removed.length === 0) {
    throw new UsageError(`계정을 찾을 수 없습니다: ${provider}/${name}`);
  }
  return removed;
}

/** 토큰 값은 돌려주지 않는다. 이름, 종류, 만료 시각이나 환경변수 이름만 담는다. */
export async function listAccounts(env: NodeJS.ProcessEnv): Promise<string[]> {
  const store = openStore(env);
  const rows: string[] = [];
  for (const provider of ['claude', 'codex', 'grok']) {
    for (const account of await store.list(provider)) {
      const detail =
        account.kind === 'oauth'
          ? `expires ${new Date(account.expiresAt).toISOString()}`
          : `env ${account.credentialEnv}`;
      rows.push(`${provider}\t${account.name}\t${account.kind}\t${detail}`);
    }
  }
  return rows;
}
