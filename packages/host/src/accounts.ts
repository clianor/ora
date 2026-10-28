import { join } from 'node:path';
import { createAccountStore, getProvider, loginClaude, loginCodex, loginGrok } from '@ora/adapters';
import type { AccountStore } from '@ora/adapters';
import { UsageError } from './config.ts';
import { resolveOraHome } from './isolation/ora-home.ts';

export interface LoginIo {
  print: (line: string) => void;
  readLine: () => Promise<string>;
}

function openStore(env: NodeJS.ProcessEnv): AccountStore {
  return createAccountStore({ path: join(resolveOraHome(env), 'auth.json'), env });
}

function requireProvider(provider: string): void {
  if (getProvider(provider) === undefined) {
    throw new UsageError(`지원하지 않는 프로바이더입니다: ${provider}`);
  }
}

function loginTokens(provider: string, options: { device?: boolean }, io: LoginIo) {
  if (provider === 'codex') {
    return loginCodex({
      print: io.print,
      readManualCode: io.readLine,
      ...(options.device === undefined ? {} : { device: options.device }),
    });
  }
  if (provider === 'grok') return loginGrok({ print: io.print });
  return loginClaude({ print: io.print, readManualCode: io.readLine });
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
  const existing = await store.list(provider);
  const base =
    options.name ?? tokens.email ?? `account-${(tokens.accountUuid ?? 'new').slice(0, 8)}`;
  // 이름을 지정하지 않았으면 다른 계정의 이름을 덮어쓰지 않도록 번호를 붙인다. 같은 계정으로 다시 로그인하면 갱신한다.
  let name = base;
  for (let suffix = 2; options.name === undefined; suffix += 1) {
    const taken = existing.find((account) => account.name === name);
    if (
      taken === undefined ||
      (taken.kind === 'oauth' &&
        taken.accountUuid !== undefined &&
        taken.accountUuid === tokens.accountUuid)
    )
      break;
    name = `${base}-${String(suffix)}`;
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

/** 토큰 값은 돌려주지 않는다. 이름, 종류, 순위, 만료 시각이나 환경변수 이름만 담는다. */
export async function listAccounts(env: NodeJS.ProcessEnv): Promise<string[]> {
  const store = openStore(env);
  const rows: string[] = [];
  for (const provider of ['claude', 'codex', 'grok']) {
    for (const account of await store.list(provider)) {
      const detail =
        account.kind === 'oauth'
          ? `expires ${new Date(account.expiresAt).toISOString()}`
          : `env ${account.credentialEnv}`;
      rows.push(`${provider}\t${account.rank}\t${account.name}\t${account.kind}\t${detail}`);
    }
  }
  return rows;
}
