import { z } from 'zod';
import { timestampSchema } from './common.ts';

/** 사용자가 만든 worktree의 HTTP API 본문이다 (SPEC 2.7절). 상태는 `<oraHome>/worktrees.json`에 남는다. */

/** 소문자, 숫자, 하이픈, `/`만 쓴다. `/`로 나눈 조각은 소문자나 숫자로 시작한다. */
export const worktreeNameSchema = z
  .string()
  .min(1, { error: '이름을 적습니다.' })
  .max(80, { error: '이름은 80자 이하로 적습니다.' })
  .regex(/^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/, {
    error: '소문자, 숫자, 하이픈, /만 씁니다. 각 조각은 소문자나 숫자로 시작합니다.',
  });

/** `creating`은 `git worktree add`가 도는 중, `setup`은 초기 명령이 도는 중이다. */
export const worktreeStatusSchema = z.enum(['creating', 'setup', 'ready', 'setup-failed']);
export type WorktreeStatus = z.infer<typeof worktreeStatusSchema>;

export const setupCommandStatusSchema = z.enum(['pending', 'running', 'done', 'failed', 'skipped']);
export type SetupCommandStatus = z.infer<typeof setupCommandStatusSchema>;

export const setupCommandSchema = z.strictObject({
  command: z.string().min(1),
  status: setupCommandStatusSchema,
  /** `failed`일 때 종료 코드다. 서버가 멈춰 끝까지 보지 못한 명령에는 없다. */
  exitCode: z.number().int().optional(),
});
export type SetupCommand = z.infer<typeof setupCommandSchema>;

export const worktreeRecordSchema = z.strictObject({
  id: z.string().regex(/^w-[a-z0-9]{8}$/),
  /** 저장소 폴더(realpath)다. */
  repo: z.string().min(1),
  name: z.string().min(1),
  /** `ora/<name>`이다. */
  branch: z.string().min(1),
  /** worktree 폴더(realpath)다. */
  path: z.string().min(1),
  /** 만들 때 고른 부모 브랜치다. */
  parent: z.string().min(1),
  /** 만든 시점 부모 브랜치의 HEAD 커밋 해시다. 이 worktree에서 연 세션의 `baseRef`가 된다. */
  baseRef: z.string().min(1),
  status: worktreeStatusSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  commands: z.array(setupCommandSchema),
  /** "초기 명령" 터미널이다. 서버를 다시 켜면 터미널이 사라지므로 이 ID는 낡을 수 있다. */
  terminalId: z.string().optional(),
  /** `setup-failed`일 때 이유다. */
  failure: z.string().optional(),
});
export type WorktreeRecord = z.infer<typeof worktreeRecordSchema>;

export const worktreesFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  worktrees: z.array(worktreeRecordSchema),
});
export type WorktreesFile = z.infer<typeof worktreesFileSchema>;

export const createWorktreeBodySchema = z.strictObject({
  repo: z.string().min(1),
  name: worktreeNameSchema,
  /** 없으면 저장소의 현재 브랜치다. */
  parent: z.string().min(1).optional(),
});
export type CreateWorktreeBody = z.infer<typeof createWorktreeBodySchema>;

export const worktreeListResponseSchema = z.strictObject({
  worktrees: z.array(worktreeRecordSchema),
});
export type WorktreeListResponse = z.infer<typeof worktreeListResponseSchema>;

export const worktreeResponseSchema = z.strictObject({ worktree: worktreeRecordSchema });
export type WorktreeResponse = z.infer<typeof worktreeResponseSchema>;

/** 만들기 창이 그리는 값이다. 부모 브랜치 목록과 폴더·초기 명령 미리보기다. */
export const worktreeOptionsResponseSchema = z.strictObject({
  repoName: z.string(),
  /** 로컬 브랜치다. */
  branches: z.array(z.string()),
  /** 저장소의 현재 브랜치다. detached HEAD면 없다. */
  current: z.string().optional(),
  /** 새 worktree 폴더의 윗단계(`<worktreeRoot>/<저장소 이름>`)다. */
  folder: z.string(),
  setupCommands: z.array(z.string()),
});
export type WorktreeOptionsResponse = z.infer<typeof worktreeOptionsResponseSchema>;

const MAX_SETUP_COMMANDS = 20;
const MAX_SETUP_COMMAND_CHARS = 500;

export const repoSettingSchema = z.strictObject({
  path: z.string().min(1).startsWith('/', { error: '저장소는 /로 시작하는 경로입니다.' }),
  setupCommands: z
    .array(
      z
        .string()
        .trim()
        .min(1, { error: '빈 명령은 뺍니다.' })
        .max(MAX_SETUP_COMMAND_CHARS, {
          error: `명령은 ${String(MAX_SETUP_COMMAND_CHARS)}자 이하로 적습니다.`,
        }),
    )
    .max(MAX_SETUP_COMMANDS, {
      error: `초기 명령은 ${String(MAX_SETUP_COMMANDS)}개까지 둡니다.`,
    }),
});

/** 설정 › 저장소의 저장 본문이다. 알려진 저장소만 받는다. */
export const reposSettingsSchema = z.strictObject({ repos: z.array(repoSettingSchema) });
export type ReposSettings = z.infer<typeof reposSettingsSchema>;

export const reposSettingsResponseSchema = z.strictObject({
  repos: z.array(
    z.strictObject({
      path: z.string().min(1),
      name: z.string().min(1),
      setupCommands: z.array(z.string()),
      worktreeCount: z.number().int().nonnegative(),
      /** 이 저장소의 새 worktree 폴더(`<worktreeRoot>/<저장소 이름>`)다. */
      folder: z.string().min(1),
    }),
  ),
});
export type ReposSettingsResponse = z.infer<typeof reposSettingsResponseSchema>;
