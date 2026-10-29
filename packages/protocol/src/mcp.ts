import { z } from 'zod';
import { envNameSchema } from './accounts.ts';
import { timestampSchema } from './common.ts';

/** 서버 이름은 모델에 보이는 도구 이름 `<서버명>:<도구명>`의 앞부분이라 `:`와 `.`을 쓰지 않는다 (SPEC 2.10절). */
export const mcpServerNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,32}$/, { error: '이름은 영문, 숫자, _, -만 쓰고 32자 이하입니다.' });

export const mcpTransportSchema = z.enum(['stdio', 'http']);
export type McpTransport = z.infer<typeof mcpTransportSchema>;

/** 설정 › MCP의 서버 한 줄이다. `unreachable`은 연결에 실패했거나 서버가 응답하지 않아 엔진이 이 서버의 도구를 끈 상태다. */
export const mcpServerStatusSchema = z.strictObject({
  name: mcpServerNameSchema,
  transport: mcpTransportSchema,
  /** stdio면 실행 명령 한 줄이고, HTTP면 주소다. */
  target: z.string(),
  envRefs: z.array(envNameSchema),
  enabled: z.boolean(),
  state: z.enum(['connecting', 'connected', 'unreachable', 'disabled']),
  /** 서버가 알려 준 도구 수다. 한 번도 연결하지 못했으면 없다. */
  toolCount: z.number().int().nonnegative().optional(),
  /** 모델이 지금 쓸 수 있는 도구 수다. `connected`가 아니면 0이다. */
  enabledToolCount: z.number().int().nonnegative(),
  lastFailure: z.strictObject({ at: timestampSchema, reason: z.string() }).optional(),
});
export type McpServerStatus = z.infer<typeof mcpServerStatusSchema>;

export const mcpServerListResponseSchema = z.strictObject({
  servers: z.array(mcpServerStatusSchema),
});
export type McpServerListResponse = z.infer<typeof mcpServerListResponseSchema>;

/** 서버 추가 폼의 본문이다. `command`는 실행 명령 한 줄이고, 호스트가 명령과 인자로 나눈다. */
export const mcpServerAddBodySchema = z
  .strictObject({
    name: mcpServerNameSchema,
    transport: mcpTransportSchema,
    command: z.string().trim().min(1).optional(),
    url: z.url({ protocol: /^https?$/ }).optional(),
    envRefs: z.array(envNameSchema).max(8).default([]),
  })
  .superRefine((body, context) => {
    if (body.transport === 'stdio' && body.command === undefined) {
      context.addIssue({ code: 'custom', path: ['command'], message: '실행 명령이 필요합니다.' });
    }
    if (body.transport === 'http') {
      if (body.url === undefined) {
        context.addIssue({ code: 'custom', path: ['url'], message: '주소가 필요합니다.' });
      }
      if (body.envRefs.length > 1) {
        context.addIssue({
          code: 'custom',
          path: ['envRefs'],
          message:
            'HTTP 서버는 환경변수 이름을 하나만 받습니다. 값은 Authorization: Bearer 헤더로 보냅니다.',
        });
      }
    }
  });
export type McpServerAddBody = z.infer<typeof mcpServerAddBodySchema>;

export const mcpServerPatchBodySchema = z.strictObject({ enabled: z.boolean() });
export type McpServerPatchBody = z.infer<typeof mcpServerPatchBodySchema>;
