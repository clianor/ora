import { z } from 'zod';

/** 워크트리별 라이브 포트와 프로세스 종료의 HTTP API 본문이다 (SPEC 2.12.2절). */

export const livePortSchema = z.strictObject({
  port: z.number().int().min(1).max(65535),
  /** `127.0.0.1`, `*`, `::1`처럼 소켓이 묶인 주소다. */
  address: z.string().min(1),
  pid: z.number().int().positive(),
  /** 실행 파일 이름이다. */
  name: z.string().min(1),
  /** Ora 터미널이나 세션이 띄운 프로세스가 아니라 작업 폴더만 이 워크트리 안인 프로세스다. */
  isExternal: z.boolean(),
});
export type LivePort = z.infer<typeof livePortSchema>;

export const worktreePortsSchema = z.strictObject({
  path: z.string().min(1),
  ports: z.array(livePortSchema),
});
export type WorktreePorts = z.infer<typeof worktreePortsSchema>;

export const portsResponseSchema = z.strictObject({
  repo: z.string().min(1),
  worktrees: z.array(worktreePortsSchema),
});
export type PortsResponse = z.infer<typeof portsResponseSchema>;

export const killPortBodySchema = z.strictObject({
  /** 저장소의 아무 worktree 폴더다. */
  repo: z.string().min(1),
  /** 포트가 속한 worktree 폴더다. */
  path: z.string().min(1),
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
});
export type KillPortBody = z.infer<typeof killPortBodySchema>;

export const killPortResultSchema = z.strictObject({ ok: z.literal(true) });
export type KillPortResult = z.infer<typeof killPortResultSchema>;

/** 삭제 창이 보이는 "종료할 프로세스"다. */
export const cleanupProcessSchema = z.strictObject({
  pid: z.number().int().positive(),
  name: z.string().min(1),
  port: z.number().int().min(1).max(65535).optional(),
});
export type CleanupProcess = z.infer<typeof cleanupProcessSchema>;
