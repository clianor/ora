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
        phase: z.string().optional(),
        reason: z.string().optional(),
        current: z.literal(true).optional(),
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
    .default([]),
  phases: z
    .array(z.object({ name: z.string(), criterion: z.string().max(200).optional() }))
    .optional(),
  objective: z.string().max(200).optional(),
});

export const verifyRunSchema = z.object({ todoId: z.string().min(1) });
export const verifyWaiveSchema = z.object({
  todoId: z.string().min(1),
  reason: z.string().min(1).max(300),
});
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
export const agentDelegateSchema = z.object({
  agent: z.string().min(1),
  todoId: z.string().min(1).optional(),
  brief: z.object({
    goal: z.string().min(1),
    writeScope: z.array(z.string()).default([]),
    verifyCommand: z.string().min(1).optional(),
    stopCondition: z.string().min(1),
  }),
});

const CONTROL_TOOLS = {
  'todo.update': {
    description:
      'todo를 추가하거나 상태·검증 명령·쓰기 범위·phase를 바꾼다. phase는 todo를 묶는 이름(1~40자)이고 없으면 "할 일"이다. phases에 phase의 완료 조건(빈 문자열이면 지움)을, objective에 세션 목표 한 줄(200자 이하, 빈 문자열이면 지움)을 적는다. current: true로 작업 중인 todo를 바꾼다. 끝낼 수 없는 todo는 status blocked와 reason(1~300자)으로 표시하고, 다시 시도하면 attempted로 바꾼다. verified, failed, abandoned는 쓸 수 없다.',
    schema: todoUpdateSchema,
  },
  'verify.run': {
    description: '선언한 검증 명령을 엔진이 실행하고 증거를 기록한다.',
    schema: verifyRunSchema,
  },
  'verify.waive': {
    description:
      '완성 무결성 게이트 때문에 failed가 된 todo에 예외를 요청한다. 사용자가 승인해야 verified가 된다. 사용자가 TODO나 건너뜀을 일부러 요청한 것처럼 정당한 사유가 있을 때만 쓰고, reason에 사유를 적는다.',
    schema: verifyWaiveSchema,
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
  'agent.delegate': {
    description:
      '에이전트 정의(agent)로 하위 세션을 만들어 일을 맡기고, 끝나면 결과를 돌려받는다. 하위 세션은 이 대화를 보지 못하고 brief(goal, writeScope, verifyCommand, stopCondition)만 받는다. 하위 세션이 낸 검증 증거는 인정하지 않는다. todoId에 연결할 todo를 적으면 위임이 끝난 뒤 그 todo가 attempted가 되고, verify.run으로 같은 검증 명령을 직접 실행해야 verified가 된다. 한 응답에서 여러 번 부르면 동시에 실행한다.',
    schema: agentDelegateSchema,
  },
} as const;

export type ControlToolName = keyof typeof CONTROL_TOOLS;

export function isControlTool(name: string): name is ControlToolName {
  return Object.hasOwn(CONTROL_TOOLS, name);
}

/** 모든 도구 스키마에 필수 `intent`를 더해 모델에 보여 줄 도구 목록을 만든다 (SPEC 2.3.1절). `hidden`에 든 이름은 목록에서 뺀다. */
export function buildToolSpecs(
  tools: readonly Tool[],
  hidden: ReadonlySet<string> = new Set(),
): ToolSpec[] {
  const entries = [
    ...tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: tool.inputSchema,
    })),
    ...Object.entries(CONTROL_TOOLS).map(([name, tool]) => ({ name, ...tool })),
  ].filter((entry) => !hidden.has(entry.name));
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
