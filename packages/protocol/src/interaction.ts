import { z } from 'zod';
import { approvalScopeSchema, toolTierSchema } from './common.ts';

export const riskLevelSchema = z.enum(['low', 'medium', 'high']);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

/** 승인 대화상자가 도구별로 그리는 상세다 (SPEC 5.1절). */
export const approvalDetailSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('shell'),
    command: z.string(),
    cwd: z.string(),
    risk: riskLevelSchema,
  }),
  z.strictObject({ kind: z.literal('file'), path: z.string(), content: z.string() }),
  z.strictObject({ kind: z.literal('arguments'), args: z.record(z.string(), z.unknown()) }),
  /** `verify.waive` 승인 카드다. 게이트가 막은 todo를 예외로 `verified`로 바꿀지 사용자에게 묻는다. */
  z.strictObject({
    kind: z.literal('verify_waiver'),
    reason: z.string(),
    findings: z.array(z.string()),
    command: z.string(),
    exitCode: z.number().int().optional(),
  }),
]);
export type ApprovalDetail = z.infer<typeof approvalDetailSchema>;

export const approvalRequestSchema = z.strictObject({
  callId: z.string().min(1),
  tool: z.string().min(1),
  tier: toolTierSchema,
  reason: z.string(),
  detail: approvalDetailSchema,
  /** 이 호출과 연결된 todo다. `verify.run`은 검증 대상 todo, 그 밖의 도구는 진행 중인 todo다. */
  todo: z.strictObject({ id: z.string().min(1), content: z.string() }).optional(),
  /** 하위 세션이 올린 요청이면 그 하위 세션이다. 부모 세션의 승인 카드가 어느 하위 세션의 요청인지 보인다 (SPEC 2.15.1절). */
  from: z
    .strictObject({
      sessionId: z.string().min(1),
      agent: z.string().min(1),
      /** 부모가 위임할 때 적은 `intent`다. 승인 카드가 하위 세션이 하는 일을 한 줄로 보인다. */
      intent: z.string(),
    })
    .optional(),
});
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

/** 승인 결정이다. 승인 전에 고친 명령은 `shell` 호출에만 쓸 수 있다. */
export const approvalDecisionSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('approved'),
    scope: approvalScopeSchema,
    editedCommand: z.string().min(1).optional(),
  }),
  z.strictObject({ outcome: z.literal('denied'), steer: z.string().min(1).optional() }),
]);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

/** `ask_user`의 질문 하나다. 자유 입력은 선택지와 별개로 언제나 받을 수 있다 (SPEC 2.5.1절). */
export const questionSchema = z.object({
  /** 질문을 한눈에 구분하는 짧은 제목이다. */
  header: z.string().min(1).max(12).optional(),
  question: z.string().min(1),
  options: z.array(z.string().min(1)).min(2).max(5),
  multiSelect: z.boolean().optional(),
});
export type Question = z.infer<typeof questionSchema>;

export const questionRequestSchema = z.strictObject({
  callId: z.string().min(1),
  questions: z.array(questionSchema).min(1).max(4),
});
export type QuestionRequest = z.infer<typeof questionRequestSchema>;

/** 질문 하나에 대한 답이다. 고른 선택지와 직접 입력한 글 중 하나 이상이 있어야 한다. */
export const questionAnswerSchema = z
  .strictObject({
    choices: z.array(z.string().min(1)),
    text: z.string().min(1).optional(),
  })
  .refine((answer) => answer.choices.length > 0 || answer.text !== undefined, {
    message: '선택지나 직접 입력 중 하나는 있어야 합니다.',
  });
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;

/**
 * 기억한 승인 하나다 (SPEC 5.1절). 일치 단위는 도구와 인자의 정확한 일치이고 와일드카드는 없다.
 * `shell`과 `verify.run`은 명령 전문과 cwd가 모두 같아야 일치한다.
 */
export const approvalRuleSchema = z.union([
  z.strictObject({ tool: z.string().min(1), command: z.string(), cwd: z.string() }),
  z.strictObject({ tool: z.string().min(1), args: z.record(z.string(), z.unknown()) }),
]);
export type ApprovalRule = z.infer<typeof approvalRuleSchema>;

/** `<oraHome>/permissions.json`의 형식이다. "항상 승인"한 규칙이 쌓이고, 사용자가 직접 고쳐 규칙을 더할 수 있다. */
export const permissionsFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  rules: z.array(approvalRuleSchema),
});
export type PermissionsFile = z.infer<typeof permissionsFileSchema>;
