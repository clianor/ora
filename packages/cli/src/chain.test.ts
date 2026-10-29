import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { oraEventSchema } from '@ora/protocol';
import type { OraEvent } from '@ora/protocol';
import { expect, test } from 'vitest';

const CLI_PATH = fileURLToPath(new URL('./main.ts', import.meta.url));
const TEST_TIMEOUT_MS = 60_000;

const text = { content: [{ type: 'text', text: '응답' }] };
const limit = (resetAfterMs: number) => ({ error: { kind: 'limit', resetAfterMs } });
const failure = { error: { kind: 'error', message: '일반 오류' } };

/** 가짜 모델 스크립트와 설정으로 `ora run`을 돌리고 세션 기록을 돌려준다. 체인 항목마다 같은 스크립트를 이어서 재생한다. */
async function runChain(responses: object[], config: object) {
  const home = mkdtempSync(join(tmpdir(), 'ora-chain-'));
  const script = join(home, 'script.json');
  const configPath = join(home, 'config.json');
  writeFileSync(script, JSON.stringify({ responses }));
  writeFileSync(
    configPath,
    JSON.stringify({ schemaVersion: 1, limits: { maxSteps: 2 }, ...config }),
  );
  const { promise, resolve } = Promise.withResolvers<undefined>();
  execFile(
    process.execPath,
    [CLI_PATH, 'run', '작업', '--model-script', script, '--config', configPath],
    { cwd: home, env: { ...process.env, ORA_HOME: home } },
    () => {
      resolve(undefined);
    },
  );
  await promise;
  const [id] = readdirSync(join(home, 'sessions'));
  const dir = join(home, 'sessions', id ?? '');
  const events: OraEvent[] = readFileSync(join(dir, 'transcript.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => oraEventSchema.parse(JSON.parse(line)));
  const session = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')) as {
    models: Record<string, unknown>[];
  };
  return {
    session,
    retries: events.flatMap((event) => (event.type === 'retry' ? [event.payload] : [])),
    requests: events.flatMap((event) => (event.type === 'model_request' ? [event.payload] : [])),
    end: events.findLast((event) => event.type === 'session_end')?.payload,
  };
}

const chain = { roles: { default: { chain: ['claude/m1', 'claude/m2'] } } };

test(
  '한도 오류가 나면 체인의 다음 모델로 같은 요청을 다시 보내고, retry 이벤트와 model_request에 체인 위치가 남는다',
  async () => {
    const { retries, requests, session } = await runChain([limit(3_600_000), text, text], chain);

    expect(retries).toEqual([
      expect.objectContaining({
        layer: 'session',
        reason: 'usage-limit',
        switchedTo: 'm2',
        chainPosition: 1,
        role: 'default',
      }),
    ]);
    expect(requests.map((request) => [request.model, request.chainPosition])).toEqual([
      ['m2', 1],
      ['m2', 1],
    ]);
    expect(session.models.map((used) => [used.model, used.chainPosition, used.source])).toEqual([
      ['m1', 0, 'config'],
      ['m2', 1, 'fallback'],
    ]);
  },
  TEST_TIMEOUT_MS,
);

test(
  '한도 해제 시각이 지나면 다음 요청 전에 첫 모델로 돌아가고 retry 이벤트의 이유가 revert다',
  async () => {
    const { retries, requests } = await runChain([limit(0), text, text], chain);

    expect(retries.map((retry) => [retry.reason, retry.switchedTo])).toEqual([
      ['usage-limit', 'm2'],
      ['revert', 'm1'],
    ]);
    expect(requests.map((request) => request.chainPosition)).toEqual([1, 0]);
  },
  TEST_TIMEOUT_MS,
);

test(
  'fallback.on이 usage-limit이면 일반 오류는 폴백하지 않고 세션이 failed로 끝난다',
  async () => {
    const { retries, requests, end } = await runChain([failure, text], {
      ...chain,
      fallback: { on: 'usage-limit' },
    });

    expect(retries).toEqual([]);
    expect(requests).toEqual([]);
    expect(end).toMatchObject({ status: 'failed', summary: '일반 오류' });
  },
  TEST_TIMEOUT_MS,
);
