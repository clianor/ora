const storageKey = 'ora-composer-drafts';

/** 덮어쓰기 경고에서 새 worktree를 만드는 동안 지시문을 들고 있는 임시 키입니다. 새 탭이 열리면 그 탭의 키로 옮깁니다. */
export const pendingWorktreeKey = 'pending-worktree';

function readAll(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

function writeAll(drafts: Record<string, string>): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(drafts));
  } catch {
    // 저장 공간을 쓸 수 없으면 이번 보관만 건너뜁니다.
  }
}

/** 보내지 않은 입력창 글입니다. 없으면 빈 문자열입니다. */
export function getComposerDraft(key: string): string {
  return readAll()[key] ?? '';
}

/** 글이 비어 있으면 지우고, 있으면 그 키로 보관합니다. */
export function setComposerDraft(key: string, text: string): void {
  const others = Object.entries(readAll()).filter(([other]) => other !== key);
  writeAll(Object.fromEntries(text === '' ? others : [...others, [key, text]]));
}

/** 글을 보냈거나 탭을 닫았을 때 보관한 글을 지웁니다. */
export function clearComposerDraft(key: string): void {
  setComposerDraft(key, '');
}
