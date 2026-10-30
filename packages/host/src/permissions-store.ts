import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import { ruleKey } from '@ora/core';
import type { AlwaysApprovalPort } from '@ora/core';
import type { ApprovalRule, PermissionsFile } from '@ora/protocol';
import { permissionsFileSchema } from '@ora/protocol';

export const PERMISSIONS_FILE = 'permissions.json';

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 3000;
// 락을 잡은 워커가 죽으면 락 파일이 남으므로 이 시간이 지난 락은 버리고 다시 잡는다.
const LOCK_STALE_MS = 10_000;

/** 락 파일을 `wx`로 만들어 잡는다. 시간 안에 잡지 못하면 예외를 던진다. */
async function withFileLock<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
  const deadline = performance.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await (await open(lockPath, 'wx')).close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const held = await stat(lockPath).catch(() => undefined);
      if (held !== undefined && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (performance.now() > deadline)
        throw new Error('permissions.json 락을 잡지 못했습니다.', { cause: error });
      await new Promise((done) => setTimeout(done, LOCK_RETRY_MS));
    }
  }
  try {
    return await action();
  } finally {
    await rm(lockPath, { force: true });
  }
}

export interface PermissionsStore extends AlwaysApprovalPort {
  /** 저장된 규칙이다. 파일이 깨졌으면 규칙 대신 이유를 돌려준다. */
  list(): Promise<{ rules: ApprovalRule[]; error?: undefined } | { error: string }>;
  /** 규칙 하나를 지운다. 파일이 깨졌으면 지우지 않고 이유를 돌려준다. */
  remove(key: string): Promise<{ removed: true } | { removed: false; reason: string }>;
}

/**
 * `<oraHome>/permissions.json`에 "항상 승인"을 저장한다 (SPEC 5.1절). 사용자가 파일을 직접 고칠 수 있으므로 읽을 때마다 파일을 다시 읽는다.
 * 읽지 못하는 파일(깨졌거나 권한 오류)은 규칙이 없는 것으로 보고 항상 묻는다. 그런 파일은 덮어쓰지 않으며, 저장에 실패하면 이유를 돌려준다.
 * 워커 여러 개가 동시에 쓸 수 있어서 읽고 고쳐 쓰는 구간을 락 파일로 직렬화한다.
 */
export function createPermissionsStore(path: string): PermissionsStore {
  let warned = false;
  const warn = (reason: string) => {
    if (warned) return;
    warned = true;
    process.stderr.write(`경고: ${path}를 읽을 수 없어 항상 승인을 쓰지 않습니다: ${reason}\n`);
  };
  /** 파일이 없으면 빈 규칙, 읽지 못하면 이유를 돌려준다. */
  const read = async (): Promise<
    { file: PermissionsFile; error?: undefined } | { error: string }
  > => {
    try {
      const text = await readFile(path, 'utf8');
      return { file: permissionsFileSchema.parse(JSON.parse(text)) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { file: { schemaVersion: 1, rules: [] } };
      }
      const reason = error instanceof Error ? error.message : String(error);
      warn(reason);
      return { error: reason };
    }
  };
  /** 읽고 고쳐 쓰는 구간이다. 임시 파일에 쓴 뒤 이름을 바꿔 덮어쓴다. */
  const rewrite = async <T>(
    change: (file: PermissionsFile) => { file: PermissionsFile; result: T } | { error: string },
  ): Promise<{ value: T } | { error: string }> => {
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      return await withFileLock(`${path}.lock`, async () => {
        const current = await read();
        if (current.error !== undefined) {
          return { error: `permissions.json을 읽을 수 없습니다: ${current.error}` };
        }
        const changed = change(current.file);
        if ('error' in changed) return changed;
        const body = `${JSON.stringify(changed.file, null, 2)}\n`;
        const handle = await open(temporary, 'w');
        try {
          await handle.writeFile(body);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, path);
        return { value: changed.result };
      });
    } catch (error) {
      await rm(temporary, { force: true });
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
  return {
    async has(rule) {
      const key = ruleKey(rule);
      const result = await read();
      return (
        result.error === undefined && result.file.rules.some((entry) => ruleKey(entry) === key)
      );
    },
    async add(rule) {
      const key = ruleKey(rule);
      const done = await rewrite((file) =>
        file.rules.some((entry) => ruleKey(entry) === key)
          ? { file, result: undefined }
          : { file: { ...file, rules: [...file.rules, rule] }, result: undefined },
      );
      return 'error' in done ? { saved: false, reason: done.error } : { saved: true };
    },
    async list() {
      const result = await read();
      return result.error === undefined ? { rules: result.file.rules } : { error: result.error };
    },
    async remove(key) {
      const done = await rewrite((file) => ({
        file: { ...file, rules: file.rules.filter((entry) => ruleKey(entry) !== key) },
        result: undefined,
      }));
      return 'error' in done ? { removed: false, reason: done.error } : { removed: true };
    },
  };
}
