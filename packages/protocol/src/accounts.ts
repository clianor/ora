import { z } from 'zod';

/**
 * 설정 › 계정 화면의 HTTP API 본문이다. 응답에는 토큰 필드를 두지 않는다.
 * 스키마가 `strictObject`라서 토큰 필드가 생기면 파싱이 실패한다.
 */

export const accountProviderSchema = z.enum(['claude', 'codex', 'grok']);
export type AccountProvider = z.infer<typeof accountProviderSchema>;

export const limitWindowSchema = z.strictObject({
  /** 남은 비율(0~100 %)이다. */
  remainingPct: z.number().min(0).max(100),
  /** 창의 한도가 초기화되는 시각(ISO 8601)이다. 읽지 못하면 없다. */
  resetsAt: z.string().optional(),
});
export type LimitWindowView = z.infer<typeof limitWindowSchema>;

/** `inUse`는 실행 중인 세션이 고정한 계정, `limited`는 한도에 걸린 계정, `expired`는 다시 로그인해야 하는 계정이다. */
export const accountStatusSchema = z.enum(['inUse', 'limited', 'expired', 'idle']);
export type AccountStatus = z.infer<typeof accountStatusSchema>;

export const accountViewSchema = z.strictObject({
  name: z.string().min(1),
  kind: z.enum(['oauth', 'apiKey']),
  /** OAuth 계정은 이메일, API 키 계정은 읽을 환경변수 이름이다. 이메일을 모르면 없다. */
  detail: z.string().optional(),
  /** API 키 계정에서 서버 환경에 그 환경변수가 있는지 여부다. 값은 알려 주지 않는다. */
  envPresent: z.boolean().optional(),
  priority: z.number(),
  /** 읽지 못했으면 없다. */
  fiveHour: limitWindowSchema.optional(),
  sevenDay: limitWindowSchema.optional(),
  status: accountStatusSchema,
  /** `status`가 `limited`일 때 프로바이더가 한도를 초기화하는 시각(ISO 8601)이다. */
  limitedUntil: z.string().optional(),
});
export type AccountView = z.infer<typeof accountViewSchema>;

/**
 * 진행 중이거나 막 끝난 로그인이다. `url` 방식은 콜백 서버가 도는 로그인 주소를, `device` 방식은 확인 주소와 코드를 담는다.
 * `expiresAt`은 ISO 8601이다.
 */
export const loginStateSchema = z.strictObject({
  status: z.enum(['pending', 'succeeded', 'failed', 'cancelled', 'timeout']),
  prompt: z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('url'), url: z.string(), expiresAt: z.string() }),
      z.strictObject({
        kind: z.literal('device'),
        url: z.string(),
        code: z.string(),
        expiresAt: z.string(),
      }),
    ])
    .optional(),
  /** 로그인에 성공해 저장한 계정 이름이다. */
  accountName: z.string().optional(),
  error: z.string().optional(),
});
export type LoginState = z.infer<typeof loginStateSchema>;

export const providerAccountsSchema = z.strictObject({
  provider: accountProviderSchema,
  accounts: z.array(accountViewSchema),
  login: loginStateSchema.optional(),
});
export type ProviderAccounts = z.infer<typeof providerAccountsSchema>;

export const accountListResponseSchema = z.strictObject({
  providers: z.array(providerAccountsSchema),
});
export type AccountListResponse = z.infer<typeof accountListResponseSchema>;

/** 환경변수 이름 형식이다. 키 값을 붙여 넣는 실수를 막는다. */
export const envNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);

export const addApiKeyBodySchema = z.strictObject({
  envName: envNameSchema,
  /** 없으면 환경변수 이름을 계정 이름으로 쓴다. */
  name: z.string().min(1).max(64).optional(),
});
export type AddApiKeyBody = z.infer<typeof addApiKeyBodySchema>;

export const setPriorityBodySchema = z.strictObject({
  priority: z.number().int().min(-99).max(99),
});
export type SetPriorityBody = z.infer<typeof setPriorityBodySchema>;

/** Codex는 `device`로 디바이스 코드 로그인을 고를 수 있다. */
export const startLoginBodySchema = z.strictObject({ device: z.boolean().optional() });
export type StartLoginBody = z.infer<typeof startLoginBodySchema>;
