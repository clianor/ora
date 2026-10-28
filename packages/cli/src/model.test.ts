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
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const CLI_PATH = fileURLToPath(new URL('./main.ts', import.meta.url));
const TOKEN = `sk-ant-oat01-${'b'.repeat(32)}`;

interface Outcome {
  readonly code: number;
  readonly output: string;
}

function runOra(args: string[], env: Record<string, string>, home: string): Promise<Outcome> {
  const { promise, resolve } = Promise.withResolvers<Outcome>();
  execFile(
    process.execPath,
    [CLI_PATH, ...args],
    { cwd: home, env: { ...process.env, ORA_HOME: home, ANTHROPIC_OAUTH_TOKEN: '', ...env } },
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
    seen.push(String(req.headers.authorization));
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
      { ANTHROPIC_OAUTH_TOKEN: TOKEN },
      home,
    );

    expect(seen[0]).toBe(`Bearer ${TOKEN}`);
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
  expect(missingToken.output).toContain('ANTHROPIC_OAUTH_TOKEN');

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
