import { execFile } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const CLI_PATH = fileURLToPath(new URL('./main.ts', import.meta.url));
const TOKEN = `sk-ant-api03-${'b'.repeat(32)}`;

interface Outcome {
  readonly code: number;
  readonly output: string;
}

function runOra(args: string[], env: Record<string, string>, home: string): Promise<Outcome> {
  const { promise, resolve } = Promise.withResolvers<Outcome>();
  execFile(
    process.execPath,
    [CLI_PATH, ...args],
    { cwd: home, env: { ...process.env, ORA_HOME: home, ANTHROPIC_API_KEY: '', ...env } },
    (error, stdout, stderr) => {
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, output: stdout + stderr });
    },
  );
  return promise;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

// `--model-script` 없이 설정의 실제 모델 경로를 조립하는 부분은 CLI를 실제로 띄워야 확인할 수 있다.
test('--model-script 없이 설정의 모델로 세션을 돌리고, 토큰은 세션 파일과 CLI 출력 어디에도 남지 않는다', async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(String(req.headers['x-api-key']));
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frames = [
      { type: 'message_start', message: { usage: { input_tokens: 3 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: `토큰은 ${TOKEN}` },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ];
    res.end(
      frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''),
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const home = mkdtempSync(join(tmpdir(), 'ora-model-'));
    mkdirSync(join(home, 'work'));
    const config = join(home, 'config.json');
    writeFileSync(
      config,
      JSON.stringify({
        schemaVersion: 1,
        limits: { maxSteps: 2 },
        providers: {
          anthropic: {
            model: 'test-model',
            baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          },
        },
      }),
    );
    const result = await runOra(
      ['run', '작업', '--config', config],
      { ANTHROPIC_API_KEY: TOKEN },
      home,
    );

    expect(seen[0]).toBe(TOKEN);
    const files = filesUnder(join(home, 'sessions'));
    const transcript = files.find((path) => path.endsWith('transcript.jsonl')) ?? '';
    expect(readFileSync(transcript, 'utf8')).toContain('"adapter":"anthropic"');
    for (const path of files) expect(readFileSync(path, 'utf8')).not.toContain(TOKEN);
    expect(result.output).not.toContain(TOKEN);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}, 60_000);

// 설정의 `providers.claude.command`를 따라 `ora run`이 가짜 claude 프로세스로 세션을 끝까지 돌린다. `via`를 생략하면 SDK 경로다.
test.each([
  { via: undefined, adapter: 'claude-sdk' },
  { via: 'cli', adapter: 'claude-cli' },
])(
  'providers.claude 설정(via $via)으로 세션을 돌리면 기록에 $adapter 사용량이 남고 API 키 환경변수는 자식에게 넘어가지 않는다',
  async ({ via, adapter }) => {
    const home = mkdtempSync(join(tmpdir(), 'ora-claude-e2e-'));
    mkdirSync(join(home, 'work'));
    const fake = join(home, 'fake-claude.mjs');
    writeFileSync(
      fake,
      `import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const out = (value) => console.log(JSON.stringify(value));
const emit = (event) => out({ type: 'stream_event', event });
let system = process.argv[process.argv.indexOf('--system-prompt') + 1];
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.type === 'control_request') {
    system = msg.request.systemPrompt?.join('\\n') ?? system;
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { commands: [], agents: [], output_style: 'default', available_output_styles: [], models: [], account: {} } } });
    continue;
  }
  if (msg.type !== 'user') continue;
  writeFileSync('fake-info.json', JSON.stringify({ cwd: process.cwd(), system }));
  emit({ type: 'message_start', message: { usage: { input_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 } } });
  emit({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
  emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'key=' + String(process.env.ANTHROPIC_API_KEY) } });
  emit({ type: 'content_block_stop', index: 0 });
  emit({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } });
  emit({ type: 'message_stop' });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
}
`,
    );
    const config = join(home, 'config.json');
    writeFileSync(
      config,
      JSON.stringify({
        schemaVersion: 1,
        limits: { maxSteps: 2 },
        providers: {
          claude: {
            model: 'claude-haiku-5-5',
            effort: 'low',
            command: [[process.execPath, fake]],
            ...(via === undefined ? {} : { via }),
          },
        },
      }),
    );
    const result = await runOra(
      ['run', '작업', '--config', config],
      { ANTHROPIC_API_KEY: TOKEN },
      home,
    );

    const files = filesUnder(join(home, 'sessions'));
    const transcript = readFileSync(
      files.find((path) => path.endsWith('transcript.jsonl')) ?? '',
      'utf8',
    );
    expect(transcript).toContain(`"adapter":"${adapter}"`);
    expect(transcript).toContain('"cacheReadInputTokens":5');
    expect(transcript).toContain('"cacheCreationInputTokens":7');
    expect(transcript).toContain('key=undefined');
    const info = JSON.parse(readFileSync(join(home, 'fake-info.json'), 'utf8')) as {
      cwd: string;
      system: string;
    };
    expect(info.cwd.endsWith(basename(home))).toBe(true);
    expect(info.system).toContain(`## 작업 폴더\n- 경로: `);
    expect(info.system).toContain(basename(home));
    for (const path of files) expect(readFileSync(path, 'utf8')).not.toContain(TOKEN);
    expect(result.output).not.toContain(TOKEN);
  },
  60_000,
);

test('모델 이름이나 토큰이 없으면 세션을 시작하지 않고 사용법 오류(종료 코드 2)로 멈춘다', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ora-model-'));
  const noModel = join(home, 'no-model.json');
  writeFileSync(noModel, JSON.stringify({ schemaVersion: 1 }));
  const withModel = join(home, 'with-model.json');
  writeFileSync(
    withModel,
    JSON.stringify({ schemaVersion: 1, providers: { anthropic: { model: 'test-model' } } }),
  );

  const missingModel = await runOra(['run', '작업', '--config', noModel], {}, home);
  expect(missingModel.code).toBe(2);
  expect(missingModel.output).toContain('providers.anthropic.model');

  const missingToken = await runOra(['run', '작업', '--config', withModel], {}, home);
  expect(missingToken.code).toBe(2);
  expect(missingToken.output).toContain('ANTHROPIC_API_KEY');

  const valueInConfig = join(home, 'leak.json');
  writeFileSync(
    valueInConfig,
    JSON.stringify({
      schemaVersion: 1,
      providers: { anthropic: { model: 'm', credentialEnv: [TOKEN] } },
    }),
  );
  const rejected = await runOra(['run', '작업', '--config', valueInConfig], {}, home);
  expect(rejected.code).toBe(2);
  expect(rejected.output).not.toContain(TOKEN);
}, 60_000);
