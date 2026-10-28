import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

interface TokenLeaf {
  $type: string;
  $value: string | number | number[] | { value: number; unit: string };
}

type TokenFile = Record<string, Record<string, TokenLeaf>>;

const tokenDir = new URL('../../design/tokens/Ora/', import.meta.url);
const virtualId = 'virtual:ora-tokens.css';
const resolvedId = `\0${virtualId}`;

function readTokens(mode: 'Light' | 'Dark'): { file: string; tokens: TokenFile } {
  const file = fileURLToPath(new URL(`${mode}.tokens.json`, tokenDir));
  return { file, tokens: JSON.parse(readFileSync(file, 'utf8')) as TokenFile };
}

function formatValue(leaf: TokenLeaf): string {
  const value = leaf.$value;
  if (Array.isArray(value)) return `cubic-bezier(${value.join(', ')})`;
  if (typeof value === 'object') return `${value.value}${value.unit}`;
  if (typeof value === 'number') return `${value}px`;
  return value;
}

function formatBlock(selector: string, vars: [string, string][], scheme?: string): string {
  const lines = vars.map(([name, value]) => `  --${name}: ${value};`);
  if (scheme) lines.unshift(`  color-scheme: ${scheme};`);
  return `${selector} {\n${lines.join('\n')}\n}\n`;
}

function listGroup(tokens: TokenFile, group: string, prefix: string): [string, string][] {
  return Object.entries(tokens[group] ?? {}).map(([name, leaf]) => [
    `${prefix}${name}`,
    formatValue(leaf),
  ]);
}

/** 토큰 JSON 두 파일에서 테마 CSS 변수를 만드는 플러그인입니다. 토큰 파일이 색, 반경, 간격, 모션의 유일한 정본입니다. */
function oraTokens(): Plugin {
  return {
    name: 'ora-tokens',
    resolveId(id) {
      return id === virtualId ? resolvedId : undefined;
    },
    load(id) {
      if (id !== resolvedId) return undefined;
      const light = readTokens('Light');
      const dark = readTokens('Dark');
      this.addWatchFile(light.file);
      this.addWatchFile(dark.file);
      const shared = [
        ...listGroup(light.tokens, 'radius', 'r-'),
        ...listGroup(light.tokens, 'space', 's-'),
        ...listGroup(light.tokens, 'motion', ''),
      ];
      return [
        formatBlock(':root, .light', [...listGroup(light.tokens, 'color', ''), ...shared], 'light'),
        formatBlock('.dark', listGroup(dark.tokens, 'color', ''), 'dark'),
      ].join('\n');
    },
  };
}

export default defineConfig({
  plugins: [oraTokens(), react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
});
