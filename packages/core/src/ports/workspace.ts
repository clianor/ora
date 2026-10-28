export interface PromptFile {
  readonly name: string;
  readonly content: string;
}

export interface InstructionFile {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
}

/** core가 직접 fs와 해시 함수를 쓰지 못하므로 호스트가 파일과 해시를 대신 준다. */
export interface WorkspacePort {
  readPromptFiles(): Promise<readonly PromptFile[]>;
  /** 저장소 루트에 가까운 디렉터리부터, 실제 경로가 같은 파일은 한 번만 돌려준다. */
  readInstructionFiles(): Promise<readonly InstructionFile[]>;
  /** 작업 폴더에서 저장소 루트까지 있는 하네스 파일과 디렉터리의 상대 경로다. */
  findHarnessFiles(): Promise<readonly string[]>;
  /** 16진수 SHA-256이다. */
  hashText(text: string): Promise<string>;
  /** 쓰기 범위 파일 내용의 해시다. `sha256:<16진수>` 형식이다. 없는 파일은 없다는 사실을 해시에 반영한다. */
  hashFiles(paths: readonly string[]): Promise<string>;
}
