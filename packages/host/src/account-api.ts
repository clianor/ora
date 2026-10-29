import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createAccountStore, getProvider, withFileLock, writeFileAtomic } from '@ora/adapters';
import type { Account, AccountStore, UsageLimits } from '@ora/adapters';
import type {
  AccountListResponse,
  AccountProvider,
  AccountView,
  AddApiKeyBody,
  LimitWindowView,
  LoginState,
  StartLoginBody,
} from '@ora/protocol';
import { loadConfig, UsageError } from './config.ts';
import type { Config } from './config.ts';
import { loginTokens, saveLoginTokens } from './accounts.ts';
import { resolveOraHome } from './isolation/ora-home.ts';

const PROVIDERS: readonly AccountProvider[] = ['claude', 'codex', 'grok'];
/** 한도와 만료 조회 결과를 다시 쓰는 시간이다. 화면이 폴링해도 프로바이더를 매번 부르지 않는다. */
const PROBE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;
/** 콜백 서버 방식 로그인의 제한 시간이다. `loginClaude`와 `loginCodex`의 기본값과 같다. */
const LOGIN_TIMEOUT_MS = 5 * 60_000;

export class AccountApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface AccountApiOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly configPath?: string;
  /** 사용량 조회, 토큰 갱신, 로그인에 쓰는 fetch다. 테스트가 바꿔 끼운다. */
  readonly fetch?: typeof fetch;
  /** Claude와 Codex 로그인 콜백 서버의 포트다. 테스트가 0으로 바꾼다. */
  readonly loginPort?: number;
  readonly now?: () => number;
  /** 지금 실행 중인 세션이 고정한 계정이다. */
  readonly listPinnedAccounts: () => Promise<{ provider: string; account: string }[]>;
}

export interface AccountApi {
  list(): Promise<AccountListResponse>;
  startLogin(provider: AccountProvider, body: StartLoginBody): Promise<LoginState>;
  getLogin(provider: AccountProvider): LoginState | undefined;
  cancelLogin(provider: AccountProvider): Promise<LoginState>;
  addApiKey(provider: AccountProvider, body: AddApiKeyBody): Promise<AccountView>;
  logout(provider: AccountProvider, name: string): Promise<void>;
  setPriority(provider: AccountProvider, name: string, priority: number): Promise<void>;
  /** 진행 중인 로그인을 모두 취소하고 콜백 서버가 닫힐 때까지 기다린다. */
  close(): Promise<void>;
}

interface Probe {
  readonly expired: boolean;
  readonly limits?: UsageLimits;
}

interface LoginEntry {
  readonly controller: AbortController;
  readonly done: Promise<void>;
  state: LoginState;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function createAccountApi(options: AccountApiOptions): AccountApi {
  const now = options.now ?? Date.now;
  const oraHome = resolveOraHome(options.env);
  const configFile = options.configPath ?? join(oraHome, 'engine.config.json');
  const send = options.fetch ?? fetch;
  const store: AccountStore = createAccountStore({
    path: join(oraHome, 'auth.json'),
    env: options.env,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const probes = new Map<string, { at: number; value: Promise<Probe> }>();
  const logins = new Map<AccountProvider, LoginEntry>();

  const probe = (provider: AccountProvider, account: Extract<Account, { kind: 'oauth' }>) => {
    const key = `${provider}/${account.name}`;
    const hit = probes.get(key);
    if (hit !== undefined && now() - hit.at < PROBE_TTL_MS) return hit.value;
    const value = (async (): Promise<Probe> => {
      let credential;
      try {
        credential = await store.resolveCredential(provider, account.name);
      } catch {
        // 만료한 토큰을 갱신하지 못하면 다시 로그인해야 한다.
        return { expired: true };
      }
      const limits = await getProvider(provider)
        ?.readLimits?.(credential, send, AbortSignal.timeout(PROBE_TIMEOUT_MS))
        .catch(() => undefined);
      return { expired: false, ...(limits === undefined ? {} : { limits }) };
    })();
    probes.set(key, { at: now(), value });
    return value;
  };

  const forgetProbes = (provider: AccountProvider) => {
    for (const key of probes.keys()) if (key.startsWith(`${provider}/`)) probes.delete(key);
  };

  const toWindow = (window: UsageLimits['fiveHour']): LimitWindowView | undefined =>
    window === undefined
      ? undefined
      : {
          remainingPct: window.remainingPct,
          ...(window.resetsAtMs === undefined ? {} : { resetsAt: iso(window.resetsAtMs) }),
        };

  const toView = async (
    provider: AccountProvider,
    account: Account,
    config: Config,
    pinned: ReadonlySet<string>,
  ): Promise<AccountView> => {
    const priority =
      config.accountPolicies.find((p) => p.provider === provider && p.account === account.name)
        ?.priority ?? 0;
    const isPinned = pinned.has(`${provider}/${account.name}`);
    if (account.kind === 'apiKey') {
      const value = options.env[account.credentialEnv];
      return {
        name: account.name,
        kind: 'apiKey',
        detail: account.credentialEnv,
        envPresent: value !== undefined && value !== '',
        priority,
        status: isPinned ? 'inUse' : 'idle',
      };
    }
    const { expired, limits } = await probe(provider, account);
    const exhausted = [limits?.fiveHour, limits?.sevenDay].flatMap((window) =>
      window !== undefined && window.remainingPct <= 0 && (window.resetsAtMs ?? 0) > now()
        ? [window.resetsAtMs ?? 0]
        : [],
    );
    const fiveHour = toWindow(limits?.fiveHour);
    const sevenDay = toWindow(limits?.sevenDay);
    let status: AccountView['status'] = isPinned ? 'inUse' : 'idle';
    if (exhausted.length > 0) status = 'limited';
    if (expired) status = 'expired';
    return {
      name: account.name,
      kind: 'oauth',
      ...(account.email === undefined ? {} : { detail: account.email }),
      priority,
      ...(fiveHour === undefined ? {} : { fiveHour }),
      ...(sevenDay === undefined ? {} : { sevenDay }),
      status,
      ...(status === 'limited' ? { limitedUntil: iso(Math.max(...exhausted)) } : {}),
    };
  };

  const requireAccount = async (provider: AccountProvider, name: string): Promise<Account> => {
    const found = (await store.list(provider)).find((account) => account.name === name);
    if (found === undefined) throw new AccountApiError(404, `계정을 찾을 수 없습니다: ${name}`);
    return found;
  };

  const startLogin: AccountApi['startLogin'] = async (provider, body) => {
    if (logins.get(provider)?.state.status === 'pending') {
      throw new AccountApiError(409, `${provider} 로그인이 이미 진행 중입니다.`);
    }
    const controller = new AbortController();
    const state: LoginState = { status: 'pending' };
    const promptReady = Promise.withResolvers<undefined>();
    const setPrompt = (prompt: NonNullable<LoginState['prompt']>) => {
      state.prompt ??= prompt;
      promptReady.resolve(undefined);
    };
    const run = loginTokens(provider, body.device === undefined ? {} : { device: body.device }, {
      print: (line) => {
        // Claude와 Codex는 로그인 주소를 첫 `http` 줄로 출력한다.
        if (provider !== 'grok' && /^https?:\/\//.test(line)) {
          setPrompt({ kind: 'url', url: line, expiresAt: iso(now() + LOGIN_TIMEOUT_MS) });
        }
      },
      readLine: () => {
        const cancelled = Promise.withResolvers<string>();
        controller.signal.addEventListener(
          'abort',
          () => {
            cancelled.reject(new Error('로그인을 취소했습니다.'));
          },
          { once: true },
        );
        return cancelled.promise;
      },
      signal: controller.signal,
      onDeviceCode: ({ url, code, expiresAt }) => {
        setPrompt({ kind: 'device', url, code, expiresAt: iso(expiresAt) });
      },
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.loginPort === undefined ? {} : { port: options.loginPort }),
    });
    const done = run
      .then((tokens) => saveLoginTokens(store, provider, tokens))
      .then((accountName) => {
        forgetProbes(provider);
        entry.state = { status: 'succeeded', accountName };
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        entry.state = controller.signal.aborted
          ? { status: 'cancelled' }
          : { status: message.includes('시간이 지났') ? 'timeout' : 'failed', error: message };
      })
      .finally(() => {
        promptReady.resolve(undefined);
      });
    const entry: LoginEntry = { controller, done, state };
    logins.set(provider, entry);
    // 주소나 코드가 준비되거나 로그인이 곧바로 끝날 때까지 기다린다.
    await promptReady.promise;
    return entry.state;
  };

  return {
    async list() {
      const config = await loadConfig(options.configPath, oraHome);
      const pins = await options.listPinnedAccounts();
      const pinned = new Set(pins.map((pin) => `${pin.provider}/${pin.account}`));
      const providers = await Promise.all(
        PROVIDERS.map(async (provider) => {
          const accounts = await Promise.all(
            (await store.list(provider)).map((account) =>
              toView(provider, account, config, pinned),
            ),
          );
          const login = logins.get(provider)?.state;
          return {
            provider,
            accounts: accounts.toSorted((a, b) => b.priority - a.priority),
            ...(login === undefined ? {} : { login }),
          };
        }),
      );
      return { providers };
    },
    startLogin,
    getLogin: (provider) => logins.get(provider)?.state,
    async cancelLogin(provider) {
      const entry = logins.get(provider);
      if (entry === undefined) throw new AccountApiError(404, '진행한 로그인이 없습니다.');
      if (entry.state.status === 'pending') entry.controller.abort();
      await entry.done;
      return entry.state;
    },
    async addApiKey(provider, body) {
      const name = body.name ?? body.envName;
      if ((await store.list(provider)).some((account) => account.name === name)) {
        throw new AccountApiError(409, `같은 이름의 계정이 이미 있습니다: ${name}`);
      }
      const account: Account = { kind: 'apiKey', name, credentialEnv: body.envName };
      await store.save(provider, account);
      return toView(provider, account, await loadConfig(options.configPath, oraHome), new Set());
    },
    async logout(provider, name) {
      if (!(await store.remove(provider, name))) {
        throw new AccountApiError(404, `계정을 찾을 수 없습니다: ${name}`);
      }
      forgetProbes(provider);
    },
    async setPriority(provider, name, priority) {
      await requireAccount(provider, name);
      await mkdir(dirname(configFile), { recursive: true, mode: 0o700 });
      await withFileLock(`${configFile}.lock`, async () => {
        let file: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(await readFile(configFile, 'utf8'));
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new UsageError(`설정 파일이 JSON 객체가 아닙니다: ${configFile}`);
          }
          file = parsed as Record<string, unknown>;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            if (error instanceof UsageError) throw error;
            throw new UsageError(`설정 파일을 읽을 수 없습니다: ${configFile}`);
          }
          // 설정 파일이 없을 때 기본 권한 모드는 always-ask다. 파일을 만들어도 그 모드를 유지한다.
          file = { schemaVersion: 1, permissions: { mode: 'always-ask' } };
        }
        const policies = Array.isArray(file.accountPolicies)
          ? (file.accountPolicies as Record<string, unknown>[])
          : [];
        const index = policies.findIndex(
          (policy) => policy.provider === provider && policy.account === name,
        );
        const next = { ...policies[index], provider, account: name, priority };
        if (index === -1) policies.push(next);
        else policies[index] = next;
        file.accountPolicies = policies;
        await writeFileAtomic(configFile, `${JSON.stringify(file, null, 2)}\n`);
      });
    },
    async close() {
      const entries = [...logins.values()];
      for (const entry of entries) if (entry.state.status === 'pending') entry.controller.abort();
      await Promise.all(entries.map((entry) => entry.done));
    },
  };
}
