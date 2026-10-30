import type { UserTodoAction } from '@ora/core';
import { workerCommandSchema } from '@ora/protocol';
import type { LaunchCommand, WorkerMessage } from '@ora/protocol';
import { UsageError } from './config.ts';
import { createIpcPorts, executeSession } from './execute.ts';

// 세션 워커 진입점이다. 호스트가 `fork`로 띄우고 IPC로 명령을 받는다 (SPEC 2.2.1절).
const hard = new AbortController();
const soft = new AbortController();
// 워커의 도구와 셸이 ELECTRON_RUN_AS_NODE를 물려받지 않게 한다.
delete process.env.ELECTRON_RUN_AS_NODE;
// 호스트가 보낸 포기·포기 취소다. 엔진이 스텝이 끝날 때 꺼내 간다.
const todoActions: UserTodoAction[] = [];

function send(message: WorkerMessage, then: () => void = () => undefined): void {
  process.send?.(message, then);
}

const ports = createIpcPorts(send);

function start(command: LaunchCommand): void {
  executeSession(command, {
    env: process.env,
    signal: hard.signal,
    softStop: soft.signal,
    userTodoActions: { drain: () => todoActions.splice(0) },
    onEvent: (event) => {
      send({ type: 'event', event });
    },
    ...(command.interactive === true
      ? { approval: ports.approval, questions: ports.questions }
      : {}),
  })
    .then(
      (outcome) => {
        send({ type: 'result', ...outcome, todos: [...outcome.todos] }, () => process.exit(0));
      },
      (error: unknown) => {
        if (!(error instanceof UsageError)) throw error;
        send({ type: 'usage_error', message: error.message }, () => process.exit(0));
      },
    )
    .catch((error: unknown) => {
      // 예기치 않은 오류는 워커를 비정상 종료시켜 호스트가 crashed로 기록하게 한다.
      console.error(error);
      process.exit(1);
    });
}

process.on('message', (raw) => {
  const command = workerCommandSchema.parse(raw);
  switch (command.type) {
    case 'createSession':
    case 'resumeSession':
      start(command);
      break;
    case 'resolveApproval':
      ports.resolveApproval(command.requestId, command.decision);
      break;
    case 'answerQuestion':
      ports.answerQuestion(command.requestId, command.answers);
      break;
    case 'todoAction':
      todoActions.push({ todoId: command.todoId, action: command.action });
      break;
    case 'cancel':
      if (command.mode === 'soft') {
        soft.abort();
      } else {
        // abort가 도구의 셸 프로세스 그룹을 먼저 끊고, 이어서 워커 그룹을 종료한다.
        hard.abort();
        try {
          process.kill(-process.pid, 'SIGKILL');
        } catch {
          process.kill(process.pid, 'SIGKILL');
        }
      }
      break;
  }
});

// 호스트가 사라지면 아무도 결과를 받지 못하므로 도구를 끊고 멈춘다. 기록은 다음 재개 때 봉인한다.
process.on('disconnect', () => {
  hard.abort();
  process.exit(1);
});
