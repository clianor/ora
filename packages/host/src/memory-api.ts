import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createRecorder, formatKst, parseTranscript } from '@ora/core';
import type { Clock, ModelChainEntry, ModelPort, ModelUsage } from '@ora/core';
import { deleteMemory, listMemories, runFullPass, shouldRunFullPass } from '@ora/memory';
import type { MemoryAsk } from '@ora/memory';
import type { MemoryListResponse, MemoryPassSummary, SessionRecord } from '@ora/protocol';
import {
  createSessionStorage,
  listSessionRecords,
  readSessionRecordOrWarn,
  readTranscriptText,
  writeSessionRecord,
} from '@ora/store';
import {
  ENGINE_VERSION,
  UsageError,
  loadConfig,
  resolveChains,
  resolveSessionsDir,
} from './config.ts';
import type { Config } from './config.ts';
import { createModelRouter, findGitRoot } from './execute.ts';
import { resolveOraHome } from './isolation/ora-home.ts';

export interface MemoryApiOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly configPath?: string;
  readonly modelScriptPath?: string;
  /** 실행 중인 세션이 있으면 true다. 전체 패스는 세션이 없을 때만 돈다. */
  readonly hasLiveSession: () => boolean;
}

export interface MemoryApi {
  list(cwd?: string): Promise<MemoryListResponse>;
  /** 항목을 아카이브로 옮긴다. 없는 ID면 `false`다. */
  remove(id: string): Promise<boolean>;
  /** "지금 다듬기"다. 패스가 돌고 있거나 실행 중인 세션이 있으면 `UsageError`로 거부한다. */
  tidy(): Promise<MemoryPassSummary>;
  /** 호스트의 주기 확인이다. 하루가 지났거나 새 메모리가 20개를 넘었고 세션이 없으면 전체 패스를 돌린다. */
  tick(): Promise<void>;
}

const systemClock: Clock = { now: () => new Date() };
const RECENT_SESSION_LIMIT = 10;
const MAX_TASK_CHARS = 200;
const REPLY_MAX_TOKENS = 4000;

function createSessionId(): string {
  const suffix = randomBytes(6)
    .toString('base64url')
    .replace(/[^A-Za-z0-9]/g, 'x')
    .slice(0, 6);
  return `s-${formatKst(new Date()).slice(0, 10).replaceAll('-', '')}-${suffix}`;
}

/** 설정 › 메모리의 목록, 지우기, 전체 패스를 맡는 호스트 API다 (SPEC 3.2~3.4절). 메모리 변경은 이 API로만 한다 (SPEC 5.7절). */
export function createMemoryApi(options: MemoryApiOptions): MemoryApi {
  const oraHome = resolveOraHome(options.env);
  const configArgs = options.configPath === undefined ? {} : { configPath: options.configPath };
  let isTidying = false;

  const load = async () => {
    const config = await loadConfig(options.configPath, oraHome);
    return {
      config,
      memoryDir: config.paths.memory ?? join(oraHome, 'memory'),
      sessionsDir: resolveSessionsDir(config, oraHome),
    };
  };

  /** 패스의 모델 요청을 담는 세션 기록을 만들고, 요청 하나를 `memory` 역할 체인으로 보내는 함수를 돌려준다. */
  const openAsk = async (config: Config, sessionsDir: string) => {
    const sessionId = createSessionId();
    const sessionDir = join(sessionsDir, sessionId);
    await mkdir(sessionDir, { recursive: true });
    const storage = await createSessionStorage(sessionDir);
    const recorder = createRecorder(sessionId, storage.transcript, systemClock);
    const now = formatKst(new Date());
    const record: SessionRecord = {
      schemaVersion: 1,
      id: sessionId,
      createdAt: now,
      updatedAt: now,
      title: '메모리 다듬기',
      actor: 'routine:memory',
      status: 'running',
      models: [],
      permissionMode: config.permissions.mode,
      isolation: config.isolation,
      promptHash: 'memory-pass',
      engineVersion: ENGINE_VERSION,
    };
    await writeSessionRecord(sessionDir, record);
    await recorder.emit('engine', {
      type: 'session_start',
      payload: {
        configSummary: {},
        isolation: config.isolation,
        permissionMode: config.permissions.mode,
        instructionFiles: [],
        promptHash: 'memory-pass',
      },
    });

    const chains = resolveChains(config, { scripted: options.modelScriptPath !== undefined });
    const router = createModelRouter({
      command: {
        type: 'createSession',
        sessionId,
        cwd: oraHome,
        task: '메모리 다듬기',
        ...(options.modelScriptPath === undefined
          ? {}
          : { modelScriptPath: options.modelScriptPath }),
        ...configArgs,
      },
      config,
      chains,
      env: options.env,
      claudeResume: undefined,
      isolation: config.isolation,
      oraHome,
      pin: undefined,
    });
    const pricing = config.pricing;
    const priceOf = (model: string) => {
      const key = Object.keys(pricing).find((name) => name === model || name.endsWith(`/${model}`));
      return key === undefined ? undefined : pricing[key];
    };
    const costOf = (model: string, usage: ModelUsage) => {
      const price = priceOf(model);
      if (price === undefined) return 0;
      return (
        (usage.uncachedInputTokens * price.inputPerMTok +
          usage.cacheReadInputTokens * (price.cacheReadPerMTok ?? price.inputPerMTok) +
          usage.cacheCreationInputTokens * (price.cacheWritePerMTok ?? price.inputPerMTok) +
          usage.outputTokens * price.outputPerMTok) /
        1_000_000
      );
    };
    const maxCost = config.session.maxCost;
    let spent = 0;
    const used: SessionRecord['models'] = [];

    const ask: MemoryAsk = async ({ system, user }) => {
      const chain: readonly ModelChainEntry[] = router.chain('memory');
      let lastError: unknown;
      for (const [position, entry] of chain.entries()) {
        let port: ModelPort;
        try {
          port = await router.open(entry);
        } catch (error) {
          lastError = error;
          continue;
        }
        if (maxCost !== null) {
          if (priceOf(port.model) === undefined) {
            throw new Error(
              `비용 상한을 설정했지만 ${port.model}의 단가가 없어 요청을 보내지 않았습니다.`,
            );
          }
          if (spent >= maxCost) throw new Error('비용 상한에 닿아 메모리 다듬기를 멈춥니다.');
        }
        const started = Date.now();
        try {
          let completed;
          for await (const event of port.stream(
            {
              system,
              messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
              tools: [],
              maxOutputTokens: REPLY_MAX_TOKENS,
            },
            new AbortController().signal,
          )) {
            if (event.type === 'completed') completed = event;
          }
          if (completed === undefined) throw new Error('모델 스트림이 completed 없이 끝났습니다.');
          spent += costOf(port.model, completed.usage);
          used.push({
            model: entry.model,
            provider: entry.provider,
            role: 'memory',
            chainPosition: position,
            ...(entry.effort === undefined ? {} : { effort: entry.effort }),
            source: position === 0 ? entry.source : 'fallback',
          });
          await recorder.emit('model', {
            type: 'model_request',
            payload: {
              model: port.model,
              adapter: port.adapter,
              chainPosition: position,
              role: 'memory',
              purpose: 'memory',
              nativeToolCalls: completed.nativeToolCalls,
              usage: completed.usage,
              durationMs: Math.max(0, Date.now() - started),
            },
          });
          return completed.content
            .flatMap((block) => (block.type === 'text' ? [block.text] : []))
            .join('\n');
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error('memory 체인의 모델을 쓸 수 없습니다.');
    };

    const close = async (outcome: MemoryPassSummary['outcome'], summary: string) => {
      await recorder.emit('engine', {
        type: 'session_end',
        payload: {
          status: outcome === 'ok' ? 'completed' : 'failed',
          endReason: outcome === 'ok' ? 'passed' : 'error',
          summary,
        },
      });
      await writeSessionRecord(sessionDir, {
        ...record,
        updatedAt: formatKst(new Date()),
        status: outcome === 'ok' ? 'completed' : 'failed',
        endReason: outcome === 'ok' ? 'passed' : 'error',
        models: used,
      });
    };
    return { ask, close };
  };

  const describeRecentSessions = async (sessionsDir: string): Promise<string> => {
    const records = (await listSessionRecords(sessionsDir))
      .filter((record) => record.actor !== 'routine:memory')
      .slice(0, RECENT_SESSION_LIMIT);
    const lines: string[] = [];
    for (const record of records) {
      const text = await readTranscriptText(join(sessionsDir, record.id));
      const first = (text === undefined ? [] : parseTranscript(text).events).find(
        (event) => event.type === 'message' && event.payload.role === 'user',
      );
      const task =
        first?.type === 'message'
          ? first.payload.content
              .flatMap((block) => (block.type === 'text' ? [block.text] : []))
              .join(' ')
          : '';
      lines.push(
        `- ${record.title} (${record.createdAt.slice(0, 10)}): ${task.slice(0, MAX_TASK_CHARS)}`,
      );
    }
    return lines.join('\n');
  };

  const runPass = async (): Promise<MemoryPassSummary> => {
    isTidying = true;
    try {
      const { config, memoryDir, sessionsDir } = await load();
      const { ask, close } = await openAsk(config, sessionsDir);
      const summary = await runFullPass({
        memoryDir,
        clock: systemClock,
        ask,
        recentSessions: await describeRecentSessions(sessionsDir),
        ...(config.projectId ? { projectId: config.projectId } : {}),
      });
      await close(
        summary.outcome,
        summary.outcome === 'ok'
          ? `합침 ${summary.merged}, 고침 ${summary.rewritten}, 보관 ${summary.archived}`
          : (summary.reason ?? '실패'),
      );
      return summary;
    } finally {
      isTidying = false;
    }
  };

  return {
    async list(cwd) {
      const { config, memoryDir, sessionsDir } = await load();
      const projectId =
        config.projectId ?? (cwd === undefined ? '' : basename(findGitRoot(cwd) ?? cwd));
      const result = await listMemories({
        memoryDir,
        projectId,
        clock: systemClock,
        titleOf: async (sessionId) =>
          (await readSessionRecordOrWarn(join(sessionsDir, sessionId)))?.title,
      });
      return { ...result, projectName: projectId, isTidying };
    },
    async remove(id) {
      return deleteMemory((await load()).memoryDir, systemClock, id);
    },
    async tidy() {
      if (isTidying) throw new UsageError('이미 메모리를 다듬는 중입니다.');
      if (options.hasLiveSession()) {
        throw new UsageError(
          '실행 중인 세션이 있어 지금은 다듬을 수 없습니다. 세션이 끝난 뒤에 다시 시도합니다.',
        );
      }
      return runPass();
    },
    async tick() {
      if (isTidying) return;
      const { memoryDir } = await load();
      const due = await shouldRunFullPass({
        memoryDir,
        clock: systemClock,
        hasLiveSession: options.hasLiveSession(),
      });
      if (due) await runPass();
    },
  };
}
