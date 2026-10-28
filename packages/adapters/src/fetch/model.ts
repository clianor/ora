import type { ModelPort, ModelRequest, ModelStreamEvent } from '@ora/core';
import type { SessionRecord } from '@ora/protocol';
import type { Account, AccountStore } from './accounts.ts';
import type { CatalogModel } from './catalog.ts';
import { getProvider } from './providers.ts';
import { orderCandidates } from './select.ts';
import type { AccountPolicy, Candidate } from './select.ts';
import { getWire } from './wires.ts';
import { UsageLimitError, WireAuthError } from './wire.ts';
import type { WireCredential, WireOptions } from './wire.ts';

export interface FetchModelOptions {
  readonly catalog: CatalogModel;
  readonly store: AccountStore;
  /** 이름을 주면 그 계정을 먼저 쓰고 순위로 옮기지 않는다. 막혔거나 갱신에 실패할 때만 다른 계정으로 넘어간다. */
  readonly account?: string;
  /** 이 프로바이더 계정의 정책이다. 없는 계정은 우선순위 0이다. */
  readonly policies?: readonly AccountPolicy[];
  /** 정책에 `reservePct`가 없는 계정의 예비 한도(%)다. */
  readonly reservePct?: number;
  /** 재개하는 세션이 이어 쓸 고정 정보다 (`session.json`의 `accountPin`). */
  readonly pin?: SessionRecord['accountPin'];
  readonly wireOptions?: WireOptions;
  /** 사용량 조회에 쓰는 fetch다. 테스트가 바꿔 끼운다. */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/** 한도 응답에 리셋 시각이 없을 때 계정을 막아 두는 시간이다. */
const DEFAULT_BLOCK_MS = 5 * 60_000;
/** 계정별 남은 사용량을 다시 읽기까지 기다리는 시간이다. 조회가 실패해도 이 시간 동안 다시 부르지 않는다. */
const USAGE_TTL_MS = 60_000;
const USAGE_TIMEOUT_MS = 5_000;
const DEFAULT_RESERVE_PCT = 10;

/**
 * 카탈로그 모델 하나를 계정 목록으로 부르는 `ModelPort`다. 계정 선택은 SPEC 2.8절을 따른다:
 * 세션은 한 계정에 고정하고, 사용량 한도나 예비 한도, 회복 조건이 맞을 때만 옮긴다.
 * 한도 오류가 나면 다음 계정으로 같은 요청을 다시 보낸다. 이미 이벤트를 내보낸 응답은 다시 보내지 않는다.
 */
export function createFetchModel(options: FetchModelOptions): ModelPort {
  const { catalog, store } = options;
  const now = options.now ?? Date.now;
  const blockedUntil = new Map<string, number>();
  const sessionId = crypto.randomUUID();
  const usageCache = new Map<string, { at: number; value: Promise<number | undefined> }>();
  let pinned = options.pin?.provider === catalog.provider ? options.pin.account : undefined;
  let lastUsedAt = options.pin?.lastUsedAt;

  /** 읽지 못하면 `undefined`다. 실패가 요청을 막지 않으며, 실패한 결과도 같은 시간 동안 다시 읽지 않는다. */
  const readRemaining = (account: Account): Promise<number | undefined> => {
    const hit = usageCache.get(account.name);
    if (hit !== undefined && now() - hit.at < USAGE_TTL_MS) return hit.value;
    const def = getProvider(catalog.provider);
    const read = def?.readRemainingPct?.bind(def);
    const value =
      account.kind === 'apiKey' || read === undefined
        ? Promise.resolve(undefined)
        : store
            .resolveCredential(catalog.provider, account.name)
            .then((credential) =>
              read(credential, options.fetch ?? fetch, AbortSignal.timeout(USAGE_TIMEOUT_MS)),
            )
            .catch(() => undefined);
    usageCache.set(account.name, { at: now(), value });
    return value;
  };

  const policyOf = (name: string) =>
    options.policies?.find(
      (policy) => policy.account === name && policy.provider === catalog.provider,
    );

  const rank = async (all: readonly Account[], useUsage: boolean): Promise<Account[]> => {
    const timestamp = now();
    const candidates: Candidate[] = await Promise.all(
      all.map(async (account, index) => {
        const policy = policyOf(account.name);
        const blocked = (blockedUntil.get(account.name) ?? 0) > timestamp;
        const remainingPct = useUsage && !blocked ? await readRemaining(account) : undefined;
        return {
          name: account.name,
          index,
          priority: policy?.priority ?? 0,
          reservePct: policy?.reservePct ?? options.reservePct ?? DEFAULT_RESERVE_PCT,
          blocked,
          ...(policy?.reclaimAbovePct === undefined
            ? {}
            : { reclaimAbovePct: policy.reclaimAbovePct }),
          ...(remainingPct === undefined ? {} : { remainingPct }),
        };
      }),
    );
    const explicit = options.account;
    const ordered =
      explicit === undefined
        ? orderCandidates(candidates, pinned)
        : [
            ...candidates.filter((c) => c.name === explicit && !c.blocked),
            ...orderCandidates(candidates.filter((c) => c.name !== explicit)),
          ];
    return ordered.flatMap((c) => all.find((account) => account.name === c.name) ?? []);
  };

  return {
    model: catalog.id,
    adapter: `${catalog.provider}-fetch`,
    accountPin: () =>
      pinned === undefined || lastUsedAt === undefined
        ? undefined
        : { provider: catalog.provider, account: pinned, lastUsedAt },
    async *stream(request: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelStreamEvent> {
      const wire = getWire(catalog.wire);
      if (wire === undefined)
        throw new Error(`전송 형식을 아직 지원하지 않습니다: ${catalog.wire}`);
      const all = await store.list(catalog.provider);
      if (all.length === 0) {
        throw new Error(
          `로그인한 ${catalog.provider} 계정이 없습니다. ora login ${catalog.provider}를 실행합니다.`,
        );
      }
      if (options.account !== undefined && !all.some((a) => a.name === options.account)) {
        throw new Error(`${catalog.provider} 계정을 찾을 수 없습니다: ${options.account}`);
      }
      // 계정이 하나뿐이면 고를 것이 없으므로 사용량을 읽지 않는다.
      const accounts = await rank(all, all.length > 1 && options.account === undefined);
      let lastError: Error | undefined;
      for (const account of accounts) {
        let credential: WireCredential;
        try {
          credential = await store.resolveCredential(catalog.provider, account.name);
        } catch (error) {
          if (signal.aborted) throw error;
          lastError = error instanceof Error ? error : new Error(String(error));
          continue;
        }
        let emitted = false;
        let refreshedAfter401 = false;
        for (;;) {
          try {
            for await (const event of wire({
              model: catalog,
              credential,
              request,
              signal,
              options: { sessionId, ...options.wireOptions },
            })) {
              if (!emitted) {
                pinned = account.name;
                lastUsedAt = new Date(now()).toISOString();
              }
              emitted = true;
              yield event;
            }
            return;
          } catch (error) {
            if (
              error instanceof WireAuthError &&
              !emitted &&
              !refreshedAfter401 &&
              credential.kind === 'oauth'
            ) {
              refreshedAfter401 = true;
              try {
                credential = await store.resolveCredential(catalog.provider, account.name, {
                  forceRefresh: true,
                });
              } catch (refreshError) {
                if (signal.aborted) throw refreshError;
                throw error;
              }
              continue;
            }
            if (!(error instanceof UsageLimitError) || emitted) throw error;
            blockedUntil.set(account.name, error.resetAtMs ?? now() + DEFAULT_BLOCK_MS);
            lastError = error;
            break;
          }
        }
      }
      throw (
        lastError ??
        new UsageLimitError(`${catalog.provider} 계정이 모두 사용량 한도에 걸려 있습니다.`)
      );
    },
  };
}
