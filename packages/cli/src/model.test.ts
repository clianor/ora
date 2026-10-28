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
test('--model-script 없이 API 키 계정(ora login --api-key-env)으로 세션을 돌리고, 키는 세션 파일과 CLI 출력 어디에도 남지 않는다', async () => {
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
        providers: { claude: { model: 'test-model' } },
        models: [
          {
            id: 'test-model',
            provider: 'claude',
            wire: 'anthropic-messages',
            baseUrl: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
            contextWindow: 200000,
            maxOutputTokens: 1000,
          },
        ],
      }),
    );
    const login = await runOra(
      ['login', 'claude', '--name', 'key', '--api-key-env', 'MY_ORA_KEY'],
      {},
      home,
    );
    expect(login.code).toBe(0);
    const result = await runOra(['run', '작업', '--config', config], { MY_ORA_KEY: TOKEN }, home);

    expect(seen[0]).toBe(TOKEN);
    const files = filesUnder(join(home, 'sessions'));
    const transcript = files.find((path) => path.endsWith('transcript.jsonl')) ?? '';
    expect(readFileSync(transcript, 'utf8')).toContain('"adapter":"claude-fetch"');
    for (const path of files) expect(readFileSync(path, 'utf8')).not.toContain(TOKEN);
    expect(result.output).not.toContain(TOKEN);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}, 60_000);

// 설정의 `providers.claude.command`를 따라 `ora run`이 가짜 claude 프로세스로 세션을 끝까지 돌린다. `via`는 기본이 fetch이므로 sdk를 명시한다.
test.each([
  { via: 'sdk', adapter: 'claude-sdk' },
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
            via,
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

// `via`를 생략한 기본값(fetch)으로 `ora run`이 로그인한 계정의 OAuth 토큰을 Bearer로 보내 세션을 끝까지 돌린다.
test('providers.claude 기본값(fetch)은 auth.json의 계정으로 가짜 /v1/messages를 부르고, 토큰은 세션 파일과 출력에 남지 않는다', async () => {
  const access = `sk-ant-oat01-${'e'.repeat(40)}`;
  const seen: { authorization: string | undefined; system: string }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        system: { text: string }[];
      };
      seen.push({
        authorization: req.headers.authorization,
        system: body.system.map((block) => block.text).join('|'),
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const frames = [
        { type: 'message_start', message: { usage: { input_tokens: 3 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: `토큰은 ${access}` },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ];
      res.end(
        frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''),
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const home = mkdtempSync(join(tmpdir(), 'ora-fetch-e2e-'));
    mkdirSync(join(home, 'work'));
    writeFileSync(
      join(home, 'auth.json'),
      JSON.stringify({
        schemaVersion: 1,
        providers: {
          claude: {
            accounts: [
              {
                kind: 'oauth',
                name: 'main',
                rank: 0,
                accessToken: access,
                refreshToken: `sk-ant-ort01-${'f'.repeat(40)}`,
                expiresAt: Date.parse('2099-01-01T00:00:00Z'),
              },
            ],
          },
        },
      }),
      { mode: 0o600 },
    );
    const config = join(home, 'config.json');
    writeFileSync(
      config,
      JSON.stringify({
        schemaVersion: 1,
        limits: { maxSteps: 2 },
        providers: { claude: { model: 'claude-haiku-5-5' } },
        models: [
          {
            id: 'claude-haiku-5-5',
            provider: 'claude',
            wire: 'anthropic-messages',
            baseUrl: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
            contextWindow: 200000,
            maxOutputTokens: 1000,
          },
        ],
      }),
    );
    const result = await runOra(['run', '작업', '--config', config], {}, home);

    expect(seen[0]?.authorization).toBe(`Bearer ${access}`);
    expect(seen[0]?.system).toContain("You are Claude Code, Anthropic's official CLI for Claude.");
    const files = filesUnder(join(home, 'sessions'));
    const transcript = files.find((path) => path.endsWith('transcript.jsonl')) ?? '';
    expect(readFileSync(transcript, 'utf8')).toContain('"adapter":"claude-fetch"');
    // 세션이 고른 계정을 session.json에 고정 정보로 남겨 재개 때 이어 쓴다.
    const sessionJson = JSON.parse(
      readFileSync(files.find((path) => path.endsWith('session.json')) ?? '', 'utf8'),
    ) as { accountPin?: { provider: string; account: string } };
    expect(sessionJson.accountPin).toMatchObject({ provider: 'claude', account: 'main' });
    for (const path of files) expect(readFileSync(path, 'utf8')).not.toContain(access);
    expect(result.output).not.toContain(access);

    const accounts = await runOra(['accounts'], {}, home);
    expect(accounts.output).toContain('claude\tmain\toauth');
    expect(accounts.output).not.toContain(access);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}, 60_000);

// 카탈로그의 codex 모델로 `ora run`이 ChatGPT 계정의 토큰과 계정 id 헤더를 보내 세션을 끝까지 돌린다.
test('providers.codex는 auth.json의 계정으로 가짜 /codex/responses를 부르고, 토큰은 세션 파일과 출력에 남지 않는다', async () => {
  const claims = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-e2e' } }),
  ).toString('base64url');
  const access = `eyJhbGciOiJub25lIn0.${claims}.${'s'.repeat(30)}`;
  const seen: { authorization: string | undefined; account: string | undefined; store: unknown }[] =
    [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { store: unknown };
      seen.push({
        authorization: req.headers.authorization,
        account: req.headers['chatgpt-account-id'] as string | undefined,
        store: body.store,
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const frames = [
        { type: 'response.output_text.delta', delta: `토큰은 ${access}` },
        {
          type: 'response.completed',
          response: {
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: `토큰은 ${access}` }],
              },
            ],
            usage: {
              input_tokens: 10,
              output_tokens: 2,
              input_tokens_details: { cached_tokens: 4 },
            },
          },
        },
      ];
      res.end(
        frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''),
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const home = mkdtempSync(join(tmpdir(), 'ora-codex-e2e-'));
    mkdirSync(join(home, 'work'));
    writeFileSync(
      join(home, 'auth.json'),
      JSON.stringify({
        schemaVersion: 1,
        providers: {
          codex: {
            accounts: [
              {
                kind: 'oauth',
                name: 'main',
                rank: 0,
                accessToken: access,
                refreshToken: 'refresh-e2e',
                expiresAt: Date.parse('2099-01-01T00:00:00Z'),
                accountUuid: 'acct-e2e',
              },
            ],
          },
        },
      }),
      { mode: 0o600 },
    );
    const config = join(home, 'config.json');
    writeFileSync(
      config,
      JSON.stringify({
        schemaVersion: 1,
        limits: { maxSteps: 2 },
        providers: { codex: { model: 'gpt-5.5' } },
        models: [
          {
            id: 'gpt-5.5',
            provider: 'codex',
            wire: 'openai-codex-responses',
            baseUrl: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
            contextWindow: 200000,
            maxOutputTokens: 1000,
          },
        ],
      }),
    );
    const result = await runOra(['run', '작업', '--config', config], {}, home);

    expect(seen[0]).toEqual({
      authorization: `Bearer ${access}`,
      account: 'acct-e2e',
      store: false,
    });
    const files = filesUnder(join(home, 'sessions'));
    const transcript = files.find((path) => path.endsWith('transcript.jsonl')) ?? '';
    expect(readFileSync(transcript, 'utf8')).toContain('"adapter":"codex-fetch"');
    for (const path of files) expect(readFileSync(path, 'utf8')).not.toContain(access);
    expect(result.output).not.toContain(access);

    const accounts = await runOra(['accounts'], {}, home);
    expect(accounts.output).toContain('codex\tmain\toauth');
  } finally {
    server.closeAllConnections();
    server.close();
  }
}, 60_000);

test('둘 이상의 프로바이더에 모델이 있으면 세션을 시작하지 않고 사용법 오류(종료 코드 2)로 멈춘다', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ora-multi-'));
  const config = join(home, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({
      schemaVersion: 1,
      providers: { codex: { model: 'gpt-5.5' }, grok: { model: 'grok-4.6' } },
    }),
  );
  const result = await runOra(['run', '작업', '--config', config], {}, home);

  expect(result.code).toBe(2);
  expect(result.output).toContain('providers.codex.model');
  expect(result.output).toContain('providers.grok.model');
});

test('모델 이름이나 계정이 없으면 세션을 시작하지 않고 사용법 오류(종료 코드 2)로 멈추며, 설정에 키 값을 적을 수 없다', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ora-model-'));
  const noModel = join(home, 'no-model.json');
  writeFileSync(noModel, JSON.stringify({ schemaVersion: 1 }));
  const withModel = join(home, 'with-model.json');
  writeFileSync(
    withModel,
    JSON.stringify({ schemaVersion: 1, providers: { claude: { model: 'test-model' } } }),
  );

  const missingModel = await runOra(['run', '작업', '--config', noModel], {}, home);
  expect(missingModel.code).toBe(2);
  expect(missingModel.output).toContain('providers.claude.model');

  const missingAccount = await runOra(['run', '작업', '--config', withModel], {}, home);
  expect(missingAccount.code).toBe(2);
  expect(missingAccount.output).toContain('ora login claude');

  const removedAnthropic = join(home, 'removed.json');
  writeFileSync(
    removedAnthropic,
    JSON.stringify({ schemaVersion: 1, providers: { anthropic: { model: 'm' } } }),
  );
  const removed = await runOra(['run', '작업', '--config', removedAnthropic], {}, home);
  expect(removed.code).toBe(2);
  expect(removed.output).toContain('anthropic');

  const valueInConfig = join(home, 'leak.json');
  writeFileSync(
    valueInConfig,
    JSON.stringify({
      schemaVersion: 1,
      providers: { claude: { model: 'm', credentialEnv: [TOKEN] } },
    }),
  );
  const rejected = await runOra(['run', '작업', '--config', valueInConfig], {}, home);
  expect(rejected.code).toBe(2);
  expect(rejected.output).not.toContain(TOKEN);
}, 60_000);
