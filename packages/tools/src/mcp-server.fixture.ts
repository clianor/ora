import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// mcp.test.ts가 stdio로 띄우는 테스트용 MCP 서버다.
const server = new McpServer({ name: 'fixture', version: '0.0.0' });
server.registerTool(
  'echo',
  { description: '받은 글을 그대로 돌려준다.', inputSchema: { text: z.string() } },
  ({ text }) => ({ content: [{ type: 'text' as const, text }] }),
);
server.registerTool('pid', { description: '서버 프로세스 번호를 돌려준다.' }, () => ({
  content: [{ type: 'text' as const, text: String(process.pid) }],
}));
server.registerTool('secret', { description: '환경변수 값을 돌려준다.' }, () => ({
  content: [{ type: 'text' as const, text: process.env.ORA_TEST_VALUE ?? '' }],
}));
server.registerTool('crash', { description: '응답한 뒤 프로세스를 끝낸다.' }, () => {
  setTimeout(() => process.exit(1), 20);
  return { content: [{ type: 'text' as const, text: 'bye' }] };
});
await server.connect(new StdioServerTransport());
