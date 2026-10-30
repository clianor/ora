import { readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import type { SkillEntry } from '@ora/core';
import type { SkillScope } from '@ora/protocol';

/** 엔진이 읽지 않는 홈 디렉터리 아래 폴더다 (SPEC 5.6절). 스킬 로더가 이 목록으로 심링크를 따라간 경로를 걸러 내고, 설정 › 격리 화면이 같은 목록을 보인다. */
export const HARNESS_DIRS = ['.agents', '.claude', '.pi', '.omp', '.codex', '.gemini'];
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_SKILL_BYTES = 262144;

/** 실제 경로가 기존 하네스 디렉터리 안이면 true다 (SPEC 5.6절). 심링크를 따라간 뒤의 경로로 판정한다. */
async function isHarnessPath(realPath: string): Promise<boolean> {
  for (const name of HARNESS_DIRS) {
    const root = await realpath(join(homedir(), name)).catch(() => join(homedir(), name));
    if (realPath === root || realPath.startsWith(root + sep)) return true;
  }
  return false;
}

function splitList(value: string): string[] {
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((item) => item.trim().replace(/^["']|["']$/g, ''))
    .filter((item) => item !== '');
}

/** `---`로 감싼 앞부분의 `키: 값` 줄만 읽는다. 앞부분이 없으면 undefined다. */
function parseSkillFile(text: string): { meta: Record<string, string>; body: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (match === null) return undefined;
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator > 0) meta[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return { meta, body: match[2] ?? '' };
}

/**
 * 스킬 디렉터리 하나를 읽는다. 폴더가 없거나 하네스 경로를 가리키거나 형식이 틀린 스킬은 건너뛴다.
 * 이름이 폴더 이름과 같아야 하고, SKILL.md의 실제 경로가 스킬 디렉터리 밖이면 읽지 않는다.
 */
async function readSkillDir(dir: string, scope: SkillScope): Promise<SkillEntry[]> {
  let root: string;
  try {
    root = await realpath(dir);
  } catch {
    return [];
  }
  if (await isHarnessPath(root)) return [];
  const names = (await readdir(root).catch(() => []))
    .filter((name) => SKILL_NAME.test(name))
    .sort();
  const skills: SkillEntry[] = [];
  for (const name of names) {
    try {
      const file = await realpath(join(root, name, 'SKILL.md'));
      if (!file.startsWith(root + sep) || (await isHarnessPath(file))) continue;
      const text = await readFile(file, 'utf8');
      if (text.length > MAX_SKILL_BYTES) continue;
      const parsed = parseSkillFile(text);
      if (parsed === undefined) continue;
      skills.push({
        name,
        description: parsed.meta.description ?? '',
        triggers: splitList(parsed.meta.triggers ?? ''),
        scope,
        body: parsed.body,
      });
    } catch {
      continue;
    }
  }
  return skills;
}

export interface SkillSources {
  /** 작업 폴더의 `.ora/skills/`다. */
  readonly projectDir: string | undefined;
  readonly globalDir: string;
}

/** 프로젝트 스킬과 전역 스킬을 모두 읽는다. 가려짐은 호출하는 쪽이 이름으로 가른다. */
export async function readAllSkills(
  sources: SkillSources,
): Promise<{ project: SkillEntry[]; global: SkillEntry[] }> {
  const [project, global] = await Promise.all([
    sources.projectDir === undefined ? [] : readSkillDir(sources.projectDir, 'project'),
    readSkillDir(sources.globalDir, 'global'),
  ]);
  return { project, global };
}

/** 이름이 같으면 프로젝트 스킬이 이긴다 (SPEC 2.10절). */
export function mergeSkills(all: { project: SkillEntry[]; global: SkillEntry[] }): SkillEntry[] {
  const projectNames = new Set(all.project.map((skill) => skill.name));
  return [...all.project, ...all.global.filter((skill) => !projectNames.has(skill.name))];
}
