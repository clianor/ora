import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { ModelRequest, ModelStreamEvent } from '@ora/core';
import { expect, test, vi } from 'vitest';
import { createClaudeCliModel } from './claude-cli.ts';
import { ClaudeLimitError } from './claude-shared.ts';

// 가짜 `claude`다. stream-json을 흉내 내고, 도구 호출은 MCP 서버에 실제로 POST한다.
const FAKE_SOURCE = `
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const mode = args[0];
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const log = (record) => appendFileSync(process.env.FAKE_LOG, JSON.stringify(record) + '\\n');
log({ kind: 'start', pid: process.pid, mode, resume: flag('--resume'), session: flag('--session-id'),
  ttl: process.env.CLAUDE_CODE_PROMPT_CACHE_TTL, apiKey: process.env.ANTHROPIC_API_KEY ?? null,
  cwd: process.cwd(), leak: process.env.ORA_TEST_LEAK ?? null, noPersist: args.includes('--no-session-persistence'), mds: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, system: flag('--system-prompt'), tools: flag('--tools'), strict: args.includes('--strict-mcp-config') });
console.log('Launching fake account');
if (mode === 'resume-strict' && flag('--resume') !== undefined) process.exit(1);
const mcp = JSON.parse(readFileSync(flag('--mcp-config'), 'utf8')).mcpServers.ora;
const emit = (value) => console.log(JSON.stringify(value));
const frame = (event) => emit({ type: 'stream_event', event });
const call = async (id, name, input) => {
  const response = await fetch(mcp.url, { method: 'POST',
    headers: { 'content-type': 'application/json', ...mcp.headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: input, _meta: { 'claudecode/toolUseId': id } } }) });
  const body = await response.json();
  log({ kind: 'result', id, text: body.result.content[0].text, isError: body.result.isError });
};
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
  const text = JSON.parse(line).message.content.map((block) => block.text).join('\\n');
  log({ kind: 'input', text });
  if (mode === 'limit') {
    emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } });
    emit({ type: 'result', is_error: true, result: 'usage limit reached' });
  } else if (text.includes('TOOLS')) {
    message([{ type: 'tool_use', id: 'toolu_a', name: 'mcp__ora__todo__update', input: { a: 1 } },
             { type: 'tool_use', id: 'toolu_b', name: 'mcp__ora__todo__update', input: { b: 2 } }], 'tool_use');
    await Promise.all([call('toolu_a', 'todo__update', { a: 1 }), call('toolu_b', 'todo__update', { b: 2 })]);
    if (mode === 'slow') await new Promise(() => {});
    message([{ type: 'text', text: 'finished' }], 'end_turn');
    emit({ type: 'result', is_error: false });
  } else {
    message([{ type: 'text', text: 'plain reply' }], 'end_turn');
    emit({ type: 'result', is_error: false });
  }
}
`;

const dir = mkdtempSync(join(tmpdir(), 'ora-claude-test-'));
const fakePath = join(dir, 'fake-claude.mjs');
writeFileSync(fakePath, FAKE_SOURCE);
const workFolder = mkdtempSync(join(tmpdir(), 'ora-claude-work-'));

interface LogRecord {
  kind: string;
  [key: string]: unknown;
}

function newModel(modes: string[], resumeSession?: string, persistSession = true) {
  const logPath = join(dir, `${crypto.randomUUID()}.jsonl`);
  writeFileSync(logPath, '');
  const commands = modes.map((mode) => [
    'env',
    `FAKE_LOG=${logPath}`,
    process.execPath,
    fakePath,
    mode,
  ]);
  const model = createClaudeCliModel({
    model: 'claude-haiku-5-5',
    effort: 'low',
    cacheTtl: '1h',
    commands,
    env: { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-api03-secret', ORA_TEST_LEAK: 'x' },
    cwd: workFolder,
    persistSession,
    ...(resumeSession === undefined
      ? {}
      : {
          resumeFrom: {
            claudeSessionId: resumeSession,
            commandIndex: 0,
            command: commands[0] ?? [],
            historyLength: 2,
          },
        }),
  });
  const readLog = (): LogRecord[] =>
    readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as LogRecord);
  return { model, commands, readLog };
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

// 자식 프로세스 입출력 경계라 e2e가 병렬 tool_use와 사용량 숫자를 만들 수 없다.
test('병렬 tool_use를 callId로 풀고 안내를 마지막 결과에 덧붙이며, 사용량 네 필드와 격리 조건을 지킨다', async () => {
  const { model, readLog } = newModel(['ok']);
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
  const metadata = JSON.stringify(first.providerMetadata);
  expect(metadata).toContain('claudeSessionId');
  expect(metadata).not.toContain('x-ora-token');

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
  expect(starts[0]).toMatchObject({
    ttl: '1h',
    apiKey: null,
    system,
    tools: '',
    strict: true,
  });
  expect(String(starts[0]?.cwd).endsWith(basename(workFolder))).toBe(true);
  expect(starts[0]).toMatchObject({ mds: '1', leak: null, noPersist: false });
});

// 응답하지 않는 자식 프로세스는 e2e가 만들 수 없다.
test('하드 킬: 신호를 취소하면 스트림이 끝나고 프로세스가 죽는다', async () => {
  const { model, readLog } = newModel(['slow']);
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

// 엔진은 history를 어긋나게 보내지 않으므로 e2e가 입력을 만들 수 없다.
test('history가 전달한 수와 어긋나면 프로세스를 다시 띄우고 기록 전체를 다시 넣는다', async () => {
  const { model, readLog } = newModel(['ok']);
  const system = 's';
  const first = await collect(model.stream({ system, messages: [user('안녕')], tools }, signal()));
  await collect(
    model.stream(
      {
        system,
        tools,
        messages: [
          user('안녕'),
          { role: 'assistant', content: first.content },
          user('둘째'),
          { role: 'assistant', content: [{ type: 'text', text: '답' }] },
          user('셋째'),
        ],
      },
      signal(),
    ),
  );
  const records = readLog();
  const starts = records.filter((record) => record.kind === 'start');
  expect(starts).toHaveLength(2);
  expect(starts[1]?.session).not.toBe(starts[0]?.session);
  const inputs = records.filter((record) => record.kind === 'input');
  expect(inputs[0]?.text).toBe('안녕');
  expect(String(inputs[1]?.text)).toContain('<conversation_history>');
  expect(String(inputs[1]?.text)).toContain('둘째');
});

// 세션 파일이 없는 상황은 e2e가 만들 수 없다.
test('--resume으로 이어 가고, 실패하면 기록을 다시 넣는 방식으로 넘어간다', async () => {
  const messages = [
    user('안녕'),
    { role: 'assistant' as const, content: [{ type: 'text' as const, text: '반가워요' }] },
    user('이어서'),
  ];

  const resumed = newModel(['ok'], 'sess-1');
  await collect(resumed.model.stream({ system: 's', messages, tools }, signal()));
  const resumedRecords = resumed.readLog();
  expect(resumedRecords.find((record) => record.kind === 'start')?.resume).toBe('sess-1');
  expect(resumedRecords.find((record) => record.kind === 'input')?.text).toContain('이어서');

  const strict = newModel(['resume-strict'], 'sess-1');
  const completed = await collect(strict.model.stream({ system: 's', messages, tools }, signal()));
  expect(completed.content).toEqual([{ type: 'text', text: 'plain reply' }]);
  const strictRecords = strict.readLog();
  expect(
    strictRecords.filter((record) => record.kind === 'start').map((record) => record.resume),
  ).toEqual(['sess-1', undefined]);
  expect(strictRecords.find((record) => record.kind === 'input')?.text).toContain(
    '<conversation_history>',
  );

  const clean = newModel(['ok'], 'sess-1', false);
  await collect(clean.model.stream({ system: 's', messages, tools }, signal()));
  const cleanStart = clean.readLog().find((record) => record.kind === 'start');
  expect(cleanStart?.resume).toBeUndefined();
  expect(cleanStart?.noPersist).toBe(true);
});

// 실제 한도를 일으킬 수 없다.
test('한도 오류가 나면 다음 명령으로 전환하고, 명령이 하나면 한도 오류로 끝낸다', async () => {
  const switching = newModel(['limit', 'ok']);
  const completed = await collect(
    switching.model.stream({ system: 's', messages: [user('안녕')], tools }, signal()),
  );
  expect(completed.content).toEqual([{ type: 'text', text: 'plain reply' }]);
  expect(
    switching
      .readLog()
      .filter((record) => record.kind === 'start')
      .map((record) => record.mode),
  ).toEqual(['limit', 'ok']);

  const single = newModel(['limit']);
  await expect(
    collect(single.model.stream({ system: 's', messages: [user('안녕')], tools }, signal())),
  ).rejects.toBeInstanceOf(ClaudeLimitError);
});
