import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isolationSchema, permissionModeSchema } from '@ora/protocol';
import { z } from 'zod';

export const ENGINE_VERSION = '0.0.0';

export class UsageError extends Error {}

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
