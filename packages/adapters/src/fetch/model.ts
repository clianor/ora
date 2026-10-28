import type { ModelPort, ModelRequest, ModelStreamEvent } from '@ora/core';
import type { AccountStore } from './accounts.ts';
import type { CatalogModel } from './catalog.ts';
import { getWire } from './wires.ts';
import { UsageLimitError, WireAuthError } from './wire.ts';
import type { WireCredential, WireOptions } from './wire.ts';

export interface FetchModelOptions {
  readonly catalog: CatalogModel;
  readonly store: AccountStore;
  /** 이름을 주면 그 계정만 쓰고 전환하지 않는다. 없으면 순위 순서로 쓰고 한도에 걸리면 다음 계정으로 바꾼다. */
  readonly account?: string;
  readonly wireOptions?: WireOptions;
  readonly now?: () => number;
}

/** 한도 응답에 리셋 시각이 없을 때 계정을 막아 두는 시간이다. */
const DEFAULT_BLOCK_MS = 5 * 60_000;

/**
 * 카탈로그 모델 하나를 계정 목록으로 부르는 `ModelPort`다. 사용량 한도 오류가 나면 순위상 다음 계정으로
 * 바꿔 같은 요청을 다시 보낸다. 이미 이벤트를 내보낸 응답은 다시 보내지 않는다.
 */
export function createFetchModel(options: FetchModelOptions): ModelPort {
  const { catalog, store } = options;
  const now = options.now ?? Date.now;
  const blockedUntil = new Map<string, number>();
  const sessionId = crypto.randomUUID();

  return {
    model: catalog.id,
    adapter: `${catalog.provider}-fetch`,
    async *stream(request: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelStreamEvent> {
      const wire = getWire(catalog.wire);
      if (wire === undefined)
        throw new Error(`전송 형식을 아직 지원하지 않습니다: ${catalog.wire}`);
      const all = await store.list(catalog.provider);
      const accounts =
        options.account === undefined
          ? all
          : all.filter((account) => account.name === options.account);
      if (accounts.length === 0) {
        throw new Error(
          options.account === undefined
            ? `로그인한 ${catalog.provider} 계정이 없습니다. ora login ${catalog.provider}를 실행합니다.`
            : `${catalog.provider} 계정을 찾을 수 없습니다: ${options.account}`,
        );
      }
      let lastError: Error | undefined;
      for (const account of accounts) {
        if ((blockedUntil.get(account.name) ?? 0) > now()) continue;
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
