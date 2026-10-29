import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { withFileLock, writeFileAtomic } from '@ora/adapters';
import type { CostSettings } from '@ora/protocol';
import { UsageError, loadConfig, validateConfigObject } from './config.ts';
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
          if (error instanceof UsageError) throw error;
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new UsageError(`설정 파일을 읽을 수 없습니다: ${configFile}`);
          }
          file = { schemaVersion: 1, permissions: { mode: 'always-ask' } };
        }
        const updated = {
          ...file,
          session: { maxCost: next.maxCost, warnCost: next.warnCost },
          pricing: next.pricing,
        };
        validateConfigObject(updated);
        await writeFileAtomic(configFile, `${JSON.stringify(updated, null, 2)}\n`);
      });
      return get();
    },
  };
}
