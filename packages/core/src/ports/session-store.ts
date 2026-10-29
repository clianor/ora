import type { SessionRecord, Todo } from '@ora/protocol';

export interface SessionStore {
  saveSession(session: SessionRecord): Promise<void>;
  saveTodos(todos: readonly Todo[]): Promise<void>;
  /** 잘리지 않은 전체 출력을 저장하고, 이벤트에 적을 `outputRef`를 돌려준다. */
  writeArtifact(callId: string, content: string): Promise<string>;
  /** 압축 요약을 `compactions/<번호>.md`에 새로 쓰고 세션 디렉터리 기준 경로를 돌려준다. 있는 파일은 덮어쓰지 않는다. */
  writeCompaction(content: string): Promise<string>;
  /** 파일 도구가 처음 고치기 직전의 내용이다. 값이 `null`이면 그때 없던 파일이다. 키는 절대 경로다. */
  readBaselines(): Promise<Record<string, string | null>>;
}
