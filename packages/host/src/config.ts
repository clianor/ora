import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { accountPolicySchema, catalogModelSchema, createCatalog } from '@ora/adapters';
import type { ModelChainEntry } from '@ora/core';
import { isolationSchema, permissionModeSchema } from '@ora/protocol';
import { z } from 'zod';

export const ENGINE_VERSION = '0.0.0';

export class UsageError extends Error {}

const PROVIDER_NAMES = ['claude', 'codex', 'grok'] as const;

const removedModelKey = (key: 'model' | 'effort') =>
  z
    .never({
      error: `providers.<이름>.${key}는 없어졌습니다. roles.default.chain으로 옮깁니다. 예: "roles": { "default": { "chain": ["claude/claude-sonnet-5-5:medium"] } }`,
    })
    .optional();

/** Claude 구독 프로바이더다. `fetch`는 Ora가 로그인한 계정(`<oraHome>/auth.json`)으로 직접 호출하고, `sdk`와 `cli`는 설치된 `claude`를 쓴다. */
const claudeProviderSchema = z.strictObject({
  /** `sdk`와 `cli` 경로의 실행 명령 목록이다. 한도 오류가 나면 다음 명령으로 넘어가고, 하나뿐이면 오류로 끝낸다. */
  command: z
    .array(z.array(z.string().min(1)).min(1))
    .min(1)
    .default([['claude']]),
  model: removedModelKey('model'),
  effort: removedModelKey('effort'),
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
  model: removedModelKey('model'),
  /** 쓸 계정 이름이다. 없으면 `accountPolicies`의 우선순위로 고른다. 있으면 그 계정을 쓰고, 막히거나 갱신에 실패할 때만 다른 계정으로 넘어간다. */
  account: z.string().min(1).optional(),
  effort: removedModelKey('effort'),
  /** 출력 토큰 상한이다. Codex 전송 형식은 출력 상한을 서버에 보내지 않으므로 Grok에서만 효과가 있다. */
  maxTokens: z.number().int().positive().default(8192),
});

/** 체인 항목 `<프로바이더>/<모델>[:<추론 강도>]`를 나눈다. 형식이 틀리면 `undefined`다. */
function parseChainEntry(
  text: string,
  source: ModelChainEntry['source'],
): ModelChainEntry | undefined {
  const match = /^([^/:\s]+)\/([^:\s]+)(?::(low|medium|high))?$/.exec(text);
  const [, provider, model, effort] = match ?? [];
  if (provider === undefined || model === undefined) return undefined;
  if (!PROVIDER_NAMES.some((name) => name === provider)) return undefined;
  return {
    provider,
    model,
    ...(effort === undefined ? {} : { effort: effort as 'low' | 'medium' | 'high' }),
    source,
  };
}

const chainSchema = z
  .array(
    z.string().refine((text) => parseChainEntry(text, 'config') !== undefined, {
      error:
        '체인 항목은 <claude|codex|grok>/<모델>[:<low|medium|high>] 형식입니다. 예: claude/claude-sonnet-5-5:medium',
    }),
  )
  .default([]);

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
  /** 역할마다 모델 체인을 둔다. 기본 역할은 default, compaction, memory, review, fast이고 역할을 더할 수 있다. 비어 있는 역할은 default 체인을 쓴다. */
  roles: z.record(z.string().min(1), z.strictObject({ chain: chainSchema })).default({}),
  fallback: z
    .strictObject({
      on: z.enum(['any', 'usage-limit', 'except-usage-limit']).default('any'),
      revertPolicy: z.enum(['cooldown-expiry', 'never']).default('cooldown-expiry'),
    })
    .default({ on: 'any', revertPolicy: 'cooldown-expiry' }),
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
  /** 컨텍스트 압축 설정이다 (SPEC 4.3절). 요약 모델은 `roles.compaction` 체인이 정한다. */
  context: z
    .strictObject({
      compactAtRatio: z.number().gt(0).lte(1).default(0.8),
      keepRecentTokens: z.number().int().positive().default(20000),
      protectToolTokens: z.number().int().nonnegative().default(40000),
      minPruneSavings: z.number().int().nonnegative().default(20000),
      methodOrder: z
        .array(z.enum(['shake', 'handoff', 'summary']))
        .min(1)
        .default(['handoff', 'shake', 'summary']),
      keepRecentSteps: z
        .never({
          error:
            'context.keepRecentSteps는 없어졌습니다. 토큰 수를 쓰는 context.keepRecentTokens로 바꿉니다.',
        })
        .optional(),
    })
    .default({
      compactAtRatio: 0.8,
      keepRecentTokens: 20000,
      protectToolTokens: 40000,
      minPruneSavings: 20000,
      methodOrder: ['handoff', 'shake', 'summary'],
    }),
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

const BASE_ROLES = ['default', 'compaction', 'memory', 'review', 'fast'];

export interface ResolveChainsOptions {
  /** 사용자가 고른 모델이다. `default` 체인 맨 앞에 넣고, 같은 항목이 체인에 있으면 앞으로 옮긴다. */
  readonly userModel?: string;
  /** 가짜 모델 스크립트를 쓰면 체인이 비어도, 카탈로그에 없어도 오류가 아니다. */
  readonly scripted?: boolean;
}

/**
 * 역할마다 모델 체인을 구한다. 비어 있는 역할은 `default` 체인을 쓴다.
 * 형식이나 카탈로그가 틀리거나 `default` 체인이 비어 있으면 시작 전에 사용 오류를 낸다.
 */
export function resolveChains(
  config: Config,
  options: ResolveChainsOptions = {},
): Record<string, ModelChainEntry[]> {
  const parse = (text: string, source: ModelChainEntry['source']) => {
    const entry = parseChainEntry(text, source);
    if (entry === undefined) {
      throw new UsageError(
        `모델 항목 형식이 틀립니다: ${text}. <claude|codex|grok>/<모델>[:<low|medium|high>] 형식입니다.`,
      );
    }
    return entry;
  };
  const configured = (role: string) =>
    (config.roles[role]?.chain ?? []).map((text) => parse(text, 'config'));
  let base = configured('default');
  if (options.userModel !== undefined) {
    const chosen = parse(options.userModel, 'user');
    const same = (entry: ModelChainEntry) =>
      entry.provider === chosen.provider &&
      entry.model === chosen.model &&
      entry.effort === chosen.effort;
    base = [chosen, ...base.filter((entry) => !same(entry))];
  }
  if (base.length === 0 && options.scripted !== true) {
    throw new UsageError(
      '설정 roles.default.chain이 비어 있습니다. 예: "roles": { "default": { "chain": ["claude/claude-sonnet-5-5:medium"] } }. 모델 스크립트를 쓰려면 --model-script를 줍니다.',
    );
  }
  const roles = new Set([...BASE_ROLES, ...Object.keys(config.roles)]);
  const chains: Record<string, ModelChainEntry[]> = {};
  for (const role of roles) {
    const own = role === 'default' ? base : configured(role);
    chains[role] = own.length === 0 ? base : own;
  }
  if (options.scripted !== true) {
    const catalog = createCatalog(config.models);
    for (const [role, chain] of Object.entries(chains)) {
      for (const entry of chain) {
        const known = catalog(entry.model);
        if (known === undefined) {
          throw new UsageError(
            `roles.${role}.chain의 모델이 카탈로그에 없습니다: ${entry.provider}/${entry.model}. 설정 models에 추가합니다.`,
          );
        }
        if (known.provider !== entry.provider) {
          throw new UsageError(
            `모델 ${entry.model}의 카탈로그 프로바이더는 ${known.provider}입니다: roles.${role}.chain의 ${entry.provider}/${entry.model}`,
          );
        }
      }
    }
  }
  return chains;
}
