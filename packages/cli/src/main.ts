#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { permissionModeSchema } from '@ora/protocol';
import { UsageError, runTask } from '@ora/host';
import type { RunTaskResult } from '@ora/host';

const USAGE = `사용법: ora run "<작업>" --model-script <경로> [--config <경로>] [--permission <always-ask|write|yolo>] [--json]`;

const EXIT_CODES = { passed: 0, failed: 1, usage: 2, cancelled: 130 } as const;

function formatSummary(result: RunTaskResult): string {
  const lines = [
    `세션: ${result.sessionId}`,
    `상태: ${result.status} (${result.endReason})`,
    ...result.todos.map((todo) => {
      const evidence = todo.evidence;
      const detail =
        evidence === undefined
          ? '증거 없음'
          : `검증 ${evidence.command} → exit ${evidence.exitCode ?? '없음'}`;
      const modelOnly = evidence?.origin === 'model' ? ' (모델이 만든 검사로만 통과)' : '';
      return `- ${todo.id} [${todo.status}] ${todo.content}: ${detail}${modelOnly}`;
    }),
  ];
  return lines.join('\n');
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        permission: { type: 'string' },
        json: { type: 'boolean', default: false },
        'model-script': { type: 'string' },
        'record-model-input': { type: 'string' },
      },
    });
  } catch (error) {
    process.stderr.write(`${String(error)}\n${USAGE}\n`);
    return EXIT_CODES.usage;
  }
  const [command, task, ...extra] = parsed.positionals;
  const modelScriptPath = parsed.values['model-script'];
  if (
    command !== 'run' ||
    task === undefined ||
    extra.length > 0 ||
    modelScriptPath === undefined
  ) {
    process.stderr.write(`${USAGE}\n실제 모델 어댑터는 아직 없어서 --model-script가 필요합니다.\n`);
    return EXIT_CODES.usage;
  }
  const permission = permissionModeSchema.safeParse(parsed.values.permission);
  if (parsed.values.permission !== undefined && !permission.success) {
    process.stderr.write(`--permission 값이 올바르지 않습니다: ${parsed.values.permission}\n`);
    return EXIT_CODES.usage;
  }

  const controller = new AbortController();
  process.once('SIGINT', () => {
    controller.abort();
  });
  try {
    const result = await runTask({
      task,
      cwd: process.cwd(),
      modelScriptPath,
      ...(parsed.values.config === undefined ? {} : { configPath: parsed.values.config }),
      ...(permission.success ? { permissionMode: permission.data } : {}),
      env: process.env,
      signal: controller.signal,
      ...(parsed.values['record-model-input'] === undefined
        ? {}
        : { modelInputLogPath: parsed.values['record-model-input'] }),
      ...(parsed.values.json
        ? {
            onEvent: (event) => {
              process.stdout.write(`${JSON.stringify(event)}\n`);
            },
          }
        : {}),
    });
    if (!parsed.values.json) process.stdout.write(`${formatSummary(result)}\n`);
    if (result.endReason === 'user_cancel') return EXIT_CODES.cancelled;
    return result.status === 'completed' ? EXIT_CODES.passed : EXIT_CODES.failed;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof UsageError ? EXIT_CODES.usage : EXIT_CODES.failed;
  }
}

process.exitCode = await main();
