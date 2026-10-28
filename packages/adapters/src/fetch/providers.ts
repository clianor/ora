import { CLAUDE_PROVIDER } from './claude-oauth.ts';
import { CODEX_PROVIDER } from './codex.ts';
import { GROK_PROVIDER } from './grok.ts';
import type { ProviderDef } from './wire.ts';

const PROVIDERS: Record<string, ProviderDef> = {
  claude: CLAUDE_PROVIDER,
  codex: CODEX_PROVIDER,
  grok: GROK_PROVIDER,
};

export function getProvider(id: string): ProviderDef | undefined {
  return PROVIDERS[id];
}
