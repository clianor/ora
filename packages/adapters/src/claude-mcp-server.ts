import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';

const MAX_BODY_BYTES = 1_048_576;

export const MCP_TOKEN_HEADER = 'x-ora-token';

interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  readonly text: string;
  readonly isError: boolean;
}

export interface McpServerHandlers {
  readonly listTools: () => readonly McpToolDefinition[];
  /** 결과가 나올 때까지 HTTP 응답을 보류한다. `toolUseId`는 Claude Code가 `_meta`에 싣는 `tool_use` ID다. */
  readonly callTool: (
    name: string,
    args: Record<string, unknown>,
    toolUseId: string | undefined,
  ) => Promise<McpToolResult>;
}

export interface McpServer {
  readonly url: string;
  readonly token: string;
  readonly close: () => Promise<void>;
}

const requestSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const callParamsSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).default({}),
  _meta: z.record(z.string(), z.unknown()).optional(),
});

interface Reply {
  readonly status: number;
  readonly body?: unknown;
}

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Claude Code가 접속하는 최소 MCP 서버다 (streamable HTTP, JSON 응답만).
 * 127.0.0.1의 무작위 포트에 묶고 헤더 토큰이 틀린 요청은 거부한다.
 */
export async function startMcpServer(handlers: McpServerHandlers): Promise<McpServer> {
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const expected = Buffer.from(token);

  const handle = async (req: IncomingMessage): Promise<Reply> => {
    const given = Buffer.from(String(req.headers[MCP_TOKEN_HEADER] ?? ''));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return { status: 401 };
    }
    if (req.method !== 'POST') return { status: 405 };
    const text = await readBody(req);
    if (text === undefined) return { status: 413 };

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { status: 400 };
    }
    const parsed = requestSchema.safeParse(json);
    if (!parsed.success) return { status: 400 };
    const { id, method, params = {} } = parsed.data;
    if (id === undefined) return { status: 202 };
    const result = (value: unknown): Reply => ({
      status: 200,
      body: { jsonrpc: '2.0', id, result: value },
    });
    const fail = (code: number, reason: string): Reply => ({
      status: 200,
      body: { jsonrpc: '2.0', id, error: { code, message: reason } },
    });

    switch (method) {
      case 'initialize':
        return result({
          protocolVersion:
            typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'ora', version: '0.0.0' },
        });
      case 'ping':
        return result({});
      case 'tools/list':
        return result({ tools: handlers.listTools() });
      case 'tools/call': {
        const call = callParamsSchema.safeParse(params);
        if (!call.success) return fail(-32602, 'invalid params');
        const toolUseId = call.data._meta?.['claudecode/toolUseId'];
        try {
          const outcome = await handlers.callTool(
            call.data.name,
            call.data.arguments,
            typeof toolUseId === 'string' ? toolUseId : undefined,
          );
          return result({
            content: [{ type: 'text', text: outcome.text }],
            isError: outcome.isError,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return result({ content: [{ type: 'text', text: message }], isError: true });
        }
      }
      default:
        return fail(-32601, `method not found: ${method}`);
    }
  };

  const server = createServer((req, res) => {
    handle(req)
      .then((reply) => {
        res.writeHead(
          reply.status,
          reply.body === undefined ? {} : { 'content-type': 'application/json' },
        );
        res.end(reply.body === undefined ? undefined : JSON.stringify(reply.body));
      })
      .catch(() => {
        res.writeHead(500);
        res.end();
      });
  });
  const listening = Promise.withResolvers<undefined>();
  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', () => {
    listening.resolve(undefined);
  });
  await listening.promise;
  server.unref();
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    close: () => {
      const closed = Promise.withResolvers<undefined>();
      server.closeAllConnections();
      server.close(() => {
        closed.resolve(undefined);
      });
      return closed.promise;
    },
  };
}
