import {
  FolderGit2,
  ArrowLeft,
  Bell,
  Box,
  Brain,
  Cpu,
  Gauge,
  Keyboard,
  KeyRound,
  Palette,
  Plug,
  Search,
  Settings as SettingsIcon,
  Shield,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { RadioGroup } from 'radix-ui';
import { useState } from 'react';
import { cn } from '../lib/cn.ts';
import type { SettingsPage } from '../lib/route.ts';
import { setThemeMode, useThemeMode, type ThemeMode } from '../lib/theme.ts';

interface NavItem {
  icon: LucideIcon;
  label: string;
  /** 이동할 수 있는 페이지입니다. 없으면 아직 만들지 않은 항목입니다. */
  page?: SettingsPage;
}

const navSections: { title: string; items: NavItem[] }[] = [
  {
    title: '앱',
    items: [
      { icon: SettingsIcon, label: '일반', page: 'general' },
      { icon: Palette, label: '모양', page: 'appearance' },
      { icon: Keyboard, label: '키보드 단축키', page: 'keys' },
      { icon: Bell, label: '알림', page: 'notifications' },
    ],
  },
  {
    title: '엔진',
    items: [
      { icon: KeyRound, label: '계정', page: 'accounts' },
      { icon: Cpu, label: '모델', page: 'models' },
      { icon: Shield, label: '권한', page: 'permissions' },
      { icon: Box, label: '격리', page: 'isolation' },
      { icon: FolderGit2, label: '저장소', page: 'repos' },
      { icon: Gauge, label: '비용 상한', page: 'cost' },
      { icon: Plug, label: 'MCP', page: 'mcp' },
      { icon: Sparkles, label: '스킬', page: 'skills' },
      { icon: Brain, label: '메모리', page: 'memory' },
    ],
  },
];

/** 설정 항목 목록입니다. `page`가 있는 항목만 이동할 수 있고, 나머지 항목은 이름만 보여 줍니다. */
export function SettingsNav({ current, cwd }: { current: SettingsPage; cwd?: string }) {
  const [query, setQuery] = useState('');
  return (
    <nav
      aria-label="설정 항목"
      className="flex w-[264px] shrink-0 flex-col gap-4 bg-sidebar px-2 pt-4 pb-3"
    >
      <div className="h-5" />
      <h2 className="px-1.5 pt-1.5 text-lg leading-[26px] font-semibold text-foreground">
        <a
          href="#/session"
          className="flex items-center gap-2 rounded-sm hover:text-foreground-muted"
        >
          <ArrowLeft aria-hidden className="size-4 text-foreground-muted" />
          설정<span className="sr-only">에서 나가기</span>
        </a>
      </h2>
      <label className="flex h-8 items-center gap-2 rounded-sm bg-surface px-2.5">
        <Search aria-hidden className="size-3.5 shrink-0 text-foreground-subtle" />
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          placeholder="검색"
          aria-label="설정 검색"
          className="min-w-0 flex-1 bg-transparent text-[13px] leading-[18px] text-foreground outline-none placeholder:text-foreground-subtle"
        />
      </label>
      {navSections.map((section) => {
        const items = section.items.filter((item) => item.label.includes(query.trim()));
        if (items.length === 0) return null;
        return (
          <div key={section.title} className="flex flex-col gap-px">
            <h3 className="flex h-7 items-center px-2.5 text-xs leading-4 font-medium text-foreground-subtle">
              {section.title}
            </h3>
            <ul className="flex flex-col gap-px">
              {items.map(({ icon: Icon, label, page }) => {
                const isCurrent = page === current;
                const rowClass = cn(
                  'flex h-8 items-center gap-2.5 rounded-sm px-2.5 text-[13px] leading-[18px]',
                  isCurrent
                    ? 'bg-surface-hover font-medium text-foreground'
                    : 'text-foreground-muted',
                  page !== undefined && !isCurrent && 'hover:bg-surface-hover',
                );
                const content = (
                  <>
                    <Icon
                      aria-hidden
                      className={cn('size-[15px]', !isCurrent && 'text-foreground-muted')}
                    />
                    {label}
                  </>
                );
                return (
                  <li key={label}>
                    {page === undefined ? (
                      <span className={rowClass}>{content}</span>
                    ) : (
                      <a
                        href={`#/settings/${page}${cwd === undefined ? '' : `?cwd=${encodeURIComponent(cwd)}`}`}
                        aria-current={isCurrent ? 'page' : undefined}
                        className={rowClass}
                      >
                        {content}
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

const modeLabels: Record<ThemeMode, string> = { system: '시스템', light: '라이트', dark: '다크' };
const modeOrder: ThemeMode[] = ['system', 'light', 'dark'];

/** 창 하나를 줄여 그린 조각입니다. 감싼 `.light`나 `.dark` 클래스가 이 조각의 토큰 값을 정합니다. */
function MiniWindow({
  theme,
  hasSidebar,
  className,
}: {
  theme: 'light' | 'dark';
  hasSidebar: boolean;
  className?: string;
}) {
  return (
    <div className={cn(theme, 'flex h-full bg-background', className)}>
      {hasSidebar && <div className="w-5 bg-sidebar" />}
      <div className="flex flex-1 flex-col gap-[5px] p-2">
        <div className="h-1 w-10 rounded-[2px] bg-foreground-subtle" />
        <div className="h-1 w-7 rounded-[2px] bg-border" />
        <div className="flex-1" />
        <div className="h-2.5 rounded-[4px] bg-surface" />
      </div>
    </div>
  );
}

function ModeOption({ mode }: { mode: ThemeMode }) {
  return (
    <RadioGroup.Item value={mode} className="group flex flex-col items-center gap-2 rounded-sm">
      <span
        className={cn(
          'flex h-[60px] w-24 overflow-hidden rounded-sm outline-1 -outline-offset-1 outline-border',
          'group-aria-checked:outline-2 group-aria-checked:outline-offset-2 group-aria-checked:outline-foreground',
        )}
      >
        {mode === 'system' ? (
          <>
            <MiniWindow theme="light" hasSidebar className="w-12 shrink-0 overflow-hidden" />
            <MiniWindow theme="dark" hasSidebar={false} className="w-12 shrink-0" />
          </>
        ) : (
          <MiniWindow theme={mode} hasSidebar className="w-full" />
        )}
      </span>
      <span className="text-xs leading-4 font-medium text-foreground-subtle group-aria-checked:font-semibold group-aria-checked:text-foreground">
        {modeLabels[mode]}
      </span>
    </RadioGroup.Item>
  );
}

/** 설정의 모양 페이지입니다. 모드를 고르면 바로 적용하고 저장합니다. */
export function AppearancePage() {
  const mode = useThemeMode();
  return (
    <div className="flex flex-1 flex-col items-center overflow-y-auto pt-[72px]">
      <div className="flex w-[640px] max-w-full flex-col gap-6">
        <h1 className="text-2xl leading-8 font-semibold text-foreground">모양</h1>
        <section className="flex flex-col gap-2.5">
          <h2 className="text-[13px] leading-[18px] font-medium text-foreground-muted">
            화면 스타일
          </h2>
          <div className="flex items-center gap-4 rounded-lg border border-border bg-surface px-4 py-3.5">
            <div className="flex flex-1 flex-col gap-0.5">
              <p id="theme-mode-label" className="text-sm leading-5 font-medium text-foreground">
                모드
              </p>
              <p className="w-[260px] text-xs leading-4 text-foreground-subtle">
                시스템은 OS 설정을 따르고, OS 설정이 바뀌면 바로 반영합니다.
              </p>
            </div>
            <RadioGroup.Root
              value={mode}
              aria-labelledby="theme-mode-label"
              orientation="horizontal"
              onValueChange={(value) => {
                setThemeMode(value as ThemeMode);
              }}
              className="flex gap-4"
            >
              {modeOrder.map((item) => (
                <ModeOption key={item} mode={item} />
              ))}
            </RadioGroup.Root>
          </div>
        </section>
      </div>
    </div>
  );
}
