import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseTranscript } from '@ora/core';
import type { SkillListResponse, SkillRef, SkillSummary } from '@ora/protocol';
import { readSessionRecordOrWarn, readTranscriptText } from '@ora/store';
import { loadConfig, resolveSessionsDir, resolveSkillsDir } from './config.ts';
import { resolveOraHome } from './isolation/ora-home.ts';
import { readAllSkills } from './isolation/skill-files.ts';

export interface SkillsApiOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly configPath?: string;
}

const RECENT_LIMIT = 10;

const keyOf = (ref: SkillRef) => `${ref.scope}:${ref.name}`;

/** 설정 › 스킬의 목록과 최근 회상을 읽는 호스트 API다 (SPEC 2.10절). 읽기만 하고, 사용 횟수는 세션 기록의 `recall` 이벤트에서 센다. */
export function createSkillsApi(options: SkillsApiOptions): {
  list(cwd?: string): Promise<SkillListResponse>;
} {
  return {
    /** `cwd`가 없으면 프로젝트 스킬은 비어 있다. 호출하는 쪽이 허용한 워크트리만 넘긴다. */
    async list(cwd) {
      const oraHome = resolveOraHome(options.env);
      const config = await loadConfig(options.configPath, oraHome);
      const sessionsDir = resolveSessionsDir(config, oraHome);
      const all = await readAllSkills({
        projectDir: cwd === undefined ? undefined : join(cwd, '.ora', 'skills'),
        globalDir: resolveSkillsDir(config, oraHome),
      });

      const usage = new Map<string, { count: number; lastAt?: string }>();
      const recent: SkillListResponse['recent'] = [];
      const ids = (await readdir(sessionsDir).catch(() => [])).sort().reverse();
      for (const id of ids) {
        const text = await readTranscriptText(join(sessionsDir, id));
        if (text === undefined) continue;
        const events = parseTranscript(text).events.filter((event) => event.type === 'recall');
        for (const event of events) {
          for (const ref of event.payload.skills) {
            const entry = usage.get(keyOf(ref)) ?? { count: 0 };
            entry.count += 1;
            if (entry.lastAt === undefined || event.ts > entry.lastAt) entry.lastAt = event.ts;
            usage.set(keyOf(ref), entry);
          }
          const hasSkills = event.payload.skills.length + event.payload.candidateSkills.length > 0;
          if (hasSkills) {
            const record = await readSessionRecordOrWarn(join(sessionsDir, id));
            recent.push({
              sessionId: id,
              title: record?.title ?? id,
              at: event.ts,
              injected: event.payload.skills,
              candidates: event.payload.candidateSkills,
            });
          }
        }
      }
      recent.sort((a, b) => (a.at < b.at ? 1 : -1));

      const projectNames = new Set(all.project.map((skill) => skill.name));
      const summarize = (scope: 'project' | 'global') =>
        all[scope].map((skill): SkillSummary => {
          const used = usage.get(keyOf({ name: skill.name, scope }));
          return {
            name: skill.name,
            description: skill.description,
            scope,
            isShadowed: scope === 'global' && projectNames.has(skill.name),
            useCount: used?.count ?? 0,
            ...(used?.lastAt === undefined ? {} : { lastUsedAt: used.lastAt }),
          };
        });
      return {
        projectName: cwd === undefined ? '' : basename(cwd),
        project: summarize('project'),
        global: summarize('global'),
        recent: recent.slice(0, RECENT_LIMIT),
      };
    },
  };
}
