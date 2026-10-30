import { realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { RestrictedFolderPort } from '@ora/core';

/** 경로가 없으면 가장 가까운 기존 상위 폴더의 realpath에 남은 이름을 붙인다. */
async function realpathOfNearest(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return resolve(await realpathOfNearest(parent), absolute.slice(parent.length + 1));
  }
}

/** 설정의 `permissions.restrictedFolders`를 realpath로 풀어 대상 경로가 그 안에 드는지 가른다. 심볼릭 링크로 돌아가도 같은 폴더로 본다. */
export function createRestrictedFolders(folders: readonly string[]): RestrictedFolderPort {
  return {
    async contains(path) {
      if (folders.length === 0) return false;
      const target = await realpathOfNearest(path);
      for (const folder of folders) {
        const root = await realpathOfNearest(folder);
        if (target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
          return true;
        }
      }
      return false;
    },
  };
}
