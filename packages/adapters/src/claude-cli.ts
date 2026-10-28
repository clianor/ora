import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ModelPort, ModelRequest } from '@ora/core';
import { toApiName } from './anthropic-frames.ts';
import { MCP_TOKEN_HEADER, startMcpServer } from './claude-mcp-server.ts';
import type { McpServer } from './claude-mcp-server.ts';
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
  StartMode,
  ToolBridge,
} from './claude-shared.ts';

const STDERR_TAIL_CHARS = 2000;

function createCliBackend(options: ClaudeProviderOptions, bridge: ToolBridge): ClaudeBackend {
  let mcp: McpServer | undefined;
  let workDir: string | undefined;
  const children = new Set<ChildProcessWithoutNullStreams>();
  let currentTools: ModelRequest['tools'] = [];

  const ensureServer = async (): Promise<string> => {
    if (workDir === undefined) {
      const created = await mkdtemp(join(tmpdir(), 'ora-claude-'));
      workDir = created;
      process.once('exit', () => {
        for (const child of children) child.kill('SIGKILL');
        rmSync(created, { recursive: true, force: true });
      });
    }
    const dir = workDir;
    mcp ??= await startMcpServer({
      listTools: () =>
        currentTools.map((tool) => ({
          name: toApiName(tool.name),
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      callTool: (_name, _args, toolUseId) => bridge.callTool(toolUseId),
    });
    await writeFile(
      join(dir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          [MCP_SERVER_NAME]: {
            type: 'http',
            url: mcp.url,
            headers: { [MCP_TOKEN_HEADER]: mcp.token },
          },
        },
      }),
      { mode: 0o600 },
    );
    return dir;
  };

  return {
    async start(request, mode: StartMode, sessionId, commandIndex): Promise<ClaudeProcessHandle> {
      currentTools = request.tools;
      const dir = await ensureServer();
      const command = options.commands[commandIndex];
      if (command?.[0] === undefined) {
        throw new ClaudeProcessError('providers.claude.command가 비어 있습니다.');
      }
      const args = [
        ...command.slice(1),
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--model',
        options.model,
        ...(options.effort === undefined ? [] : ['--effort', options.effort]),
        '--tools',
        '',
        '--mcp-config',
        join(dir, 'mcp.json'),
        '--strict-mcp-config',
        '--allowedTools',
        `mcp__${MCP_SERVER_NAME}`,
        '--setting-sources',
        '',
        '--disable-slash-commands',
        '--system-prompt',
        request.system,
        ...(mode.kind === 'resume' ? ['--resume', sessionId] : ['--session-id', sessionId]),
        ...(options.persistSession ? [] : ['--no-session-persistence']),
      ];
      const child = spawn(command[0], args, {
        cwd: options.cwd,
        env: buildClaudeEnv(options.env, options.cacheTtl),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.unref();
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        if (stream instanceof Socket) stream.unref();
      }
      const stderr = { tail: '' };
      child.stderr.on('data', (chunk: Buffer) => {
        stderr.tail = (stderr.tail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
      });
      // spawn 실패(ENOENT 등)와 stdin 쓰기 오류는 읽기 루프에서 프로세스 종료로 드러난다.
      child.on('error', (error) => {
        stderr.tail = `${stderr.tail}${error.message}`.slice(-STDERR_TAIL_CHARS);
      });
      child.stdin.on('error', () => undefined);
      const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
      children.add(child);
      child.once('close', () => {
        children.delete(child);
      });
      return {
        sendUserText: (text) => {
          child.stdin.write(
            `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`,
          );
        },
        nextEvent: async () => {
          for (;;) {
            const next = await lines.next();
            if (next.done === true) return undefined;
            if (!next.value.startsWith('{')) continue;
            try {
              return JSON.parse(next.value) as unknown;
            } catch {
              continue;
            }
          }
        },
        hold: () => {
          if (child.stdout instanceof Socket) child.stdout.ref();
          child.ref();
        },
        release: () => {
          if (child.stdout instanceof Socket) child.stdout.unref();
          child.unref();
        },
        stderrTail: () => stderr.tail,
        kill: () => {
          child.kill('SIGKILL');
        },
      };
    },
  };
}

/**
 * 사용자의 `claude` CLI를 그대로 실행하는 모델 어댑터다. 로그인은 Claude Code가 갖고 있고, 이 어댑터는 토큰을 읽지 않는다.
 * Ora 도구는 로컬 MCP 서버로 노출한다.
 */
export function createClaudeCliModel(options: ClaudeProviderOptions): ModelPort {
  return createClaudeModel({
    adapter: 'claude-cli',
    options,
    createBackend: (bridge) => createCliBackend(options, bridge),
  });
}
