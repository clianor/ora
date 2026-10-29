import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { withFileLock, writeFileAtomic } from '@ora/adapters';
import { UsageError, validateConfigObject } from './config.ts';

/** 설정 파일을 읽어 `update`가 만든 객체로 바꿔 쓴다. 파일이 없으면 `always-ask` 기본 설정에서 시작한다. 쓰기 전에 스키마로 검사한다. */
export async function updateConfigFile(
  configFile: string,
  update: (file: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
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
    const updated = update(file);
    validateConfigObject(updated);
    await writeFileAtomic(configFile, `${JSON.stringify(updated, null, 2)}\n`);
  });
}
