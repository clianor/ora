import { appendFile, readFile } from 'node:fs/promises';
import { ModelLimitError } from '@ora/core';
import type { ModelPort, ModelRequest, ModelStreamEvent } from '@ora/core';
import { contentBlockSchema } from '@ora/protocol';
import { z } from 'zod';

const usageSchema = z.object({
  uncachedInputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

const scriptSchema = z.object({
  responses: z.array(
    z.union([
      z.object({ content: z.array(contentBlockSchema), usage: usageSchema.optional() }),
      // 요청을 실패시킨다. `limit`이면 사용량 한도 오류이고 `resetAfterMs`는 지금부터 해제까지의 시간이다.
      z.object({
        error: z.object({
          kind: z.enum(['limit', 'error']),
          message: z.string().default('가짜 모델 오류'),
          resetAfterMs: z.number().int().nonnegative().optional(),
        }),
      }),
    ]),
  ),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  acceptsOutputCap: z.boolean().optional(),
  /** 있으면 모델이 서버 압축(`compact`)을 지원하는 것처럼 이 요약을 돌려준다. 없으면 지원하지 않는다. */
  remote: z.object({ text: z.string(), usage: usageSchema.optional() }).optional(),
});

/**
 * JSON 스크립트의 응답을 순서대로 재생하는 가짜 모델이다. 같은 스크립트는 항상 같은 출력을 낸다.
 * `inputLogPath`를 주면 모델이 받은 요청(시스템 프롬프트, 메시지, 도구 이름)을 JSONL로 덧붙여 기록한다.
 */
export async function loadScriptedModel(
  scriptPath: string,
  inputLogPath?: string,
): Promise<ModelPort> {
  const script = scriptSchema.parse(JSON.parse(await readFile(scriptPath, 'utf8')));
  let next = 0;
  return {
    ...(script.contextWindow === undefined ? {} : { contextWindow: script.contextWindow }),
    ...(script.maxOutputTokens === undefined ? {} : { maxOutputTokens: script.maxOutputTokens }),
    ...(script.acceptsOutputCap === undefined ? {} : { acceptsOutputCap: script.acceptsOutputCap }),
    ...(script.remote === undefined
      ? {}
      : {
          async compact(request: ModelRequest) {
            if (inputLogPath !== undefined) {
              const record = {
                remote: true,
                system: request.system,
                messages: request.messages,
                tools: request.tools.map((tool) => tool.name),
                maxOutputTokens: request.maxOutputTokens ?? null,
              };
              await appendFile(inputLogPath, `${JSON.stringify(record)}\n`, 'utf8');
            }
            return {
              text: script.remote?.text ?? '',
              usage: script.remote?.usage ?? {
                uncachedInputTokens: 0,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
                outputTokens: 0,
              },
            };
          },
        }),
    model: 'fake/scripted',
    adapter: 'fake',
    async *stream(request): AsyncGenerator<ModelStreamEvent> {
      if (inputLogPath !== undefined) {
        const record = {
          system: request.system,
          messages: request.messages,
          tools: request.tools.map((tool) => tool.name),
          maxOutputTokens: request.maxOutputTokens ?? null,
        };
        await appendFile(inputLogPath, `${JSON.stringify(record)}\n`, 'utf8');
      }
      const response = script.responses[next];
      if (response === undefined) {
        throw new Error(`가짜 모델 스크립트의 응답 ${script.responses.length}개를 모두 썼습니다.`);
      }
      next += 1;
      if ('error' in response) {
        const { kind, message, resetAfterMs } = response.error;
        throw kind === 'limit'
          ? new ModelLimitError(
              message,
              resetAfterMs === undefined ? undefined : Date.now() + resetAfterMs,
            )
          : new Error(message);
      }
      const hasToolUse = response.content.some((block) => block.type === 'tool_use');
      yield {
        type: 'completed',
        content: response.content,
        stopReason: hasToolUse ? 'tool_use' : 'end_turn',
        usage: response.usage ?? {
          uncachedInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          outputTokens: 0,
        },
        nativeToolCalls: true,
      };
    },
  };
}

export { createClaudeCliModel } from './claude-cli.ts';
export { createClaudeSdkModel } from './claude-sdk.ts';
export { ClaudeLimitError, claudeResumeStateSchema } from './claude-shared.ts';
export type { ClaudeProviderOptions, ClaudeResumeState } from './claude-shared.ts';
export { createAccountStore } from './fetch/accounts.ts';
export type { Account, AccountStore, NewAccount } from './fetch/accounts.ts';
export { BUILTIN_MODELS, catalogModelSchema, createCatalog } from './fetch/catalog.ts';
export type { CatalogModel } from './fetch/catalog.ts';
export { loginClaude } from './fetch/claude-oauth.ts';
export type { ClaudeLoginIo } from './fetch/claude-oauth.ts';
export { loginCodex } from './fetch/codex.ts';
export type { CodexLoginIo } from './fetch/codex.ts';
export { loginGrok } from './fetch/grok.ts';
export type { GrokLoginIo } from './fetch/grok.ts';
export { createFetchModel } from './fetch/model.ts';
export { getProvider } from './fetch/providers.ts';
export { accountPolicySchema } from './fetch/select.ts';
export type { AccountPolicy } from './fetch/select.ts';
export { UsageLimitError } from './fetch/wire.ts';
export type { LimitWindow, OAuthTokens, UsageLimits } from './fetch/wire.ts';
export { withFileLock, writeFileAtomic } from './fetch/file-store.ts';
