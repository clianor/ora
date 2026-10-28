export interface CommandRequest {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/** 종료 코드는 프로세스가 시간 초과나 신호로 끝났을 때 없다. */
export interface CommandResult {
  readonly exitCode?: number;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>;
}
