const HARNESS_CLI_NAMES = ['claude', 'pi', 'omp', 'codex', 'gemini'];

/**
 * 셸 명령의 첫 실행 단어가 하네스 CLI면 그 이름을 돌려준다.
 * 앞쪽의 `NAME=값` 환경변수 지정과 실행 파일 경로의 디렉터리는 건너뛴다.
 * 한계: 첫 단어만 보는 단순한 판정이라 `sh -c "claude"`, `env claude`, `$(…)` 같은 우회는 막지 못한다.
 */
export function findHarnessCliCall(command: string): string | undefined {
  const word = command
    .trim()
    .split(/\s+/)
    .find((part) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(part));
  const name = word?.split('/').pop();
  return name !== undefined && HARNESS_CLI_NAMES.includes(name) ? name : undefined;
}
