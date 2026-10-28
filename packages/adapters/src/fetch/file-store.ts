import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const LOCK_RETRY_MS = 25;
/** 락 안에서 네트워크 호출(토큰 갱신, 30초 제한)을 하므로 대기 시간과 stale 판정은 그보다 길어야 한다. */
const LOCK_TIMEOUT_MS = 60_000;
const LOCK_STALE_MS = 90_000;

const readLockOwner = (lockPath: string): Promise<string | undefined> =>
  readFile(lockPath, 'utf8').catch(() => undefined);

/**
 * 락 파일을 `wx`로 만들어 잡고 `action`을 실행한다. 락 파일에는 소유자 토큰을 적어서,
 * 해제와 stale 제거는 내용이 같을 때만 지운다. 시간 안에 잡지 못하면 예외를 던진다.
 */
export async function withFileLock<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
  const deadline = performance.now() + LOCK_TIMEOUT_MS;
  const owner = `${String(process.pid)}:${randomUUID()}`;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(owner);
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const held = await stat(lockPath).catch(() => undefined);
      if (held !== undefined && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
        const seen = await readLockOwner(lockPath);
        if (seen !== undefined && seen === (await readLockOwner(lockPath))) {
          await rm(lockPath, { force: true });
        }
        continue;
      }
      if (performance.now() > deadline)
        throw new Error(`${basename(lockPath)}을 잡지 못했습니다.`, { cause: error });
      await delay(LOCK_RETRY_MS);
    }
  }
  try {
    return await action();
  } finally {
    if ((await readLockOwner(lockPath)) === owner) await rm(lockPath, { force: true });
  }
}

/** 임시 파일에 쓰고 fsync한 뒤 이름을 바꿔 적용한다. 쓰는 도중 프로세스가 죽어도 원본이 남는다. */
export async function writeFileAtomic(path: string, body: string, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  try {
    const handle = await open(temporary, 'w', mode);
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
