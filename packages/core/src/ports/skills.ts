import type { SkillScope } from '@ora/protocol';

export interface SkillEntry {
  readonly name: string;
  readonly description: string;
  readonly triggers: readonly string[];
  readonly scope: SkillScope;
  readonly body: string;
}

/** 이름이 같으면 프로젝트 스킬만 돌려준다 (SPEC 2.10절). 읽을 수 없는 스킬은 건너뛴다. */
export interface SkillPort {
  list(): Promise<readonly SkillEntry[]>;
}
