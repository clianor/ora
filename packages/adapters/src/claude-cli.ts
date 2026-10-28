import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { scrubText } from '@ora/core';
import type { ModelMessage, ModelPort, ModelRequest, ModelStreamEvent } from '@ora/core';
import type { ContentBlock } from '@ora/protocol';
import { z } from 'zod';
import { createFrameAssembler, toApiName } from './anthropic-frames.ts';
import { MCP_TOKEN_HEADER, startMcpServer } from './claude-mcp-server.ts';
import type { McpServer, McpToolResult } from './claude-mcp-server.ts';

const MCP_SERVER_NAME = 'ora';
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
const STDERR_TAIL_CHARS = 2000;

/** 한도 오류 때문에 현재 명령(계정)으로 더 진행할 수 없음을 뜻한다. */
export class ClaudeLimitError extends Error {}

/** 프로세스가 죽었거나 시작하지 못했거나 오류 결과를 냈다. */
class ClaudeProcessError extends Error {}

/** Ora 기록의 `providerMetadata`에 남기고 재개 때 호스트가 되돌려 주는 값이다. */
export const claudeResumeStateSchema = z.object({
  claudeSessionId: z.string().min(1),
  commandIndex: z.number().int().nonnegative(),
  command: z.array(z.string()),
  /** 이 응답까지 포함해 엔진 history가 가진 메시지 수다. */
  historyLength: z.number().int().positive(),
});
export type ClaudeResumeState = z.infer<typeof claudeResumeStateSchema>;

export interface ClaudeCliOptions {
  readonly model: string;
  readonly effort?: 'low' | 'medium' | 'high';
  readonly cacheTtl: '5m' | '1h';
  /** 실행 명령의 목록이다. 앞에서부터 쓰고, 한도 오류가 나면 다음 명령으로 넘어간다. */
  readonly commands: readonly (readonly string[])[];
  /** 자식 프로세스에 넘길 환경변수다. API 키 변수는 넘기지 않는다. */
  readonly env: NodeJS.ProcessEnv;
  /** 세션 작업 폴더다. `claude`를 이 폴더에서 띄워서 모델이 보는 작업 디렉터리가 도구가 실행되는 폴더와 같게 한다. */
  readonly cwd: string;
  readonly resumeFrom?: ClaudeResumeState;
}

const eventSchema = z.union([
  z.object({ type: z.literal('stream_event'), event: z.unknown() }),
  z.object({
    type: z.literal('result'),
    is_error: z.boolean().optional(),
    subtype: z.string().optional(),
    result: z.string().optional(),
    api_error_status: z.number().nullish(),
  }),
  z.object({
    type: z.literal('rate_limit_event'),
    rate_limit_info: z.object({
      status: z.string().optional(),
      unifiedWindows: z.record(z.string(), z.object({ status: z.string().optional() })).optional(),
    }),
  }),
]);

const LIMIT_TEXT = /usage limit|rate limit|limit reached|hit your limit|limit will reset/i;
const STRIPPED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

interface ClaudeProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly lines: AsyncIterator<string>;
  readonly commandIndex: number;
  readonly sessionId: string;
  readonly system: string;
  readonly toolsKey: string;
  readonly slots: Map<string, PromiseWithResolvers<McpToolResult>>;
  readonly stderr: { tail: string };
  /** 마지막 응답이 부른 `tool_use`의 ID다. 아직 결과를 전달하지 않았다. */
  pendingCallIds: string[];
  /** 엔진 history가 가진 메시지 수(마지막 응답 포함)다. */
  historyLength: number;
  /** 아직 읽지 않은 이전 사이클의 `result` 이벤트 수다. */
  staleResults: number;
  exited: boolean;
}

function renderBlocks(blocks: readonly ContentBlock[]): string {
  return blocks
    .flatMap((block) => {
      switch (block.type) {
        case 'text':
          return [block.text];
        case 'tool_use':
          return [`[도구 호출 ${block.tool} ${JSON.stringify(block.input)}]`];
        case 'tool_result':
          return [`[도구 결과 ${block.callId}${block.isError ? ' (오류)' : ''}]\n${block.text}`];
        case 'thinking':
          return [];
      }
    })
    .join('\n');
}

function renderHistory(messages: readonly ModelMessage[]): string {
  const body = messages
    .map(
      (message) =>
        `${message.role === 'user' ? '사용자' : '어시스턴트'}:\n${renderBlocks(message.content)}`,
    )
    .join('\n\n');
  return `<conversation_history>\n${body}\n</conversation_history>\n위 기록을 이어서 마지막 사용자 메시지에 응답한다. 도구는 실제 도구 호출로만 쓰고, 기록의 \`[도구 호출 …]\` 표기를 글로 흉내 내지 않는다.`;
}

const isUserTextOnly = (messages: readonly ModelMessage[]): boolean =>
  messages.length === 1 &&
  messages[0]?.role === 'user' &&
  messages[0].content.every((block) => block.type === 'text');

/**
 * 사용자의 `claude` CLI를 그대로 실행하는 모델 어댑터다. 로그인은 Claude Code가 갖고 있고, 이 어댑터는 토큰을 읽지 않는다.
 * Ora 도구는 로컬 MCP 서버로 노출하고, 도구 호출 응답을 엔진이 결과를 낼 때까지 보류해서 스텝을 엔진이 주도한다.
 */
export function createClaudeCliModel(options: ClaudeCliOptions): ModelPort {
  let commandIndex = options.resumeFrom?.commandIndex ?? 0;
  let resumeFrom = options.resumeFrom;
  let proc: ClaudeProcess | undefined;
  let mcp: McpServer | undefined;
  let workDir: string | undefined;
  const children = new Set<ChildProcessWithoutNullStreams>();
  let currentTools: ModelRequest['tools'] = [];

  const rejectSlots = (target: ClaudeProcess, text: string) => {
    for (const slot of target.slots.values()) slot.resolve({ text, isError: true });
  };

  const slotFor = (target: ClaudeProcess, id: string): PromiseWithResolvers<McpToolResult> => {
    const existing = target.slots.get(id);
    if (existing !== undefined) return existing;
    const created = Promise.withResolvers<McpToolResult>();
    target.slots.set(id, created);
    return created;
  };

  const killProcess = (target: ClaudeProcess) => {
    target.exited = true;
    rejectSlots(target, '세션이 중단되어 도구 결과를 받지 못했습니다.');
    target.child.kill('SIGKILL');
    if (proc === target) proc = undefined;
  };

  const ensureServer = async (): Promise<{ server: McpServer; dir: string }> => {
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
      callTool: (name, _args, toolUseId) => {
        if (toolUseId === undefined || proc === undefined) {
          return Promise.resolve({ text: '도구 호출을 처리할 수 없습니다.', isError: true });
        }
        const active = proc;
        return slotFor(active, toolUseId).promise.finally(() => {
          active.slots.delete(toolUseId);
        });
      },
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
    return { server: mcp, dir };
  };

  const startProcess = async (
    request: ModelRequest,
    mode: { kind: 'fresh' } | { kind: 'resume'; sessionId: string },
  ): Promise<ClaudeProcess> => {
    currentTools = request.tools;
    const { dir } = await ensureServer();
    const command = options.commands[commandIndex];
    if (command?.[0] === undefined) {
      throw new ClaudeProcessError('providers.claude.command가 비어 있습니다.');
    }
    const sessionId = mode.kind === 'resume' ? mode.sessionId : crypto.randomUUID();
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
    ];
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      Object.entries({
        ...options.env,
        CLAUDE_CODE_PROMPT_CACHE_TTL: options.cacheTtl,
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
        CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      }).filter(([name]) => !STRIPPED_ENV.includes(name)),
    );
    const child = spawn(command[0], args, {
      cwd: options.cwd,
      env,
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
    const created: ClaudeProcess = {
      child,
      lines,
      commandIndex,
      sessionId,
      system: request.system,
      toolsKey: JSON.stringify(request.tools),
      slots: new Map(),
      stderr,
      pendingCallIds: [],
      historyLength: 0,
      staleResults: 0,
      exited: false,
    };
    proc = created;
    return created;
  };

  const sendUserText = (target: ClaudeProcess, text: string) => {
    target.child.stdin.write(
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`,
    );
  };

  /** 이어 갈 수 있는 프로세스면 새 입력만 전달하고, 아니면 프로세스를 새로 띄워 처음부터 전달한다. */
  const deliverInput = async (
    request: ModelRequest,
    forceReplay: boolean,
  ): Promise<ClaudeProcess> => {
    const last = request.messages.at(-1);
    if (last?.role !== 'user') {
      throw new ClaudeProcessError('마지막 메시지가 사용자 메시지가 아닙니다.');
    }
    const live = proc;
    if (live !== undefined && !forceReplay) {
      const results = last.content.filter((block) => block.type === 'tool_result');
      const covered = live.pendingCallIds.every((id) =>
        results.some((block) => block.callId === id),
      );
      const continues =
        !live.exited &&
        live.system === request.system &&
        live.toolsKey === JSON.stringify(request.tools) &&
        request.messages.length === live.historyLength + 1 &&
        covered;
      if (continues) {
        const guidance = last.content.flatMap((block) =>
          block.type === 'text' ? [block.text] : [],
        );
        if (live.pendingCallIds.length === 0) {
          sendUserText(live, guidance.join('\n'));
        } else {
          for (const [index, block] of results.entries()) {
            const isLast = index === results.length - 1;
            const text =
              isLast && guidance.length > 0
                ? `${block.text}\n\n${guidance.join('\n')}`
                : block.text;
            slotFor(live, block.callId).resolve({ text, isError: block.isError });
          }
        }
        live.pendingCallIds = [];
        return live;
      }
    }
    if (live !== undefined) killProcess(live);
    const state = resumeFrom;
    const command = options.commands[commandIndex];
    const canResume =
      !forceReplay &&
      state?.commandIndex === commandIndex &&
      command !== undefined &&
      JSON.stringify(state.command) === JSON.stringify(command) &&
      request.messages.length === state.historyLength + 1;
    resumeFrom = undefined;
    if (canResume) {
      const started = await startProcess(request, {
        kind: 'resume',
        sessionId: state.claudeSessionId,
      });
      sendUserText(started, `(이전 도구 호출의 결과를 전달한다.)\n${renderBlocks(last.content)}`);
      return started;
    }
    const started = await startProcess(request, { kind: 'fresh' });
    sendUserText(
      started,
      isUserTextOnly(request.messages)
        ? renderBlocks(last.content)
        : renderHistory(request.messages),
    );
    return started;
  };

  const nextEvent = async (
    target: ClaudeProcess,
    signal: AbortSignal,
  ): Promise<z.infer<typeof eventSchema> | undefined> => {
    const aborted = Promise.withResolvers<never>();
    aborted.promise.catch(() => undefined);
    const onAbort = () => {
      killProcess(target);
      aborted.reject(signal.reason ?? new Error('중단되었습니다.'));
    };
    if (signal.aborted) onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    if (target.child.stdout instanceof Socket) target.child.stdout.ref();
    target.child.ref();
    try {
      for (;;) {
        const next = await Promise.race([target.lines.next(), aborted.promise]);
        if (next.done === true) return undefined;
        if (!next.value.startsWith('{')) continue;
        let json: unknown;
        try {
          json = JSON.parse(next.value);
        } catch {
          continue;
        }
        const parsed = eventSchema.safeParse(json);
        if (parsed.success) return parsed.data;
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (target.child.stdout instanceof Socket) target.child.stdout.unref();
      target.child.unref();
    }
  };

  const failure = (target: ClaudeProcess, reason: string): Error => {
    const detail = scrubText(target.stderr.tail.trim()).text;
    return new ClaudeProcessError(`${reason}${detail === '' ? '' : `\n${detail}`}`);
  };

  const readStep = async function* (
    request: ModelRequest,
    target: ClaudeProcess,
    signal: AbortSignal,
  ): AsyncGenerator<ModelStreamEvent> {
    const byApiName = new Map(request.tools.map((tool) => [toApiName(tool.name), tool.name]));
    const assembler = createFrameAssembler((name) => {
      const apiName = name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name;
      return byApiName.get(apiName) ?? apiName.replaceAll('__', '.');
    });
    while (!assembler.isDone()) {
      const event = await nextEvent(target, signal);
      if (event === undefined) {
        target.exited = true;
        throw failure(target, 'claude 프로세스가 응답 없이 끝났습니다.');
      }
      if (event.type === 'rate_limit_event') {
        const info = event.rate_limit_info;
        const windows = Object.values(info.unifiedWindows ?? {});
        if (info.status === 'rejected' || windows.some((window) => window.status === 'rejected')) {
          throw new ClaudeLimitError('claude 사용 한도에 도달했습니다.');
        }
      } else if (event.type === 'result') {
        if (target.staleResults > 0) {
          target.staleResults -= 1;
        } else if (event.is_error === true) {
          const text = event.result ?? event.subtype ?? 'claude 오류';
          if (event.api_error_status === 429 || LIMIT_TEXT.test(text)) {
            throw new ClaudeLimitError(scrubText(text).text);
          }
          throw failure(target, scrubText(text).text);
        } else {
          throw failure(target, 'claude가 응답 없이 사이클을 끝냈습니다.');
        }
      } else {
        yield* assembler.push(event.event);
        const error = assembler.getError();
        if (error !== undefined) throw failure(target, `${error.type}: ${error.message}`);
      }
    }
    const completed = assembler.finish();
    if (completed.stopReason !== 'tool_use') target.staleResults += 1;
    target.pendingCallIds = completed.content.flatMap((block) =>
      block.type === 'tool_use' ? [block.callId] : [],
    );
    target.historyLength = request.messages.length + 1;
    const command = options.commands[target.commandIndex] ?? [];
    yield {
      ...completed,
      providerMetadata: {
        claudeSessionId: target.sessionId,
        commandIndex: target.commandIndex,
        command: [...command],
        historyLength: target.historyLength,
      } satisfies ClaudeResumeState,
    };
  };

  return {
    model: options.model,
    adapter: 'claude-cli',
    async *stream(request, signal): AsyncGenerator<ModelStreamEvent> {
      let forceReplay = false;
      for (;;) {
        let yielded = false;
        const reusedBefore = proc !== undefined || resumeFrom !== undefined;
        let target: ClaudeProcess | undefined;
        try {
          target = await deliverInput(request, forceReplay);
          for await (const event of readStep(request, target, signal)) {
            if (event.type !== 'completed') yielded = true;
            yield event;
          }
          return;
        } catch (error) {
          if (target !== undefined) killProcess(target);
          if (signal.aborted) throw error;
          if (error instanceof ClaudeLimitError && commandIndex + 1 < options.commands.length) {
            commandIndex += 1;
            forceReplay = true;
            continue;
          }
          if (error instanceof ClaudeProcessError && !yielded && reusedBefore && !forceReplay) {
            forceReplay = true;
            continue;
          }
          throw error;
        }
      }
    },
  };
}
