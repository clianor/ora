import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { withFileLock, writeFileAtomic } from './file-store.ts';
import { getProvider } from './providers.ts';
import type { WireCredential } from './wire.ts';

/** 만료 5분 전부터 갱신한다. */
const REFRESH_SKEW_MS = 5 * 60_000;
const REFRESH_TIMEOUT_MS = 30_000;

const envNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

const accountSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('oauth'),
    name: z.string().min(1),
    rank: z.number().int().nonnegative(),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    /** 만료 시각(epoch ms)이다. */
    expiresAt: z.number(),
    accountUuid: z.string().optional(),
    email: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal('apiKey'),
    name: z.string().min(1),
    rank: z.number().int().nonnegative(),
    /** 키 값은 저장하지 않고 읽을 환경변수 이름만 저장한다 (SPEC 2.8절). */
    credentialEnv: envNameSchema,
  }),
]);
export type Account = z.infer<typeof accountSchema>;

/** `<oraHome>/auth.json`의 형식이다 (SPEC 5.2절). 권한은 0600이다. */
const authFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  providers: z.record(z.string(), z.strictObject({ accounts: z.array(accountSchema) })),
});
type AuthFile = z.infer<typeof authFileSchema>;

export type NewAccount =
  | Omit<Extract<Account, { kind: 'oauth' }>, 'rank'>
  | Omit<Extract<Account, { kind: 'apiKey' }>, 'rank'>;

export interface AccountStoreOptions {
  readonly path: string;
  readonly env: NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export interface AccountStore {
  /** 순위가 낮은 숫자부터 돌려준다. */
  list(provider: string): Promise<Account[]>;
  /** 같은 이름이 있으면 순위를 유지한 채 바꾸고, 없으면 맨 뒤 순위로 더한다. */
  save(provider: string, account: NewAccount): Promise<void>;
  remove(provider: string, name: string): Promise<boolean>;
  /** 만료가 가까운 OAuth 토큰은 갱신해 저장한 뒤 돌려준다. 같은 계정의 갱신은 한 번만 돈다. */
  resolveCredential(
    provider: string,
    name: string,
    options?: { forceRefresh?: boolean },
  ): Promise<WireCredential>;
}

export function createAccountStore(options: AccountStoreOptions): AccountStore {
  const now = options.now ?? Date.now;
  const lockPath = `${options.path}.lock`;
  const refreshing = new Map<string, Promise<Extract<Account, { kind: 'oauth' }>>>();

  /** 파일이 없으면 빈 파일로 본다. 깨진 파일은 덮어쓰지 않도록 예외를 던진다. */
  const read = async (): Promise<AuthFile> => {
    let text: string;
    try {
      text = await readFile(options.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, providers: {} };
      }
      throw error;
    }
    try {
      return authFileSchema.parse(JSON.parse(text));
    } catch {
      // JSON 파서 메시지는 본문 일부를 인용하므로 토큰이 새지 않게 원인을 싣지 않는다.
      throw new Error(
        `auth.json의 형식이 올바르지 않습니다: ${options.path}. 파일을 다른 곳으로 옮기고 ora login으로 다시 로그인합니다.`,
      );
    }
  };
  const write = (file: AuthFile) =>
    writeFileAtomic(options.path, `${JSON.stringify(file, null, 2)}\n`, 0o600);
  const sorted = (accounts: readonly Account[]) => accounts.toSorted((a, b) => a.rank - b.rank);

  const mutate = <T>(change: (file: AuthFile) => T): Promise<T> =>
    withFileLock(lockPath, async () => {
      const file = await read();
      const result = change(file);
      await write(file);
      return result;
    });

  const find = (file: AuthFile, provider: string, name: string): Account | undefined =>
    file.providers[provider]?.accounts.find((account) => account.name === name);

  const refresh = async (provider: string, name: string, force: boolean) => {
    const def = getProvider(provider);
    if (def === undefined) throw new Error(`알 수 없는 프로바이더입니다: ${provider}`);
    // 다른 프로세스가 이미 갱신했을 수 있으므로, 락 안에서 파일을 다시 읽어 확인한다.
    return withFileLock(lockPath, async () => {
      const file = await read();
      const account = find(file, provider, name);
      if (account?.kind !== 'oauth') throw new Error(`OAuth 계정이 없습니다: ${provider}/${name}`);
      if (!force && account.expiresAt - now() > REFRESH_SKEW_MS) return account;
      const send = options.fetch ?? fetch;
      const tokens = await def.refresh(
        account.refreshToken,
        (url, init) => send(url, { ...init, signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) }),
        now,
      );
      const updated = {
        ...account,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        ...(tokens.accountUuid === undefined ? {} : { accountUuid: tokens.accountUuid }),
      };
      const accounts = file.providers[provider]?.accounts ?? [];
      accounts.splice(accounts.indexOf(account), 1, updated);
      // refresh token이 회전했으므로 저장에 실패하면 한 번 더 시도한다. 그래도 실패하면 새 토큰이 사라진다.
      await write(file)
        .catch(() => write(file))
        .catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(
            `갱신한 토큰을 저장하지 못했습니다. ora login ${provider}로 다시 로그인합니다: ${reason}`,
            { cause: error },
          );
        });
      return updated;
    });
  };

  return {
    async list(provider) {
      return sorted((await read()).providers[provider]?.accounts ?? []);
    },
    save: (provider, account) =>
      mutate((file) => {
        const entry = (file.providers[provider] ??= { accounts: [] });
        const index = entry.accounts.findIndex((existing) => existing.name === account.name);
        const rank =
          entry.accounts[index]?.rank ??
          entry.accounts.reduce((max, existing) => Math.max(max, existing.rank + 1), 0);
        const next: Account = { ...account, rank };
        if (index === -1) entry.accounts.push(next);
        else entry.accounts[index] = next;
      }),
    remove: (provider, name) =>
      mutate((file) => {
        const entry = file.providers[provider];
        const index = entry?.accounts.findIndex((account) => account.name === name) ?? -1;
        if (entry === undefined || index === -1) return false;
        entry.accounts.splice(index, 1);
        return true;
      }),
    async resolveCredential(provider, name, resolveOptions) {
      const force = resolveOptions?.forceRefresh === true;
      const account = find(await read(), provider, name);
      if (account === undefined) throw new Error(`계정이 없습니다: ${provider}/${name}`);
      if (account.kind === 'apiKey') {
        const token = options.env[account.credentialEnv] ?? '';
        if (token === '')
          throw new Error(`API 키 환경변수가 비어 있습니다: ${account.credentialEnv}`);
        return { kind: 'apiKey', token };
      }
      let current = account;
      if (force || account.expiresAt - now() <= REFRESH_SKEW_MS) {
        const key = `${provider}/${name}`;
        let pending = refreshing.get(key);
        if (pending === undefined) {
          pending = refresh(provider, name, force).finally(() => refreshing.delete(key));
          refreshing.set(key, pending);
        }
        try {
          current = await pending;
        } catch (error) {
          // 갱신이 실패해도 토큰이 아직 유효하면 이번 호출에는 그 토큰을 쓴다.
          if (force || account.expiresAt <= now()) throw error;
        }
      }
      return {
        kind: 'oauth',
        token: current.accessToken,
        ...(current.accountUuid === undefined ? {} : { accountId: current.accountUuid }),
      };
    },
  };
}
