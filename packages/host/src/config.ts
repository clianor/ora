import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isolationSchema, permissionModeSchema } from '@ora/protocol';
import { z } from 'zod';

export const ENGINE_VERSION = '0.0.0';

export class UsageError extends Error {}

const anthropicProviderSchema = z.strictObject({
  /** API 키를 읽을 환경변수 이름의 목록이다. 앞에서부터 값이 있는 첫 변수를 쓴다. 키 값은 설정 파일에 적지 못한다. */
  credentialEnv: z
    .array(
      z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, '환경변수 이름이어야 합니다. 키 값을 적으면 안 됩니다.'),
    )
    .min(1)
    .default(['ANTHROPIC_API_KEY']),
  /** 모델 이름은 코드에 두지 않는다 (SPEC 2.4절). `--model-script`가 없으면 필수다. */
  model: z.string().min(1).optional(),
  baseUrl: z.url().optional(),
  maxTokens: z.number().int().positive().default(8192),
  effort: z.enum(['low', 'medium', 'high']).optional(),
});

const configSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  projectId: z.string().nullable().default(null),
  paths: z
    .object({
      sessions: z.string().nullable().default(null),
      memory: z.string().nullable().default(null),
    })
    .default({ sessions: null, memory: null }),
  permissions: z
    .object({
      mode: permissionModeSchema.default('bypass-permissions'),
      tools: z.record(z.string(), z.enum(['allow', 'prompt', 'deny'])).default({}),
    })
    .default({ mode: 'bypass-permissions', tools: {} }),
  providers: z
    .object({ anthropic: anthropicProviderSchema.default(anthropicProviderSchema.parse({})) })
    .default({ anthropic: anthropicProviderSchema.parse({}) }),
  isolation: isolationSchema.default('harness'),
  limits: z
    .object({
      maxSteps: z.number().int().positive().default(50),
      maxRepairsPerTodo: z.number().int().nonnegative().default(3),
      maxConcurrentSessions: z.number().int().positive().default(4),
    })
    .default({ maxSteps: 50, maxRepairsPerTodo: 3, maxConcurrentSessions: 4 }),
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
