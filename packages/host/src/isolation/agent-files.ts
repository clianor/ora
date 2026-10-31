import { readdir, readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { AgentDefinition } from '@ora/core';
import type { AgentLoadError } from '@ora/protocol';
import { isHarnessPath, parseSkillFile, splitList } from './skill-files.ts';

const AGENT_FILE = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.md$/;
const MAX_AGENT_BYTES = 65536;
const DEFAULT_MAX_STEPS = 30;
const MAX_STEPS_LIMIT = 1000;

const BUILTIN_READ_ONLY = ['tier:read'];

/** 기본 제공 정의 셋이다 (SPEC 2.15.1절). 같은 이름의 프로젝트·전역 정의가 덮어쓴다. */
export const BUILTIN_AGENTS: readonly AgentDefinition[] = [
  {
    name: 'scout',
    description: '코드를 읽고 조사해 요약한다.',
    tools: BUILTIN_READ_ONLY,
    role: 'fast',
    maxSteps: DEFAULT_MAX_STEPS,
    body: '읽기 도구만 써서 조사한다. 파일을 바꾸지 않는다. 찾은 사실과 근거 경로를 짧게 보고한다.',
    scope: 'builtin',
  },
  {
    name: 'task',
    description: '일반 작업을 맡아 구현하고 검증한다.',
    tools: ['*'],
    role: 'default',
    maxSteps: DEFAULT_MAX_STEPS,
    body: '브리프의 쓰기 범위 안에서만 파일을 바꾼다. 중단 조건에 닿으면 멈추고 이유를 보고한다.',
    scope: 'builtin',
  },
  {
    name: 'reviewer',
    description: '변경을 읽고 문제를 찾아 보고한다.',
    tools: BUILTIN_READ_ONLY,
    role: 'review',
    maxSteps: DEFAULT_MAX_STEPS,
    body: '읽기 도구만 써서 변경을 검토한다. 파일을 바꾸지 않는다. 문제마다 위치와 이유를 적는다.',
    scope: 'builtin',
  },
];

export interface AgentSources {
  /** 작업 폴더의 `.ora/agents/`다. */
  readonly projectDir: string | undefined;
  readonly globalDir: string;
}

export interface AgentFiles {
  readonly project: AgentDefinition[];
  readonly global: AgentDefinition[];
  readonly errors: AgentLoadError[];
}

type ParsedAgent = { agent: AgentDefinition } | { reason: string };

function parseAgent(name: string, text: string, scope: 'project' | 'global'): ParsedAgent {
  const parsed = parseSkillFile(text);
  if (parsed === undefined) return { reason: '파일 맨 위에 ---로 감싼 frontmatter가 없습니다.' };
  const { meta } = parsed;
  if (meta.name !== undefined && meta.name !== name) {
    return { reason: `name(${meta.name})이 파일 이름(${name})과 다릅니다.` };
  }
  const description = meta.description?.trim() ?? '';
  if (description === '') return { reason: 'description이 없습니다.' };
  const tools = splitList(meta.tools ?? '');
  if (tools.length === 0)
    return { reason: 'tools가 없습니다. 도구 이름, tier:read, * 중에서 적습니다.' };
  const role = (meta.role ?? 'default').replace(/^@/, '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(role))
    return { reason: `role(${meta.role})이 올바르지 않습니다.` };
  let maxSteps = DEFAULT_MAX_STEPS;
  if (meta.maxSteps !== undefined) {
    maxSteps = Number(meta.maxSteps);
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_STEPS_LIMIT) {
      return { reason: `maxSteps(${meta.maxSteps})는 1~${MAX_STEPS_LIMIT}의 정수여야 합니다.` };
    }
  }
  return { agent: { name, description, tools, role, maxSteps, body: parsed.body, scope } };
}

/** 폴더 하나를 읽는다. 폴더가 없으면 비어 있고, 하네스 경로를 가리키거나 형식이 틀린 파일은 건너뛰고 이유를 남긴다. */
async function readAgentDir(
  dir: string,
  scope: 'project' | 'global',
): Promise<{ agents: AgentDefinition[]; errors: AgentLoadError[] }> {
  const agents: AgentDefinition[] = [];
  const errors: AgentLoadError[] = [];
  let root: string;
  try {
    root = await realpath(dir);
  } catch {
    return { agents, errors };
  }
  if (await isHarnessPath(root)) return { agents, errors };
  const files = (await readdir(root).catch(() => [])).filter((file) => file.endsWith('.md')).sort();
  for (const file of files) {
    const fail = (reason: string) => errors.push({ file, scope, reason });
    const match = AGENT_FILE.exec(file);
    if (match?.[1] === undefined) {
      fail('파일 이름은 영문자·숫자·-·_로 된 이름 뒤에 .md를 붙입니다.');
      continue;
    }
    try {
      const real = await realpath(join(root, file));
      if (!real.startsWith(root + sep) || (await isHarnessPath(real))) {
        fail('정의 폴더 밖이나 기존 하네스 폴더를 가리키는 파일입니다.');
        continue;
      }
      const text = await readFile(real, 'utf8');
      if (text.length > MAX_AGENT_BYTES) {
        fail('파일이 너무 큽니다.');
        continue;
      }
      const result = parseAgent(match[1], text, scope);
      if ('agent' in result) agents.push({ ...result.agent, path: real });
      else fail(result.reason);
    } catch (error) {
      fail(`읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { agents, errors };
}

/** 프로젝트 정의와 전역 정의를 모두 읽는다. 가려짐은 호출하는 쪽이 이름으로 가른다. */
export async function readAllAgents(sources: AgentSources): Promise<AgentFiles> {
  const [project, global] = await Promise.all([
    sources.projectDir === undefined
      ? { agents: [], errors: [] }
      : readAgentDir(sources.projectDir, 'project'),
    readAgentDir(sources.globalDir, 'global'),
  ]);
  return {
    project: project.agents,
    global: global.agents,
    errors: [...project.errors, ...global.errors],
  };
}

/** 이름이 같으면 프로젝트, 전역, 기본 제공 순으로 이긴다 (SPEC 2.15.1절). */
export function mergeAgents(files: AgentFiles): AgentDefinition[] {
  const merged = new Map<string, AgentDefinition>();
  for (const agent of [...files.global, ...files.project]) merged.set(agent.name, agent);
  for (const agent of BUILTIN_AGENTS) if (!merged.has(agent.name)) merged.set(agent.name, agent);
  return [...merged.values()];
}

/** 정의의 허용 목록과 부모가 쓸 수 있는 도구의 교집합이다. 항목은 도구 이름, `tier:<티어>`, `*`다. */
export function intersectTools(
  definition: AgentDefinition,
  parentTools: readonly { readonly name: string; readonly tier: string }[],
): string[] {
  return parentTools
    .filter((tool) =>
      definition.tools.some(
        (entry) => entry === '*' || entry === tool.name || entry === `tier:${tool.tier}`,
      ),
    )
    .map((tool) => tool.name);
}
