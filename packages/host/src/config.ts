import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { accountPolicySchema, catalogModelSchema } from '@ora/adapters';
import { isolationSchema, permissionModeSchema } from '@ora/protocol';
import { z } from 'zod';

export const ENGINE_VERSION = '0.0.0';

export class UsageError extends Error {}

/** Claude 구독 프로바이더다. `fetch`는 Ora가 로그인한 계정(`<oraHome>/auth.json`)으로 직접 호출하고, `sdk`와 `cli`는 설치된 `claude`를 쓴다. */
const claudeProviderSchema = z.strictObject({
  /** `sdk`와 `cli` 경로의 실행 명령 목록이다. 한도 오류가 나면 다음 명령으로 넘어가고, 하나뿐이면 오류로 끝낸다. */
  command: z
    .array(z.array(z.string().min(1)).min(1))
    .min(1)
    .default([['claude']]),
  model: z.string().min(1).optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  cacheTtl: z.enum(['5m', '1h']).default('1h'),
  /** 구독 경로의 구현이다. */
  via: z.enum(['fetch', 'sdk', 'cli']).default('fetch'),
  /** `fetch` 경로에서 쓸 계정 이름이다. 없으면 `accountPolicies`의 우선순위로 고른다. 있으면 그 계정을 쓰고, 막히거나 갱신에 실패할 때만 다른 계정으로 넘어간다. */
  account: z.string().min(1).optional(),
  /** `fetch` 경로의 최대 출력 토큰이다. */
  maxTokens: z.number().int().positive().default(8192),
});

/** Codex(ChatGPT 구독)와 Grok(SuperGrok) 프로바이더다. 모델 id는 카탈로그에서 찾고, 없으면 기본 주소와 `maxTokens`로 만든다. */
const responsesProviderSchema = z.strictObject({
  model: z.string().min(1).optional(),
  /** 쓸 계정 이름이다. 없으면 `accountPolicies`의 우선순위로 고른다. 있으면 그 계정을 쓰고, 막히거나 갱신에 실패할 때만 다른 계정으로 넘어간다. */
  account: z.string().min(1).optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  /** 출력 토큰 상한이다. Codex 전송 형식은 출력 상한을 서버에 보내지 않으므로 Grok에서만 효과가 있다. */
  maxTokens: z.number().int().positive().default(8192),
});

const configSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  projectId: z.string().nullable().default(null),
  paths: z
    .object({
      sessions: z.string().nullable().default(null),
      memory: z.string().nullable().default(null),
      isolationRoot: z.string().nullable().default(null),
    })
    .default({ sessions: null, memory: null, isolationRoot: null }),
  permissions: z
    .object({
      mode: permissionModeSchema.default('bypass-permissions'),
      tools: z.record(z.string(), z.enum(['allow', 'prompt', 'deny'])).default({}),
    })
    .default({ mode: 'bypass-permissions', tools: {} }),
  providers: z
    .strictObject({
      claude: claudeProviderSchema.default(claudeProviderSchema.parse({})),
      codex: responsesProviderSchema.default(responsesProviderSchema.parse({})),
      grok: responsesProviderSchema.default(responsesProviderSchema.parse({})),
    })
    .default({
      claude: claudeProviderSchema.parse({}),
      codex: responsesProviderSchema.parse({}),
      grok: responsesProviderSchema.parse({}),
    }),
  /** 계정마다 우선순위와 예비 한도를 정한다. API 키 계정도 `ora login <프로바이더> --api-key-env`로 만든 계정이므로 여기에 적는다. */
  accountPolicies: z.array(accountPolicySchema).default([]),
  retry: z
    .object({
      /** 정책에 `reservePct`가 없는 계정의 예비 한도(%)다. 남은 사용량이 이 값보다 작으면 새 세션은 그 계정을 건너뛴다. */
      usageReservePct: z.number().min(0).max(100).default(10),
    })
    .default({ usageReservePct: 10 }),
  isolation: isolationSchema.default('harness'),
  limits: z
    .object({
      maxSteps: z.number().int().positive().default(50),
      maxRepairsPerTodo: z.number().int().nonnegative().default(3),
      noProgressSteps: z.number().int().positive().default(5),
      maxConcurrentSessions: z.number().int().positive().default(4),
    })
    .default({
      maxSteps: 50,
      maxRepairsPerTodo: 3,
      noProgressSteps: 5,
      maxConcurrentSessions: 4,
    }),
  tools: z
    .object({
      shellTimeoutMs: z.number().int().positive().default(120000),
      maxOutputBytes: z.number().int().positive().default(30000),
      maxFileBytes: z.number().int().positive().default(1048576),
    })
    .default({ shellTimeoutMs: 120000, maxOutputBytes: 30000, maxFileBytes: 1048576 }),
  recall: z
    .object({ tokenBudget: z.number().int().nonnegative().default(2000) })
    .default({ tokenBudget: 2000 }),
  /** 컨텍스트 압축 설정이다 (SPEC 4.3절). 요약 모델은 세션 모델이고, `roles.compaction`은 아직 구현하지 않았다. */
  context: z
    .object({
      compactAtRatio: z.number().gt(0).lte(1).default(0.8),
      keepRecentSteps: z.number().int().positive().default(10),
    })
    .default({ compactAtRatio: 0.8, keepRecentSteps: 10 }),
  /** 모델 카탈로그다. 같은 id는 내장 항목(`claude-haiku-5-5` 등)을 덮어쓰고, 다른 id는 모델을 늘린다. */
  models: z.array(catalogModelSchema).default([]),
});
export type Config = z.infer<typeof configSchema>;

export async function loadConfig(configPath: string | undefined, oraHome: string): Promise<Config> {
  const path = configPath ?? join(oraHome, 'engine.config.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    if (configPath !== undefined)
      throw new UsageError(`설정 파일을 읽을 수 없습니다: ${configPath}`);
    // 설정 파일이 없으면 fail-closed로 always-ask에서 시작한다 (SPEC 5.1절).
    return configSchema.parse({ permissions: { mode: 'always-ask' } });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new UsageError(`설정 파일이 JSON이 아닙니다: ${path}: ${String(error)}`);
  }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success)
    throw new UsageError(`설정 파일 형식이 틀립니다: ${path}\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
export function resolveSessionsDir(config: Config, oraHome: string): string {
  return config.paths.sessions ?? join(oraHome, 'sessions');
}

/** 모델 이름이 있는 프로바이더를 고른다. 둘 이상 있으면 어느 쪽을 쓸지 알 수 없으므로 오류다. */
export function selectProvider(config: Config): 'claude' | 'codex' | 'grok' | undefined {
  const configured = (['claude', 'codex', 'grok'] as const).filter(
    (name) => config.providers[name].model !== undefined,
  );
  if (configured.length > 1) {
    throw new UsageError(
      `설정 ${configured.map((name) => `providers.${name}.model`).join(', ')}이 모두 있습니다. 하나만 설정합니다.`,
    );
  }
  return configured[0];
}
