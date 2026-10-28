import { spawn } from 'node:child_process';
import { isSecretEnvKey } from '@ora/core';
import type { CommandResult, CommandRunner } from '@ora/core';

// ponytail: 스트림마다 이 크기까지만 모은다. 넘는 출력은 버리므로 전체 출력이 이보다 크면 artifact도 잘린다.
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

function createCapture(): { push(chunk: Buffer): void; text(): string } {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    push(chunk) {
      if (size >= MAX_CAPTURE_BYTES) return;
      chunks.push(chunk);
      size += chunk.length;
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

/** `sh -c`로 명령을 실행한다. 시간 초과나 취소 때 프로세스 그룹 전체를 종료한다. */
export function createCommandRunner(): CommandRunner {
  return {
    run(request) {
      const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
      const started = Date.now();
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !isSecretEnvKey(key)),
      );
      const child = spawn('sh', ['-c', request.command], {
        cwd: request.cwd,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout = createCapture();
      const stderr = createCapture();
      let timedOut = false;

      const killGroup = () => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // 이미 끝난 프로세스 그룹이다.
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, request.timeoutMs);
      request.signal.addEventListener('abort', killGroup, { once: true });
      if (request.signal.aborted) killGroup();

      child.stdout.on('data', (chunk: Buffer) => {
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr.push(chunk);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', killGroup);
        resolve({
          ...(code === null || timedOut ? {} : { exitCode: code }),
          timedOut,
          stdout: stdout.text(),
          stderr: stderr.text(),
          durationMs: Date.now() - started,
        });
      });
      return promise;
    },
  };
}
