import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { ModelRequest, ModelStreamEvent } from '@ora/core';
import { expect, test, vi } from 'vitest';
import { createClaudeSdkModel } from './claude-sdk.ts';

// 가짜 `claude`다. SDK와 stream-json 제어 프로토콜로 대화하고, 도구 호출은 `mcp_message` 제어 요청으로 SDK의 MCP 서버에 보낸다.
const FAKE_SOURCE = `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const mode = process.argv[2];
const log = (record) => appendFileSync(process.env.FAKE_LOG, JSON.stringify(record) + '\\n');
log({ kind: 'start', pid: process.pid, mode, argv: process.argv.slice(3), cwd: process.cwd(),
  ttl: process.env.CLAUDE_CODE_PROMPT_CACHE_TTL, apiKey: process.env.ANTHROPIC_API_KEY ?? null,
  leak: process.env.ORA_TEST_LEAK ?? null, mds: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS });
const emit = (value) => console.log(JSON.stringify(value));
const frame = (event) => emit({ type: 'stream_event', event, session_id: 's', uuid: crypto.randomUUID(), parent_tool_use_id: null });
const waiters = new Map();
let counter = 0;
const call = (id, input) => new Promise((resolve) => {
  counter += 1;
  const requestId = 'r' + counter;
  waiters.set(requestId, (result) => { log({ kind: 'result', id, text: result.content[0].text, isError: result.isError }); resolve(); });
  emit({ type: 'control_request', request_id: requestId, request: { subtype: 'mcp_message', server_name: 'ora',
    message: { jsonrpc: '2.0', id: counter, method: 'tools/call',
      params: { name: 'todo__update', arguments: input, _meta: { 'claudecode/toolUseId': id } } } } });
});
const message = (blocks, stop) => {
  frame({ type: 'message_start', message: { usage: { input_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 } } });
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      frame({ type: 'content_block_start', index, content_block: { type: 'text' } });
      frame({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else {
      frame({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name } });
      frame({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    frame({ type: 'content_block_stop', index });
  });
  frame({ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 4 } });
  frame({ type: 'message_stop' });
};
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.type === 'control_request') {
    emit({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id,
      response: { commands: [], agents: [], output_style: 'default', available_output_styles: [], models: [], account: {} } } });
  } else if (msg.type === 'control_response') {
    waiters.get(msg.response.request_id)?.(msg.response.response.mcp_response.result);
  } else if (msg.type === 'user') {
    const text = msg.message.content.map((block) => block.text).join('\\n');
    log({ kind: 'input', text });
    if (text.includes('TOOLS')) {
      message([{ type: 'tool_use', id: 'toolu_a', name: 'mcp__ora__todo__update', input: { a: 1 } },
               { type: 'tool_use', id: 'toolu_b', name: 'mcp__ora__todo__update', input: { b: 2 } }], 'tool_use');
      Promise.all([call('toolu_a', { a: 1 }), call('toolu_b', { b: 2 })]).then(() => {
        if (mode === 'slow') return;
        message([{ type: 'text', text: 'finished' }], 'end_turn');
        emit({ type: 'result', subtype: 'success', is_error: false, result: 'finished' });
      });
    }
  }
}
`;

const dir = mkdtempSync(join(tmpdir(), 'ora-sdk-test-'));
const fakePath = join(dir, 'fake-claude.mjs');
writeFileSync(fakePath, FAKE_SOURCE);
const workFolder = mkdtempSync(join(tmpdir(), 'ora-sdk-work-'));

interface LogRecord {
  kind: string;
  [key: string]: unknown;
}

function newModel(mode: string) {
  const logPath = join(dir, `${crypto.randomUUID()}.jsonl`);
  writeFileSync(logPath, '');
  const model = createClaudeSdkModel({
    model: 'claude-haiku-5-5',
    effort: 'low',
    cacheTtl: '1h',
    commands: [['env', `FAKE_LOG=${logPath}`, process.execPath, fakePath, mode]],
    env: { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-api03-secret', ORA_TEST_LEAK: 'x' },
    cwd: workFolder,
    persistSession: true,
  });
  const readLog = (): LogRecord[] =>
    readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as LogRecord);
  return { model, readLog };
}

const tools = [{ name: 'todo.update', description: 'todo', inputSchema: { type: 'object' } }];
const user = (text: string): ModelRequest['messages'][number] => ({
  role: 'user',
  content: [{ type: 'text', text }],
});

async function collect(stream: AsyncIterable<ModelStreamEvent>) {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  const completed = events.find((event) => event.type === 'completed');
  if (completed?.type !== 'completed') throw new Error('completed 없음');
  return completed;
}

const signal = () => new AbortController().signal;

// SDK가 띄우는 자식 프로세스와의 제어 프로토콜은 e2e가 만들 수 없다.
test('SDK 경로: 병렬 tool_use를 callId로 풀고 안내를 덧붙이며, 명령 앞붙임·cwd·환경·사용량을 지킨다', async () => {
  const { model, readLog } = newModel('ok');
  const system = 'Ora 시스템 프롬프트';
  const first = await collect(
    model.stream({ system, messages: [user('TOOLS 실행')], tools }, signal()),
  );
  expect(first.stopReason).toBe('tool_use');
  expect(first.content.filter((block) => block.type === 'tool_use')).toEqual([
    { type: 'tool_use', callId: 'toolu_a', tool: 'todo.update', input: { a: 1 } },
    { type: 'tool_use', callId: 'toolu_b', tool: 'todo.update', input: { b: 2 } },
  ]);
  expect(first.usage).toEqual({
    uncachedInputTokens: 3,
    cacheReadInputTokens: 5,
    cacheCreationInputTokens: 7,
    outputTokens: 4,
  });
  expect(JSON.stringify(first.providerMetadata)).toContain('claudeSessionId');

  const second = await collect(
    model.stream(
      {
        system,
        tools,
        messages: [
          user('TOOLS 실행'),
          { role: 'assistant', content: first.content },
          {
            role: 'user',
            content: [
              { type: 'tool_result', callId: 'toolu_b', text: 'RB', isError: false },
              { type: 'tool_result', callId: 'toolu_a', text: 'RA', isError: true },
              { type: 'text', text: '[안내] 단계: 구현' },
            ],
          },
        ],
      },
      signal(),
    ),
  );
  expect(second.content).toEqual([{ type: 'text', text: 'finished' }]);

  const records = readLog();
  const results = records.filter((record) => record.kind === 'result');
  expect(results.find((record) => record.id === 'toolu_a')).toMatchObject({
    text: 'RA\n\n[안내] 단계: 구현',
    isError: true,
  });
  expect(results.find((record) => record.id === 'toolu_b')).toMatchObject({
    text: 'RB',
    isError: false,
  });
  const starts = records.filter((record) => record.kind === 'start');
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({ mode: 'ok', ttl: '1h', apiKey: null, leak: null, mds: '1' });
  expect(starts[0]?.argv).not.toContain('--no-session-persistence');
  expect(String(starts[0]?.cwd).endsWith(basename(workFolder))).toBe(true);
  expect(starts[0]?.argv).toEqual(
    expect.arrayContaining([
      '--tools=',
      '--setting-sources=',
      '--strict-mcp-config',
      '--model=claude-haiku-5-5',
      '--effort=low',
      '--disable-slash-commands',
    ]),
  );
});

// 응답하지 않는 자식 프로세스는 e2e가 만들 수 없다.
test('SDK 경로 하드 킬: 신호를 취소하면 스트림이 끝나고 프로세스가 죽는다', async () => {
  const { model, readLog } = newModel('slow');
  const system = 's';
  const first = await collect(
    model.stream({ system, messages: [user('TOOLS 실행')], tools }, signal()),
  );
  const controller = new AbortController();
  const pending = collect(
    model.stream(
      {
        system,
        tools,
        messages: [
          user('TOOLS 실행'),
          { role: 'assistant', content: first.content },
          {
            role: 'user',
            content: [
              { type: 'tool_result', callId: 'toolu_a', text: 'RA', isError: false },
              { type: 'tool_result', callId: 'toolu_b', text: 'RB', isError: false },
            ],
          },
        ],
      },
      controller.signal,
    ),
  ).catch((error: unknown) => error);
  await vi.waitFor(() => {
    expect(readLog().filter((record) => record.kind === 'result')).toHaveLength(2);
  });
  controller.abort(new Error('중단'));
  expect(await pending).toEqual(new Error('중단'));
  const pid = readLog().find((record) => record.kind === 'start')?.pid as number;
  await vi.waitFor(() => {
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
