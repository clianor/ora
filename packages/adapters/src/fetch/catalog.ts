import { z } from 'zod';

const WIRE_FORMATS = ['anthropic-messages', 'openai-responses', 'openai-codex-responses'] as const;
export type WireFormat = (typeof WIRE_FORMATS)[number];

/** 설정 `models`의 항목이자 내장 기본 항목의 모양이다 (SPEC 2.4절). */
export const catalogModelSchema = z.strictObject({
  id: z.string().min(1),
  provider: z.string().min(1),
  wire: z.enum(WIRE_FORMATS),
  baseUrl: z.url(),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  cacheTtl: z.enum(['5m', '1h']).default('1h'),
});
export type CatalogModel = z.infer<typeof catalogModelSchema>;

const CLAUDE_DEFAULTS = {
  provider: 'claude',
  wire: 'anthropic-messages',
  baseUrl: 'https://api.anthropic.com',
  contextWindow: 200_000,
  cacheTtl: '1h',
} as const;

/**
 * 내장 항목이다. 설정 `models`에 같은 id를 적으면 덮어쓴다. Codex와 Grok의 id는 omp 카탈로그 문서가
 * 프로바이더 기본 모델로 적은 값이고, 창 크기와 출력 상한은 확인하지 못한 추정치이므로 실제 값으로 덮어쓴다.
 */
export const BUILTIN_MODELS: readonly CatalogModel[] = [
  { ...CLAUDE_DEFAULTS, id: 'claude-haiku-5-5', maxOutputTokens: 64_000 },
  { ...CLAUDE_DEFAULTS, id: 'claude-sonnet-5-5', maxOutputTokens: 64_000 },
  { ...CLAUDE_DEFAULTS, id: 'claude-opus-5-5', maxOutputTokens: 32_000 },
  {
    id: 'gpt-5.5',
    provider: 'codex',
    wire: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    cacheTtl: '1h',
  },
  {
    id: 'grok-4.6',
    provider: 'grok',
    wire: 'openai-responses',
    baseUrl: 'https://api.x.ai/v1',
    contextWindow: 256_000,
    maxOutputTokens: 64_000,
    cacheTtl: '1h',
  },
];

/** 같은 id의 설정 항목이 내장 항목을 덮어쓴다. */
export function createCatalog(
  entries: readonly CatalogModel[] = [],
): (id: string) => CatalogModel | undefined {
  const byId = new Map([...BUILTIN_MODELS, ...entries].map((model) => [model.id, model]));
  return (id) => byId.get(id);
}
