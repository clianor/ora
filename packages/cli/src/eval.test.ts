import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const CLI_PATH = fileURLToPath(new URL('./main.ts', import.meta.url));

function use(callId: string, tool: string, input: Record<string, unknown>) {
  return { type: 'tool_use', callId, tool, input: { intent: `${tool} 호출`, ...input } };
}

function runEvalCli(args: string[], env: NodeJS.ProcessEnv) {
  const { promise, resolve } = Promise.withResolvers<{ code: number; stdout: string }>();
  execFile(process.execPath, [CLI_PATH, 'eval', ...args], { env }, (error, stdout, stderr) => {
    resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout: stdout + stderr });
  });
  return promise;
}

test('ora eval은 정해 둔 답을 ask_user에 주고, 숨은 검사는 세션이 끝난 뒤에만 돌아 결과 JSON에 기록된다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ora-eval-e2e-'));
  const home = join(root, 'home');
  const task = join(root, 'tasks', 'rounding');
  mkdirSync(join(task, 'start'), { recursive: true });
  mkdirSync(join(task, 'hidden'));
  mkdirSync(home);
  writeFileSync(
    join(task, 'task.json'),
    JSON.stringify({
      instruction: 'out.txt를 만든다',
      answer: '올림으로 한다',
      hiddenCheck: 'node hidden-check.js',
    }),
  );
  writeFileSync(join(task, 'start', 'seed.txt'), 'seed\n');
  writeFileSync(
    join(task, 'hidden', 'hidden-check.js'),
    "require('node:assert').ok(require('node:fs').existsSync('out.txt'));\n",
  );
  const script = join(root, 'script.json');
  writeFileSync(
    script,
    JSON.stringify({
      responses: [
        { content: [use('c1', 'shell', { command: 'ls > listing.txt && echo done > out.txt' })] },
        {
          content: [
            use('c2', 'ask_user', {
              questions: [{ question: '반올림 방식은?', options: ['올림', '버림'] }],
            }),
          ],
        },
        { content: [{ type: 'text', text: '마쳤습니다.' }] },
      ],
    }),
  );
  const out = join(root, 'out');
  const env = { ...process.env, ORA_HOME: home };

  const result = await runEvalCli(
    [task.replace(/rounding$/, ''), '--model', 'fake-a', '--model-script', script, '--out', out],
    env,
  );
  expect(result.code).toBe(0);

  const [runDir] = readdirSync(out);
  const results = JSON.parse(readFileSync(join(out, runDir ?? '', 'results.json'), 'utf8')) as {
    runs: {
      workspace: string;
      sessionDir: string;
      dimensions: {
        correctness: { passed: boolean };
        interaction: { askUserCalls: number; answers: number };
        speed: { steps: number };
      };
    }[];
  };
  const [run] = results.runs;
  expect(run?.dimensions.correctness.passed).toBe(true);
  expect(run?.dimensions.interaction).toMatchObject({ askUserCalls: 1, answers: 1 });
  expect(run?.dimensions.speed.steps).toBe(3);
  expect(readFileSync(join(run?.workspace ?? '', 'listing.txt'), 'utf8')).not.toContain('hidden');
  expect(readFileSync(join(run?.sessionDir ?? '', 'transcript.jsonl'), 'utf8')).toContain(
    '올림으로 한다',
  );
  expect(existsSync(join(home, 'sessions'))).toBe(false);
  expect(readFileSync(join(out, runDir ?? '', 'report.md'), 'utf8')).toContain('fake-a');
}, 60_000);

test('잘못된 작업 세트는 종료 코드 2다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ora-eval-bad-'));
  mkdirSync(join(root, 'tasks', 'x'), { recursive: true });
  writeFileSync(join(root, 'tasks', 'x', 'task.json'), '{}');
  const result = await runEvalCli([join(root, 'tasks'), '--model', 'm'], {
    ...process.env,
    ORA_HOME: root,
  });
  expect(result.code).toBe(2);
});
