import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { McpNotice, Tool } from '@ora/core';
import type { McpServerStatus } from '@ora/protocol';
import { z } from 'zod';
import { truncateMiddle } from './truncate.ts';

export interface McpServerConfig {
  readonly name: string;
  readonly transport: 'stdio' | 'http';
  readonly command?: string;
  readonly args: readonly string[];
  readonly url?: string;
  /** 환경변수 이름만 담는다. stdio는 서버 프로세스 환경으로, HTTP는 `Authorization: Bearer` 헤더로 넘긴다 (SPEC 4.2절). */
  readonly envRefs: readonly string[];
  readonly enabled: boolean;
}

export interface McpManagerOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly connectTimeoutMs: number;
  readonly callTimeoutMs: number;
  readonly maxOutputBytes: number;
  /** 장애 시각 문자열을 만든다. */
  readonly now: () => string;
}

export interface McpManager {
  /** 서버 목록을 맞춘다. 사라지거나 설정이 바뀐 서버는 닫고, 새 서버는 연결한다. 연결 시도가 끝나면 돌아온다. */
  configure(servers: readonly McpServerConfig[]): Promise<void>;
  /** 지금 연결된 서버의 도구다. 이후 서버가 죽으면 이 도구들은 오류 결과를 돌려준다. */
  tools(): Tool[];
  status(): McpServerStatus[];
  reconnect(name: string): Promise<void>;
  drain(): McpNotice[];
  close(): Promise<void>;
}

interface Entry {
  config: McpServerConfig;
  state: McpServerStatus['state'];
  client?: Client;
  remoteTools: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  toolCount?: number;
  lastFailure?: { at: string; reason: string };
  generation: number;
}

const MAX_TOOL_PAGES = 10;

function describeTarget(config: McpServerConfig): string {
  return config.transport === 'stdio'
    ? [config.command ?? '', ...config.args].join(' ').trim()
    : (config.url ?? '');
}

function toInputSchema(json: Record<string, unknown>): z.ZodType {
  try {
    return z.fromJSONSchema(json);
  } catch {
    return z.record(z.string(), z.unknown());
  }
}

const REQUEST_TIMEOUT: number = ErrorCode.RequestTimeout;

function isTimeout(error: unknown): boolean {
  return error instanceof McpError && error.code === REQUEST_TIMEOUT;
}

function describeError(error: unknown, connectTimeoutMs: number): string {
  if (isTimeout(error)) {
    return `연결 시간 초과(${Math.round(connectTimeoutMs / 1000)}초).`;
  }
  return error instanceof Error ? error.message : String(error);
}

function readEnvRef(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`환경변수 ${name}이 비어 있습니다.`);
  return value;
}

function createTransport(config: McpServerConfig, env: NodeJS.ProcessEnv) {
  if (config.transport === 'stdio') {
    return new StdioClientTransport({
      command: config.command ?? '',
      args: [...config.args],
      env: {
        ...getDefaultEnvironment(),
        ...Object.fromEntries(config.envRefs.map((name) => [name, readEnvRef(env, name)])),
      },
      stderr: 'ignore',
    });
  }
  const [ref] = config.envRefs;
  return new StreamableHTTPClientTransport(new URL(config.url ?? ''), {
    requestInit: {
      headers: ref === undefined ? {} : { Authorization: `Bearer ${readEnvRef(env, ref)}` },
    },
  });
}

/**
 * MCP 서버 연결을 관리한다 (SPEC 2.10절). 서버마다 연결과 장애가 따로라서, 한 서버가 죽어도 그 서버의 도구만 오류 결과를 돌려주고 다른 서버와 세션은 그대로 간다.
 * 서버 목록은 `configure`로만 바뀐다. 모델 도구에는 이 경로를 열지 않는다 (SPEC 5.7절).
 */
export function createMcpManager(options: McpManagerOptions): McpManager {
  const entries = new Map<string, Entry>();
  let notices: McpNotice[] = [];

  const disposeClient = async (entry: Entry) => {
    entry.generation += 1;
    const { client } = entry;
    delete entry.client;
    await client?.close().catch(() => undefined);
  };

  const fail = async (entry: Entry, reason: string) => {
    entry.state = 'unreachable';
    entry.lastFailure = { at: options.now(), reason };
    notices.push({ server: entry.config.name, outcome: 'failed', reason });
    await disposeClient(entry);
  };

  const connect = async (entry: Entry) => {
    entry.generation += 1;
    const generation = entry.generation;
    entry.state = 'connecting';
    const client = new Client({ name: 'ora', version: '0.0.0' });
    try {
      const transport = createTransport(entry.config, options.env);
      client.onclose = () => {
        if (entry.generation === generation && entry.state === 'connected') {
          fail(entry, '서버 연결이 끊겼습니다. 프로세스가 끝났거나 연결을 닫았습니다.').catch(
            () => undefined,
          );
        }
      };
      await client.connect(transport, { timeout: options.connectTimeoutMs });
      const remoteTools: Entry['remoteTools'] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
        const listed = await client.listTools(cursor === undefined ? {} : { cursor }, {
          timeout: options.connectTimeoutMs,
        });
        for (const tool of listed.tools) {
          remoteTools.push({
            name: tool.name,
            description: tool.description ?? '',
            inputSchema: tool.inputSchema,
          });
        }
        cursor = listed.nextCursor;
        if (cursor === undefined) break;
      }
      if (entry.generation !== generation) {
        await client.close().catch(() => undefined);
        return;
      }
      entry.client = client;
      entry.remoteTools = remoteTools;
      entry.toolCount = remoteTools.length;
      entry.state = 'connected';
      notices.push({
        server: entry.config.name,
        outcome: 'connected',
        toolCount: remoteTools.length,
      });
    } catch (error) {
      await client.close().catch(() => undefined);
      if (entry.generation !== generation) return;
      await fail(entry, describeError(error, options.connectTimeoutMs));
    }
  };

  const buildTools = (entry: Entry): Tool[] =>
    entry.remoteTools.map((remote) => ({
      name: `${entry.config.name}:${remote.name}`,
      description: `[MCP ${entry.config.name}] ${remote.description}`.trim(),
      // 서버가 알려 주는 읽기 전용 힌트는 믿지 않는다 (SPEC 5.1절). 정책으로만 낮춘다.
      tier: 'exec',
      inputSchema: toInputSchema(remote.inputSchema),
      async run(input, context) {
        const { client } = entry;
        if (entry.state !== 'connected' || client === undefined) {
          return {
            status: 'error',
            text: `MCP 서버 ${entry.config.name}의 도구는 꺼져 있습니다. ${entry.lastFailure?.reason ?? ''} 설정 › MCP에서 다시 연결합니다.`.trim(),
          };
        }
        try {
          const result = (await client.callTool(
            { name: remote.name, arguments: (input ?? {}) as Record<string, unknown> },
            undefined,
            { signal: context.signal, timeout: options.callTimeoutMs },
          )) as { content?: { type: string; text?: string }[]; isError?: boolean };
          const full = (result.content ?? [])
            .map((block) => (block.type === 'text' ? (block.text ?? '') : `[${block.type} 생략]`))
            .join('\n');
          const text = truncateMiddle(full, options.maxOutputBytes);
          return {
            status: result.isError === true ? 'error' : 'ok',
            text,
            ...(text === full ? {} : { fullOutput: full }),
          };
        } catch (error) {
          if (context.signal.aborted) return { status: 'aborted', text: '호출을 취소했습니다.' };
          if (isTimeout(error)) {
            await fail(
              entry,
              `도구 호출 시간 초과(${Math.round(options.callTimeoutMs / 1000)}초).`,
            );
            return {
              status: 'timeout',
              text: `${entry.config.name}:${remote.name} 호출 시간이 초과했습니다.`,
            };
          }
          return {
            status: 'error',
            text: error instanceof Error ? error.message : String(error),
          };
        }
      },
    }));

  const dispose = async (entry: Entry) => {
    await disposeClient(entry);
    entries.delete(entry.config.name);
  };

  return {
    async configure(servers) {
      const next = new Map(servers.map((server) => [server.name, server]));
      for (const entry of [...entries.values()]) {
        const updated = next.get(entry.config.name);
        if (updated === undefined || JSON.stringify(updated) !== JSON.stringify(entry.config)) {
          await dispose(entry);
        }
      }
      const pending: Promise<void>[] = [];
      for (const config of servers) {
        if (entries.has(config.name)) continue;
        const entry: Entry = {
          config,
          state: config.enabled ? 'connecting' : 'disabled',
          remoteTools: [],
          generation: 0,
        };
        entries.set(config.name, entry);
        if (config.enabled) pending.push(connect(entry));
      }
      await Promise.all(pending);
    },
    tools: () =>
      [...entries.values()].filter((entry) => entry.state === 'connected').flatMap(buildTools),
    status: () =>
      [...entries.values()].map((entry) => ({
        name: entry.config.name,
        transport: entry.config.transport,
        target: describeTarget(entry.config),
        envRefs: [...entry.config.envRefs],
        enabled: entry.config.enabled,
        state: entry.state,
        ...(entry.toolCount === undefined ? {} : { toolCount: entry.toolCount }),
        enabledToolCount: entry.state === 'connected' ? (entry.toolCount ?? 0) : 0,
        ...(entry.lastFailure === undefined ? {} : { lastFailure: entry.lastFailure }),
      })),
    async reconnect(name) {
      const entry = entries.get(name);
      if (!entry?.config.enabled) return;
      await disposeClient(entry);
      await connect(entry);
    },
    drain() {
      const drained = notices;
      notices = [];
      return drained;
    },
    async close() {
      await Promise.all([...entries.values()].map(dispose));
    },
  };
}
