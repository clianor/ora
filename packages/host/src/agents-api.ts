import { execFile } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import type { AgentDefinition } from '@ora/core';
import type { AgentListResponse, AgentSummary } from '@ora/protocol';
import { BUILTIN_AGENTS, intersectTools, readAllAgents } from './isolation/agent-files.ts';
import { resolveOraHome } from './isolation/ora-home.ts';
import { createBuiltinTools, createCommandRunner } from '@ora/tools';
import type { ToolTier } from '@ora/protocol';

/** 기본 제공 도구의 이름과 티어 표다. 도구를 실행하지 않고 읽기만 한다. */
const TOOL_TIERS = createBuiltinTools({
  runner: createCommandRunner(),
  shellTimeoutMs: 1,
  maxOutputBytes: 1,
  maxFileBytes: 1,
  protectedPaths: [],
  secretPaths: [],
  sessionDir: '',
}).map((tool) => ({ name: tool.name, tier: tool.tier }));

const TIER_ORDER: readonly ToolTier[] = ['read', 'write', 'exec'];

function tiersOf(agent: AgentDefinition): ToolTier[] {
  const names = new Set(intersectTools(agent, TOOL_TIERS));
  const present = new Set(
    TOOL_TIERS.filter((tool) => names.has(tool.name)).map((tool) => tool.tier),
  );
  return TIER_ORDER.filter((tier) => present.has(tier));
}

export interface AgentsApiOptions {
  readonly env: NodeJS.ProcessEnv;
}

/** 설정 › 에이전트의 정의 목록을 읽고 정의 파일과 폴더를 운영체제로 여는 호스트 API다 (SPEC 2.15.1절). */
export function createAgentsApi(options: AgentsApiOptions): {
  list(cwd?: string): Promise<AgentListResponse>;
  /** 정의 폴더 안의 파일이나 폴더만 연다. 심볼릭 링크를 풀어 본 실제 경로가 두 폴더 밖이면 이유를 돌려주고 열지 않는다. */
  openPath(path: string, cwd?: string): Promise<{ readonly refused?: string }>;
} {
  const oraHome = resolveOraHome(options.env);
  const globalDir = join(oraHome, 'agents');
  return {
    /** `cwd`가 없으면 프로젝트 정의는 비어 있다. 호출하는 쪽이 허용한 워크트리만 넘긴다. */
    async list(cwd) {
      const projectDir = cwd === undefined ? undefined : join(cwd, '.ora', 'agents');
      const files = await readAllAgents({ projectDir, globalDir });
      const projectNames = new Set(files.project.map((agent) => agent.name));
      const overriding = new Set([
        ...files.project.map((agent) => agent.name),
        ...files.global.map((agent) => agent.name),
      ]);
      const builtinNames = new Set(BUILTIN_AGENTS.map((agent) => agent.name));
      const isShadowed = (agent: AgentDefinition): boolean => {
        if (agent.scope === 'builtin') return overriding.has(agent.name);
        return agent.scope === 'global' && projectNames.has(agent.name);
      };
      const summarize = (agent: AgentDefinition): AgentSummary => ({
        name: agent.name,
        description: agent.description,
        scope: agent.scope,
        role: agent.role,
        tools: [...agent.tools],
        tiers: tiersOf(agent),
        maxSteps: agent.maxSteps,
        overridesBuiltin: agent.scope !== 'builtin' && builtinNames.has(agent.name),
        isShadowed: isShadowed(agent),
        ...(agent.path === undefined ? {} : { path: agent.path }),
      });
      return {
        projectName: cwd === undefined ? '' : basename(cwd),
        ...(projectDir === undefined ? {} : { projectDir }),
        globalDir,
        project: files.project.map(summarize),
        global: files.global.map(summarize),
        builtin: BUILTIN_AGENTS.map(summarize),
        errors: files.errors,
      };
    },
    async openPath(path, cwd) {
      // 전역 폴더는 정의가 하나도 없으면 아직 없으므로, 열기 전에 만든다.
      await mkdir(globalDir, { recursive: true });
      const roots = [globalDir, ...(cwd === undefined ? [] : [join(cwd, '.ora', 'agents')])];
      const target = await realpath(path).catch(() => undefined);
      if (target === undefined) return { refused: '경로가 없습니다.' };
      for (const root of roots) {
        const real = await realpath(root).catch(() => undefined);
        if (real !== undefined && (target === real || target.startsWith(real + sep))) {
          const command =
            options.env.ORA_OPEN_COMMAND ?? (process.platform === 'darwin' ? 'open' : 'xdg-open');
          const { promise, resolve } = Promise.withResolvers<{ readonly refused?: string }>();
          execFile(command, [target], (error) => {
            resolve(error === null ? {} : { refused: `열지 못했습니다: ${error.message}` });
          });
          return promise;
        }
      }
      return { refused: '에이전트 정의 파일과 폴더만 열 수 있습니다.' };
    },
  };
}
