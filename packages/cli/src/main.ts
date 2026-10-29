#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isolationSchema, permissionModeSchema } from '@ora/protocol';
import {
  CancelledBeforeStartError,
  UsageError,
  launchSession,
  listAccounts,
  listSessions,
  loginAccount,
  logoutAccount,
  startLocalServer,
  runEval,
} from '@ora/host';
import type { LaunchRequest, SessionResult } from '@ora/host';

const DEFAULT_WEB_DIR = fileURLToPath(new URL('../../../apps/web/dist', import.meta.url));

const USAGE = `사용법:
  ora run "<작업>" [--model-script <경로>] [--config <경로>] [--permission <always-ask|write|bypass-permissions>] [--isolation <none|harness|clean-home>] [--json]
  ora resume <세션 ID> [--model-script <경로>] [--steer "<조향 메시지>"] [--config <경로>] [--isolation <none|harness|clean-home>] [--json]
  ora sessions [--config <경로>] [--json]
  ora serve [--model-script <경로>] [--web-dir <경로>] [--port <번호>] [--config <경로>] [--isolation <none|harness|clean-home>]
  ora login <claude|codex|grok> [--name <계정 이름>] [--api-key-env <환경변수 이름> (API 키 계정을 만든다. 키 값은 저장하지 않는다)] [--device (codex 전용)]
  ora accounts
  ora eval <작업 세트 경로> --model <모델>... [--config <경로>] [--out <폴더>] [--model-script <경로>]`;

const EXIT_CODES = { passed: 0, failed: 1, usage: 2, cancelled: 130 } as const;

function formatSummary(result: SessionResult): string {
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

/** 한 번 누르면 소프트 스톱, 두 번 누르면 하드 킬이다 (SPEC 2.9절). */
async function runWorker(
  request: LaunchRequest,
  json: boolean,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  let presses = 0;
  const handle = launchSession({
    request,
    env,
    onQueued: () => {
      process.stderr.write('동시 세션 상한에 닿아 대기합니다.\n');
    },
    ...(json
      ? {
          onEvent: (event) => {
            process.stdout.write(`${JSON.stringify(event)}\n`);
          },
        }
      : {}),
  });
  const onSigint = () => {
    presses += 1;
    if (presses === 1) {
      process.stderr.write(
        '소프트 스톱: 진행 중인 도구 호출이 끝나면 멈춥니다. 한 번 더 누르면 강제 종료합니다.\n',
      );
      handle.cancel('soft');
    } else {
      handle.cancel('hard');
    }
  };
  process.on('SIGINT', onSigint);
  try {
    const result = await handle.result;
    if (!json) process.stdout.write(`${formatSummary(result)}\n`);
    if (result.endReason === 'user_cancel') return EXIT_CODES.cancelled;
    return result.status === 'completed' ? EXIT_CODES.passed : EXIT_CODES.failed;
  } catch (error) {
    if (error instanceof CancelledBeforeStartError) return EXIT_CODES.cancelled;
    throw error;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        permission: { type: 'string' },
        isolation: { type: 'string' },
        json: { type: 'boolean', default: false },
        'model-script': { type: 'string' },
        'record-model-input': { type: 'string' },
        steer: { type: 'string' },
        'web-dir': { type: 'string' },
        port: { type: 'string' },
        name: { type: 'string' },
        'api-key-env': { type: 'string' },
        model: { type: 'string', multiple: true },
        out: { type: 'string' },
        device: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    process.stderr.write(`${String(error)}\n${USAGE}\n`);
    return EXIT_CODES.usage;
  }
  const { values } = parsed;
  const [command, argument, ...extra] = parsed.positionals;
  const usageError = (message: string) => {
    process.stderr.write(`${message}\n${USAGE}\n`);
    return EXIT_CODES.usage;
  };
  const isolation = isolationSchema.safeParse(values.isolation);
  if (values.isolation !== undefined && !isolation.success) {
    return usageError(`--isolation 값이 올바르지 않습니다: ${values.isolation}`);
  }
  const isolationArgs = isolation.success ? { isolation: isolation.data } : {};
  const common = {
    cwd: process.cwd(),
    ...(values.config === undefined ? {} : { configPath: values.config }),
    ...isolationArgs,
  };

  try {
    if (command === 'sessions') {
      if (argument !== undefined) return usageError('sessions는 인자를 받지 않습니다.');
      const sessions = await listSessions(process.env, values.config);
      for (const session of sessions) {
        process.stdout.write(
          values.json
            ? `${JSON.stringify(session)}\n`
            : `${session.id}\t${session.status}\t${session.updatedAt}\t${session.title}\n`,
        );
      }
      return EXIT_CODES.passed;
    }

    if (command === 'accounts') {
      if (argument !== undefined) return usageError('accounts는 인자를 받지 않습니다.');
      for (const row of await listAccounts(process.env)) process.stdout.write(`${row}\n`);
      return EXIT_CODES.passed;
    }

    if (command === 'login' || command === 'logout') {
      if (argument === undefined || extra.length > 0)
        return usageError('프로바이더 이름이 필요합니다.');
      const name = values.name;
      if (command === 'logout') {
        const removed = await logoutAccount(argument, name, process.env);
        process.stdout.write(`로그아웃한 계정: ${removed.join(', ') || '없음'}\n`);
        return EXIT_CODES.passed;
      }
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const saved = await loginAccount(
          argument,
          {
            ...(name === undefined ? {} : { name }),
            ...(values['api-key-env'] === undefined ? {} : { apiKeyEnv: values['api-key-env'] }),
            ...(values.device ? { device: true } : {}),
          },
          process.env,
          {
            print: (line) => process.stderr.write(`${line}\n`),
            readLine: () => rl.question('코드 붙여 넣기: '),
          },
        );
        process.stdout.write(`저장한 계정: ${saved}\n`);
        return EXIT_CODES.passed;
      } finally {
        rl.close();
      }
    }

    if (command === 'serve') {
      if (argument !== undefined) return usageError('serve는 인자를 받지 않습니다.');
      const port = values.port === undefined ? undefined : Number(values.port);
      if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port <= 65535)) {
        return usageError(`--port 값이 올바르지 않습니다: ${values.port}`);
      }
      const webDir = resolve(values['web-dir'] ?? DEFAULT_WEB_DIR);
      const hasWeb = existsSync(webDir);
      const server = await startLocalServer({
        env: process.env,
        cwd: process.cwd(),
        ...(values['model-script'] === undefined
          ? {}
          : { modelScriptPath: values['model-script'] }),
        ...(values.config === undefined ? {} : { configPath: values.config }),
        ...isolationArgs,
        ...(hasWeb ? { webDir } : {}),
        ...(port === undefined ? {} : { port }),
      });
      process.stdout.write(`${server.startUrl}\n`);
      if (!hasWeb) {
        process.stderr.write(`웹 결과물 디렉터리가 없어 API만 제공합니다: ${webDir}\n`);
      }
      const closed = Promise.withResolvers<undefined>();
      const onStop = () => {
        server.close().then(() => {
          closed.resolve(undefined);
        }, closed.reject);
      };
      process.once('SIGINT', onStop);
      process.once('SIGTERM', onStop);
      await closed.promise;
      return EXIT_CODES.passed;
    }

    if (command === 'eval') {
      if (argument === undefined || extra.length > 0) {
        return usageError('작업 세트 경로가 필요합니다.');
      }
      if (values.model === undefined || values.model.length === 0) {
        return usageError('--model을 하나 이상 줍니다.');
      }
      const resultDir = await runEval({
        setPath: argument,
        models: values.model,
        cwd: process.cwd(),
        env: process.env,
        ...(values.config === undefined ? {} : { configPath: values.config }),
        ...(values.out === undefined ? {} : { outDir: values.out }),
        ...(values['model-script'] === undefined
          ? {}
          : { modelScriptPath: values['model-script'] }),
        log: (line) => process.stderr.write(`${line}\n`),
      });
      process.stdout.write(`${resultDir}\n`);
      return EXIT_CODES.passed;
    }

    const modelScriptPath = values['model-script'];
    if ((command !== 'run' && command !== 'resume') || argument === undefined || extra.length > 0) {
      return usageError('명령이나 인자가 올바르지 않습니다.');
    }
    const launch = {
      ...common,
      ...(modelScriptPath === undefined ? {} : { modelScriptPath }),
      ...(values['record-model-input'] === undefined
        ? {}
        : { modelInputLogPath: values['record-model-input'] }),
    };
    if (command === 'resume') {
      return await runWorker(
        {
          type: 'resumeSession',
          sessionId: argument,
          ...launch,
          ...(values.steer === undefined ? {} : { steer: values.steer }),
        },
        values.json,
        process.env,
      );
    }
    const permission = permissionModeSchema.safeParse(values.permission);
    if (values.permission !== undefined && !permission.success) {
      return usageError(`--permission 값이 올바르지 않습니다: ${values.permission}`);
    }
    return await runWorker(
      {
        type: 'createSession',
        task: argument,
        ...launch,
        ...(permission.success ? { permissionMode: permission.data } : {}),
      },
      values.json,
      process.env,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof UsageError ? EXIT_CODES.usage : EXIT_CODES.failed;
  }
}

process.exitCode = await main();
