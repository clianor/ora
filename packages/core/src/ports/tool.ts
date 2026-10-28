import type { ToolResultStatus, ToolTier } from '@ora/protocol';
import { z } from 'zod';

export interface ToolContext {
  readonly cwd: string;
  readonly signal: AbortSignal;
}

export interface ToolOutput {
  readonly status: ToolResultStatus;
  readonly text: string;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly tier: ToolTier;
  readonly inputSchema: z.ZodType;
  run(input: unknown, context: ToolContext): Promise<ToolOutput>;
}

interface ToolDefinition<TInput> {
  readonly name: string;
  readonly description: string;
  readonly tier: ToolTier;
  readonly inputSchema: z.ZodType<TInput>;
  run(input: TInput, context: ToolContext): Promise<ToolOutput>;
}

/** 모델이 만든 입력이 스키마에 맞지 않으면 예외 대신 error 출력을 돌려줘서 모델이 고쳐 다시 호출하게 한다. */
export function defineTool<TInput>(definition: ToolDefinition<TInput>): Tool {
  return {
    name: definition.name,
    description: definition.description,
    tier: definition.tier,
    inputSchema: definition.inputSchema,
    run: async (input, context) => {
      const parsed = definition.inputSchema.safeParse(input);
      if (!parsed.success) return { status: 'error', text: z.prettifyError(parsed.error) };
      return definition.run(parsed.data, context);
    },
  };
}
