import { join } from 'node:path';
import { formatKst } from '@ora/core';
import type { McpServerAddBody, McpServerListResponse } from '@ora/protocol';
import { createMcpManager } from '@ora/tools';
import type { McpServerConfig } from '@ora/tools';
import { UsageError, loadConfig } from './config.ts';
import { updateConfigFile } from './config-file.ts';
import { resolveOraHome } from './isolation/ora-home.ts';

export interface McpApiOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly configPath?: string;
}

export interface McpApi {
  list(): Promise<McpServerListResponse>;
  /** 서버를 설정 파일에 더하고 연결한다. 이름이 겹치면 `UsageError`다. */
  add(body: McpServerAddBody): Promise<McpServerListResponse>;
  /** 이름이 없으면 `undefined`다. */
  setEnabled(name: string, enabled: boolean): Promise<McpServerListResponse | undefined>;
  remove(name: string): Promise<McpServerListResponse | undefined>;
  reconnect(name: string): Promise<McpServerListResponse | undefined>;
  close(): Promise<void>;
}

function parseServers(raw: unknown): McpServerConfig[] {
  return Array.isArray(raw) ? (raw as McpServerConfig[]) : [];
}

/**
 * 설정 › MCP의 서버 목록과 상태를 다루는 호스트 API다 (SPEC 2.10절). 서버 목록은 이 화면의 사용자 요청으로만 바뀌고, 모델 도구는 이 경로에 닿지 못한다 (SPEC 5.7절).
 * 상태 표시용 연결은 세션 워커의 연결과 따로 이 프로세스가 가진다.
 */
export function createMcpApi(options: McpApiOptions): McpApi {
  const oraHome = resolveOraHome(options.env);
  const configFile = options.configPath ?? join(oraHome, 'engine.config.json');
  const manager = createMcpManager({
    env: options.env,
    connectTimeoutMs: 10000,
    callTimeoutMs: 120000,
    maxOutputBytes: 30000,
    now: () => formatKst(new Date()),
  });

  const loadServers = async (): Promise<McpServerConfig[]> => {
    const config = await loadConfig(options.configPath, oraHome);
    return config.mcpServers.map((server) => ({ ...server, args: server.args }));
  };
  const respond = (): McpServerListResponse => ({ servers: manager.status() });
  // 서버를 처음 읽을 때 한 번만 연결을 시작한다. 연결이 끝나길 기다리지 않아 화면이 `connecting`을 먼저 본다.
  let started: Promise<void> | undefined;
  const ensureStarted = async () => {
    started ??= loadServers().then(
      (servers) => {
        manager.configure(servers).catch(() => undefined);
      },
      () => undefined,
    );
    await started;
  };
  const write = async (change: (servers: McpServerConfig[]) => McpServerConfig[]) => {
    let next: McpServerConfig[] = [];
    await updateConfigFile(configFile, (file) => {
      next = change(parseServers(file.mcpServers));
      return { ...file, mcpServers: next };
    });
    await manager.configure(next);
  };

  return {
    async list() {
      await ensureStarted();
      return respond();
    },
    async add(body) {
      await ensureStarted();
      const [command, ...args] = (body.command ?? '').split(/\s+/).filter((part) => part !== '');
      const server: McpServerConfig =
        body.transport === 'stdio'
          ? {
              name: body.name,
              transport: 'stdio',
              command: command ?? '',
              args,
              envRefs: body.envRefs,
              enabled: true,
            }
          : {
              name: body.name,
              transport: 'http',
              url: body.url ?? '',
              args: [],
              envRefs: body.envRefs,
              enabled: true,
            };
      await write((servers) => {
        if (servers.some((existing) => existing.name === body.name)) {
          throw new UsageError(`이미 같은 이름의 서버가 있습니다: ${body.name}`);
        }
        return [...servers, server];
      });
      return respond();
    },
    async setEnabled(name, enabled) {
      await ensureStarted();
      if (!manager.status().some((server) => server.name === name)) return undefined;
      await write((servers) =>
        servers.map((server) => (server.name === name ? { ...server, enabled } : server)),
      );
      return respond();
    },
    async remove(name) {
      await ensureStarted();
      if (!manager.status().some((server) => server.name === name)) return undefined;
      await write((servers) => servers.filter((server) => server.name !== name));
      return respond();
    },
    async reconnect(name) {
      await ensureStarted();
      if (!manager.status().some((server) => server.name === name)) return undefined;
      await manager.reconnect(name);
      return respond();
    },
    close: () => manager.close(),
  };
}
