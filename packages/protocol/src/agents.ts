import { z } from 'zod';

export const agentScopeSchema = z.enum(['project', 'global', 'builtin']);
export type AgentScope = z.infer<typeof agentScopeSchema>;

/** 설정 › 에이전트의 정의 한 줄이다. `tools`는 도구 이름, `tier:read` 같은 티어, `*`(모든 도구)다. */
export const agentSummarySchema = z.strictObject({
  name: z.string().min(1),
  description: z.string(),
  scope: agentScopeSchema,
  role: z.string().min(1),
  tools: z.array(z.string()),
  maxSteps: z.number().int().positive(),
  /** 같은 이름의 기본 제공 정의를 이 정의가 덮어쓴다. */
  overridesBuiltin: z.boolean(),
  /** 같은 이름의 다른 정의가 이 정의를 가린다. 기본 제공 정의는 프로젝트·전역 정의가, 전역 정의는 프로젝트 정의가 가린다. */
  isShadowed: z.boolean(),
  /** 정의 파일의 실제 경로다. 기본 제공 정의에는 없다. */
  path: z.string().min(1).optional(),
});
export type AgentSummary = z.infer<typeof agentSummarySchema>;

/** 건너뛴 정의 파일이다. 이유를 설정 화면에 보인다. */
export const agentLoadErrorSchema = z.strictObject({
  file: z.string().min(1),
  scope: z.enum(['project', 'global']),
  reason: z.string().min(1),
});
export type AgentLoadError = z.infer<typeof agentLoadErrorSchema>;

export const agentListResponseSchema = z.strictObject({
  /** 프로젝트 정의를 읽은 작업 폴더의 이름이다. */
  projectName: z.string(),
  /** 프로젝트 정의 폴더(`<작업 폴더>/.ora/agents`)와 전역 정의 폴더(`<Ora 홈>/agents`)의 경로다. 프로젝트 폴더는 작업 폴더를 모르면 없다. */
  projectDir: z.string().optional(),
  globalDir: z.string(),
  project: z.array(agentSummarySchema),
  global: z.array(agentSummarySchema),
  builtin: z.array(agentSummarySchema),
  errors: z.array(agentLoadErrorSchema),
});
export type AgentListResponse = z.infer<typeof agentListResponseSchema>;

/** `POST /api/open-path`의 본문이다. 에이전트 정의 파일과 폴더만 운영체제로 연다. `cwd`는 프로젝트 정의를 읽은 작업 폴더다. */
export const openPathBodySchema = z.strictObject({
  path: z.string().min(1),
  cwd: z.string().min(1).optional(),
});
export type OpenPathBody = z.infer<typeof openPathBodySchema>;
