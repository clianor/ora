import { questionSchema, stageSchema, todoStatusSchema } from '@ora/protocol';
import { z } from 'zod';
import type { ToolSpec } from './ports/model.ts';
import type { Tool } from './ports/tool.ts';

const INTENT_DESCRIPTION = '이 호출이 필요한 이유를 한 문장으로 적는다.';

export const todoUpdateSchema = z.object({
  todos: z
    .array(
      z.object({
        id: z.string().min(1),
        content: z.string().min(1).optional(),
        status: todoStatusSchema.optional(),
        writeScope: z
          .array(
            z
              .string()
              .refine(
                (path) => !/[*?[\]{}]/.test(path),
                '글롭 패턴은 쓸 수 없습니다. 파일이나 디렉터리 경로를 적습니다.',
              ),
          )
          .optional(),
        verify: z.object({ command: z.string().min(1) }).optional(),
        claim: z.object({ command: z.string().min(1), result: z.string() }).optional(),
      }),
    )
    .min(1),
});

export const verifyRunSchema = z.object({ todoId: z.string().min(1) });
export const askUserSchema = z.object({
  questions: z.array(questionSchema).min(1).max(4),
});
export const stageAdvanceSchema = z.object({
  to: stageSchema,
  skipReason: z.string().min(1).optional(),
});
export const memoryProposeSchema = z.object({
  text: z.string().min(1),
  source: z.string().min(1).optional(),
});

const CONTROL_TOOLS = {
  'todo.update': {
    description:
      'todo를 추가하거나 상태·검증 명령·쓰기 범위를 바꾼다. verified와 failed는 쓸 수 없다.',
    schema: todoUpdateSchema,
  },
  'verify.run': {
    description: '선언한 검증 명령을 엔진이 실행하고 증거를 기록한다.',
    schema: verifyRunSchema,
  },
  ask_user: {
    description:
      '사용자에게 질문 1~4개를 묻고 답을 받을 때까지 기다린다. 질문마다 12자 이하의 짧은 제목(header)을 붙이고 선택지 2~5개를 주며, 사용자는 직접 입력으로도 답할 수 있다.',
    schema: askUserSchema,
  },
  'stage.advance': {
    description: '다음 단계로 넘어간다. 건너뛰는 단계가 있으면 skipReason이 필요하다.',
    schema: stageAdvanceSchema,
  },
  'memory.propose': {
    description: 'Learn 단계에서 교훈 후보를 낸다. 엔진 규칙이 기록 여부를 판정한다.',
    schema: memoryProposeSchema,
  },
} as const;

export type ControlToolName = keyof typeof CONTROL_TOOLS;

export function isControlTool(name: string): name is ControlToolName {
  return Object.hasOwn(CONTROL_TOOLS, name);
}

/** 모든 도구 스키마에 필수 `intent`를 더해 모델에 보여 줄 도구 목록을 만든다 (SPEC 2.3.1절). */
export function buildToolSpecs(tools: readonly Tool[]): ToolSpec[] {
  const entries = [
    ...tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: tool.inputSchema,
    })),
    ...Object.entries(CONTROL_TOOLS).map(([name, tool]) => ({ name, ...tool })),
  ];
  return entries.map(({ name, description, schema }) => {
    const json = z.toJSONSchema(schema, { io: 'input' });
    const properties = (json.properties ?? {}) as Record<string, unknown>;
    const required = json.required ?? [];
    return {
      name,
      description,
      inputSchema: {
        ...json,
        properties: {
          intent: { type: 'string', minLength: 1, description: INTENT_DESCRIPTION },
          ...properties,
        },
        required: ['intent', ...required],
      },
    };
  });
}
