import { z } from 'zod';
import { timestampSchema } from './common.ts';

/** 스킬이 놓인 곳이다. `project`는 작업 폴더의 `.ora/skills/`, `global`은 설정 `paths.skillsDir`이다 (SPEC 2.10절). */
export const skillScopeSchema = z.enum(['project', 'global']);
export type SkillScope = z.infer<typeof skillScopeSchema>;

/** `recall` 이벤트와 설정 › 스킬이 스킬 하나를 가리키는 값이다. 같은 이름이 두 범위에 있으면 범위로 가른다. */
export const skillRefSchema = z.strictObject({
  name: z.string().min(1),
  scope: skillScopeSchema,
});
export type SkillRef = z.infer<typeof skillRefSchema>;

/** 설정 › 스킬의 스킬 한 줄이다. `isShadowed`는 같은 이름의 프로젝트 스킬이 이 전역 스킬을 가린다는 뜻이다. */
export const skillSummarySchema = z.strictObject({
  name: z.string().min(1),
  description: z.string(),
  scope: skillScopeSchema,
  isShadowed: z.boolean(),
  /** 이 스킬 본문을 회상 팩에 넣은 횟수다. 세션 기록의 `recall` 이벤트에서 센다. */
  useCount: z.number().int().nonnegative(),
  lastUsedAt: timestampSchema.optional(),
});
export type SkillSummary = z.infer<typeof skillSummarySchema>;

/** 설정 › 스킬의 "최근 회상" 한 줄이다. 세션 하나가 시작할 때 스킬을 고른 결과다. */
export const recentRecallSchema = z.strictObject({
  sessionId: z.string().min(1),
  title: z.string(),
  at: timestampSchema,
  injected: z.array(skillRefSchema),
  /** 관련은 있었지만 토큰 예산 때문에 본문을 넣지 않은 스킬이다. */
  candidates: z.array(skillRefSchema),
});
export type RecentRecall = z.infer<typeof recentRecallSchema>;

export const skillListResponseSchema = z.strictObject({
  /** 프로젝트 스킬을 읽은 작업 폴더의 이름이다. */
  projectName: z.string(),
  project: z.array(skillSummarySchema),
  global: z.array(skillSummarySchema),
  recent: z.array(recentRecallSchema),
});
export type SkillListResponse = z.infer<typeof skillListResponseSchema>;
