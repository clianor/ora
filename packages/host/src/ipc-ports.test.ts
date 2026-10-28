import type { ApprovalRequest, QuestionRequest, WorkerMessage } from '@ora/protocol';
import { expect, test } from 'vitest';
import { createIpcPorts } from './execute.ts';

const approvalRequest: ApprovalRequest = {
  callId: 'c1',
  tool: 'shell',
  tier: 'exec',
  reason: '실행한다',
  detail: { kind: 'shell', command: 'true', cwd: '/', risk: 'low' },
};
const questionRequest: QuestionRequest = {
  callId: 'c2',
  questions: [{ question: '고르시오', options: ['가', '나'] }],
};

// 소프트 스톱 직후에 요청이 오는 순간은 e2e로 만들 수 없어서 포트를 직접 부른다.
test('이미 중단된 신호로 승인을 요청하면 호스트에 올리지 않고 바로 거부하고, 질문은 바로 중단한다', async () => {
  const sent: WorkerMessage[] = [];
  const ports = createIpcPorts((message) => sent.push(message));
  const stopped = AbortSignal.abort();

  await expect(ports.approval.request(approvalRequest, stopped)).resolves.toEqual({
    outcome: 'denied',
  });
  await expect(ports.questions.ask(questionRequest, stopped)).rejects.toThrow();
  expect(sent).toEqual([]);
});

test('대기 중에 신호가 취소되면 호스트에 요청 철회를 알린다', async () => {
  const sent: WorkerMessage[] = [];
  const ports = createIpcPorts((message) => sent.push(message));
  const controller = new AbortController();

  const approval = ports.approval.request(approvalRequest, controller.signal);
  const question = ports.questions.ask(questionRequest, controller.signal);
  controller.abort();

  await expect(approval).resolves.toEqual({ outcome: 'denied' });
  await expect(question).rejects.toThrow();
  expect(sent.map((message) => message.type)).toEqual([
    'approval_request',
    'question_request',
    'request_withdrawn',
    'request_withdrawn',
  ]);
});
