import { appendFile, readFile } from 'node:fs/promises';
import type { ModelPort, ModelStreamEvent } from '@ora/core';
import { contentBlockSchema } from '@ora/protocol';
import { z } from 'zod';

const scriptSchema = z.object({
  responses: z.array(
    z.object({
      content: z.array(contentBlockSchema),
      usage: z
        .object({
          uncachedInputTokens: z.number().int().nonnegative(),
          cacheReadInputTokens: z.number().int().nonnegative(),
          cacheCreationInputTokens: z.number().int().nonnegative(),
          outputTokens: z.number().int().nonnegative(),
        })
        .optional(),
    }),
  ),
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
    model: 'fake/scripted',
    adapter: 'fake',
    async *stream(request): AsyncGenerator<ModelStreamEvent> {
      if (inputLogPath !== undefined) {
        const record = {
          system: request.system,
          messages: request.messages,
          tools: request.tools.map((tool) => tool.name),
        };
        await appendFile(inputLogPath, `${JSON.stringify(record)}\n`, 'utf8');
      }
      const response = script.responses[next];
      if (response === undefined) {
        throw new Error(`가짜 모델 스크립트의 응답 ${script.responses.length}개를 모두 썼습니다.`);
      }
      next += 1;
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

export { createAnthropicModel } from './anthropic.ts';
export type { AnthropicOptions } from './anthropic.ts';
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
export { UsageLimitError } from './fetch/wire.ts';
