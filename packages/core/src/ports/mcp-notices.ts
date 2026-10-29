import type { EventOf } from '@ora/protocol';

export type McpNotice = EventOf<'mcp_server'>['payload'];

/** MCP 연결 결과를 엔진에 넘기는 포트다. 엔진이 쌓인 알림을 꺼내 `mcp_server` 이벤트로 남긴다. */
export interface McpNoticePort {
  drain(): McpNotice[];
}
