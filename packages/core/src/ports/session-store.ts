import type { SessionRecord, Todo } from '@ora/protocol';

export interface SessionStore {
  saveSession(session: SessionRecord): Promise<void>;
  saveTodos(todos: readonly Todo[]): Promise<void>;
  /** 잘리지 않은 전체 출력을 저장하고, 이벤트에 적을 `outputRef`를 돌려준다. */
  writeArtifact(callId: string, content: string): Promise<string>;
}
