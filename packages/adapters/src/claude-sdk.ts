import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ModelPort, ModelRequest } from '@ora/core';
import { toApiName } from './anthropic-frames.ts';
import {
  MCP_SERVER_NAME,
  buildClaudeEnv,
  ClaudeProcessError,
  createClaudeModel,
} from './claude-shared.ts';
import type {
  ClaudeBackend,
  ClaudeProcessHandle,
  ClaudeProviderOptions,
  ToolBridge,
} from './claude-shared.ts';

const STDERR_TAIL_CHARS = 2000;

/** Ora 도구를 같은 프로세스 안의 MCP 서버로 노출한다. 도구 목록은 요청마다 바뀔 수 있어서 호출 때 읽는다. */
function createOraMcpServer(getTools: () => ModelRequest['tools'], bridge: ToolBridge) {
  const instance = new McpServer({ name: MCP_SERVER_NAME, version: '0.0.0' });
  instance.server.registerCapabilities({ tools: {} });
  instance.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: getTools().map((tool) => ({
      name: toApiName(tool.name),
      description: tool.description,
      inputSchema: { type: 'object' as const, ...tool.inputSchema },
    })),
  }));
  instance.server.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
    const toolUseId = extra._meta?.['claudecode/toolUseId'];
    const outcome = await bridge.callTool(typeof toolUseId === 'string' ? toolUseId : undefined);
    return { content: [{ type: 'text' as const, text: outcome.text }], isError: outcome.isError };
  });
  return { type: 'sdk' as const, name: MCP_SERVER_NAME, instance };
}

/** SDK에 넘기는 사용자 입력 스트림이다. 엔진이 메시지를 줄 때마다 한 개씩 밀어 넣는다. */
function createInputQueue() {
  const pending: SDKUserMessage[] = [];
  let wake = Promise.withResolvers<undefined>();
  let closed = false;
  async function* iterate(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = pending.shift();
      if (next !== undefined) {
        yield next;
      } else if (closed) {
        return;
      } else {
        await wake.promise;
        wake = Promise.withResolvers<undefined>();
      }
    }
  }
  return {
    iterate,
    push: (message: SDKUserMessage) => {
      pending.push(message);
      wake.resolve(undefined);
    },
    close: () => {
      closed = true;
      wake.resolve(undefined);
    },
  };
}

function createSdkBackend(options: ClaudeProviderOptions, bridge: ToolBridge): ClaudeBackend {
  let currentTools: ModelRequest['tools'] = [];

  return {
    start(request, mode, sessionId, commandIndex): Promise<ClaudeProcessHandle> {
      currentTools = request.tools;
      const command = options.commands[commandIndex];
      if (command?.[0] === undefined) {
        return Promise.reject(new ClaudeProcessError('providers.claude.command가 비어 있습니다.'));
      }
      const [executable, ...prefix] = command;
      const input = createInputQueue();
      const abortController = new AbortController();
      const stderr = { tail: '' };
      let child: ChildProcess | undefined;
      const env = Object.fromEntries(
        Object.entries(buildClaudeEnv(options.env, options.cacheTtl)).flatMap(([name, value]) =>
          value === undefined ? [] : [[name, value]],
        ),
      );
      const running = query({
        prompt: input.iterate(),
        options: {
          model: options.model,
          ...(options.effort === undefined ? {} : { effort: options.effort }),
          tools: [],
          settingSources: [],
          strictMcpConfig: true,
          extraArgs: { 'disable-slash-commands': null },
          mcpServers: { [MCP_SERVER_NAME]: createOraMcpServer(() => currentTools, bridge) },
          allowedTools: [`mcp__${MCP_SERVER_NAME}`],
          systemPrompt: request.system,
          cwd: options.cwd,
          env,
          includePartialMessages: true,
          abortController,
          ...(mode.kind === 'resume' ? { resume: sessionId } : { sessionId }),
          persistSession: options.persistSession,
          // SDK가 번들한 바이너리 대신 사용자가 설정한 명령(`claude`, `cswap run <계정> --` 등)으로 실행한다.
          spawnClaudeCodeProcess: (spawnOptions) => {
            const spawned = spawn(executable, [...prefix, ...spawnOptions.args], {
              cwd: spawnOptions.cwd,
              env: spawnOptions.env,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            spawned.unref();
            spawned.stderr.on('data', (chunk: Buffer) => {
              stderr.tail = (stderr.tail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
            });
            spawned.on('error', (error) => {
              stderr.tail = `${stderr.tail}${error.message}`.slice(-STDERR_TAIL_CHARS);
            });
            child = spawned;
            // 파이프 세 개로 띄운 자식 프로세스라 stdin과 stdout이 있고, SDK가 쓰는 항목은 `SpawnedProcess`와 같다.
            return spawned;
          },
        },
      });
      const iterator = running[Symbol.asyncIterator]();
      const handle: ClaudeProcessHandle = {
        sendUserText: (text) => {
          input.push({
            type: 'user',
            message: { role: 'user', content: [{ type: 'text', text }] },
            parent_tool_use_id: null,
          });
        },
        nextEvent: async () => {
          const next = await iterator.next();
          return next.done === true ? undefined : next.value;
        },
        hold: () => {
          child?.ref();
        },
        release: () => {
          child?.unref();
        },
        stderrTail: () => stderr.tail,
        kill: () => {
          input.close();
          abortController.abort();
          running.close();
          child?.kill('SIGKILL');
        },
      };
      process.once('exit', () => {
        child?.kill('SIGKILL');
      });
      return Promise.resolve(handle);
    },
  };
}

/**
 * Claude Agent SDK로 구독 경로를 실행하는 모델 어댑터다. 로그인은 Claude Code가 갖고 있고, 이 어댑터는 토큰을 읽지 않는다.
 * SDK가 `claude` 프로세스를 띄우고, Ora 도구는 같은 프로세스 안의 MCP 서버로 노출한다.
 */
export function createClaudeSdkModel(options: ClaudeProviderOptions): ModelPort {
  return createClaudeModel({
    adapter: 'claude-sdk',
    options,
    createBackend: (bridge) => createSdkBackend(options, bridge),
  });
}
