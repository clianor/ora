import { z } from 'zod';
import { timestampSchema } from './common.ts';

/** 터미널 탭의 HTTP API 요청·응답 본문이다 (SPEC 8.2절 워크트리 탭). 입력은 POST, 출력은 SSE로 주고받는다. */

export const terminalIdSchema = z.string().regex(/^t-[A-Za-z0-9]{8}$/);

const terminalSizeSchema = {
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
};

export const terminalStatusSchema = z.enum(['running', 'exited']);
export type TerminalStatus = z.infer<typeof terminalStatusSchema>;

export const terminalSchema = z.strictObject({
  id: terminalIdSchema,
  cwd: z.string().min(1),
  status: terminalStatusSchema,
  /** 셸이 끝난 뒤에만 있다. 신호로 끝났으면 128에 신호 번호를 더한 값이다. */
  exitCode: z.number().int().optional(),
  createdAt: timestampSchema,
  ...terminalSizeSchema,
});
export type Terminal = z.infer<typeof terminalSchema>;

export const createTerminalBodySchema = z.strictObject({
  cwd: z.string().min(1),
  ...terminalSizeSchema,
});
export type CreateTerminalBody = z.infer<typeof createTerminalBodySchema>;

export const terminalResponseSchema = z.strictObject({ terminal: terminalSchema });
export type TerminalResponse = z.infer<typeof terminalResponseSchema>;

export const terminalListResponseSchema = z.strictObject({ terminals: z.array(terminalSchema) });
export type TerminalListResponse = z.infer<typeof terminalListResponseSchema>;

/** 셸에 쓸 키 입력이다. UTF-8 문자열 그대로 보낸다. */
export const terminalInputBodySchema = z.strictObject({ data: z.string().min(1) });
export type TerminalInputBody = z.infer<typeof terminalInputBodySchema>;

export const terminalResizeBodySchema = z.strictObject(terminalSizeSchema);
export type TerminalResizeBody = z.infer<typeof terminalResizeBodySchema>;

/**
 * SSE 스트림 `GET /api/terminals/:id/output`의 이름 붙은 이벤트다.
 * `output`은 PTY 출력 바이트를 base64로 인코딩한 `{ data }`다. 바이트 단위로 보내므로 UTF-8 문자가 중간에서 잘려도 클라이언트가 이어 붙여 디코딩한다.
 * 연결하면 링 버퍼에 남은 최근 출력을 `output` 하나로 먼저 보내고, 이어서 실시간 출력을 보낸다.
 * `exit`는 셸이 끝나면 한 번 보내고, 이미 끝난 터미널에 연결하면 버퍼 뒤에 바로 보낸다.
 */
export const terminalSseEventNames = { output: 'output', exit: 'exit' } as const;

export const terminalOutputEventSchema = z.strictObject({ data: z.base64() });
export type TerminalOutputEvent = z.infer<typeof terminalOutputEventSchema>;

export const terminalExitEventSchema = z.strictObject({ exitCode: z.number().int() });
export type TerminalExitEvent = z.infer<typeof terminalExitEventSchema>;
