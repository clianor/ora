import { join } from 'node:path';
import type { CostSettings } from '@ora/protocol';
import { loadConfig } from './config.ts';
import { updateConfigFile } from './config-file.ts';
import { resolveOraHome } from './isolation/ora-home.ts';

export interface CostApiOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly configPath?: string;
}

export interface CostApi {
  get(): Promise<CostSettings>;
  /** 설정 파일의 `session.maxCost`, `session.warnCost`, `pricing`만 바꾼다. 다른 키는 그대로 둔다. */
  set(next: CostSettings): Promise<CostSettings>;
}

/**
 * 비용 상한 설정을 읽고 쓰는 호스트 API다 (SPEC 5.4절). 설정 파일은 화면의 사용자 요청으로만 쓰고, 모델 도구는 이 경로에 닿지 못한다 (SPEC 5.7절).
 */
export function createCostApi(options: CostApiOptions): CostApi {
  const oraHome = resolveOraHome(options.env);
  const configFile = options.configPath ?? join(oraHome, 'engine.config.json');

  const get = async (): Promise<CostSettings> => {
    const config = await loadConfig(options.configPath, oraHome);
    return { ...config.session, pricing: config.pricing };
  };

  return {
    get,
    async set(next) {
      await updateConfigFile(configFile, (file) => ({
        ...file,
        session: { maxCost: next.maxCost, warnCost: next.warnCost },
        pricing: next.pricing,
      }));
      return get();
    },
  };
}
