import { Sparkles } from 'lucide-react';
import { useEffect } from 'react';
import type { RecentRecall, SkillRef, SkillSummary } from '@ora/protocol';
import { cn } from '../lib/cn.ts';
import { formatElapsed, useNow } from '../lib/now.ts';
import { useStore } from '../store.tsx';
import { Button } from '../ui/button.tsx';
import { PageShell } from './SettingsPages.tsx';

function Group({
  title,
  path,
  children,
}: {
  title: string;
  path?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] leading-[18px] font-medium text-foreground-muted">{title}</h2>
        {path !== undefined && (
          <span className="font-mono text-xs leading-4 text-foreground-subtle">{path}</span>
        )}
      </div>
      {children}
    </section>
  );
}

const cardClass = 'flex flex-col divide-y divide-border rounded-lg border border-border bg-surface';

function describeUse(skill: SkillSummary, now: number): string {
  if (skill.useCount > 0) {
    const elapsed =
      skill.lastUsedAt === undefined ? '' : ` · ${formatElapsed(skill.lastUsedAt, now)}`;
    return `${String(skill.useCount)}회${elapsed}`;
  }
  return skill.isShadowed ? '—' : '없음';
}

function SkillRow({ skill, now }: { skill: SkillSummary; now: number }) {
  const used = describeUse(skill, now);
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <div className="flex items-center gap-2">
          <Sparkles
            aria-hidden
            className={cn(
              'size-3.5 shrink-0',
              skill.isShadowed ? 'text-foreground-subtle' : 'text-foreground-muted',
            )}
          />
          <span
            className={cn(
              'font-mono text-sm leading-5 font-semibold',
              skill.isShadowed ? 'text-foreground-subtle' : 'text-foreground',
            )}
          >
            {skill.name}
          </span>
          {skill.isShadowed && (
            <span className="rounded-sm bg-surface-hover px-1.5 text-[11px] leading-[18px] text-foreground-muted">
              프로젝트 스킬이 가림
            </span>
          )}
        </div>
        <p
          className={cn(
            'text-xs leading-[18px]',
            skill.isShadowed ? 'text-foreground-subtle' : 'text-foreground-muted',
          )}
        >
          {skill.description}
        </p>
      </div>
      <div className="flex w-[130px] shrink-0 flex-col gap-0.5">
        <span className="text-xs leading-4 text-foreground-subtle">사용</span>
        <span className="text-xs leading-4 font-medium text-foreground-muted">{used}</span>
      </div>
    </li>
  );
}

function ProjectSkills({
  cwd,
  skills,
  now,
}: {
  cwd: string | undefined;
  skills: readonly SkillSummary[];
  now: number;
}) {
  if (cwd === undefined) {
    return (
      <p className="text-[13px] leading-5 text-foreground-muted">워크트리를 고르면 보입니다.</p>
    );
  }
  if (skills.length === 0) {
    return (
      <p className="text-[13px] leading-5 text-foreground-muted">이 프로젝트에 스킬이 없습니다.</p>
    );
  }
  return (
    <ul className={cardClass}>
      {skills.map((skill) => (
        <SkillRow key={skill.name} skill={skill} now={now} />
      ))}
    </ul>
  );
}

function describeRecall(recall: RecentRecall): string {
  const names = (refs: readonly SkillRef[]) => refs.map((ref) => ref.name).join(', ');
  const parts = [
    ...(recall.injected.length > 0 ? [names(recall.injected)] : []),
    ...(recall.candidates.length > 0 ? [`${names(recall.candidates)} 후보 · 본문 넣지 않음`] : []),
  ];
  return parts.join(' · ');
}

/** 설정의 스킬 페이지입니다. 목록은 읽기만 하고, 스킬 파일은 폴더에서 직접 고칩니다. */
export function SkillsPage({ cwd }: { cwd: string | undefined }) {
  const { skills, actions } = useStore();
  const now = useNow();

  /** 프로젝트 스킬은 고른 워크트리의 폴더에 있어서, 페이지를 열 때와 워크트리가 바뀔 때 서버에서 다시 읽어야 합니다. */
  useEffect(() => {
    actions.refreshSkills(cwd).catch(() => undefined);
  }, [actions, cwd]);

  const list = skills.list;
  return (
    <PageShell
      title="스킬"
      description="모델이 읽는 절차 문서입니다. 작업을 시작할 때 목록만 읽고, 관련 있는 스킬의 본문만 넣습니다. 이름이 같으면 프로젝트 스킬을 씁니다."
    >
      {skills.status === 'error' && (
        <p role="alert" className="text-xs leading-4 text-danger">
          {skills.errorMessage}{' '}
          <Button
            variant="ghost"
            onClick={() => {
              actions.refreshSkills(cwd).catch(() => undefined);
            }}
          >
            다시 시도
          </Button>
        </p>
      )}
      {skills.status === 'loading' && (
        <p className="text-[13px] leading-5 text-foreground-muted">불러오는 중입니다.</p>
      )}
      {list !== undefined && (
        <>
          <Group
            title={cwd === undefined ? '프로젝트' : `프로젝트 · ${list.projectName}`}
            path=".ora/skills/"
          >
            <ProjectSkills cwd={cwd} skills={list.project} now={now} />
          </Group>
          <Group title="전역" path="<Ora 홈>/skills/">
            {list.global.length === 0 ? (
              <p className="text-[13px] leading-5 text-foreground-muted">전역 스킬이 없습니다.</p>
            ) : (
              <ul className={cardClass}>
                {list.global.map((skill) => (
                  <SkillRow key={skill.name} skill={skill} now={now} />
                ))}
              </ul>
            )}
          </Group>
          <Group title="최근 회상">
            {list.recent.length === 0 ? (
              <p className="text-[13px] leading-5 text-foreground-muted">
                아직 스킬을 회상한 세션이 없습니다.
              </p>
            ) : (
              <ul className={cardClass}>
                {list.recent.map((recall) => (
                  <li
                    key={`${recall.sessionId}-${recall.at}`}
                    className="flex h-10 items-center gap-2.5 px-4"
                  >
                    <span
                      title={recall.title}
                      className="max-w-[200px] shrink truncate text-[13px] leading-[18px] font-medium text-foreground"
                    >
                      {recall.title}
                    </span>
                    <span className="shrink-0 text-xs leading-4 text-foreground-subtle">·</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs leading-4 text-foreground-muted">
                      {describeRecall(recall)}
                    </span>
                    <span className="shrink-0 text-xs leading-4 text-foreground-subtle">
                      {formatElapsed(recall.at, now)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Group>
        </>
      )}
    </PageShell>
  );
}
