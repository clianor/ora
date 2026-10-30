// 성능을 측정할 세션 기록을 만든다. 결과물은 커밋하지 않고, 지정한 ORA_HOME 아래에만 쓴다.
//
// 사용법: node apps/desktop/scripts/make-perf-session.ts --home <ORA_HOME> --repo <작업 폴더>
//   - s-20261030-perfbg: 이벤트 10만 줄 세션이다. 첫 화면까지 걸리는 시간을 잰다.
//   - s-20261030-perfdf: 5,000줄 diff 하나를 가진 짧은 세션이다. diff 렌더 시간을 잰다.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { oraEventSchema, sessionRecordSchema } from '@ora/protocol';
import type { OraEvent } from '@ora/protocol';

const BIG_ID = 's-20261030-perfbg';
const DIFF_ID = 's-20261030-perfdf';
const BIG_EVENT_COUNT = 100_000;
const DIFF_LINE_COUNT = 5_000;
const START_MS = Date.parse('2026-10-30T00:00:00.000+09:00');

const { values } = parseArgs({
  options: { home: { type: 'string' }, repo: { type: 'string' } },
});
if (values.home === undefined || values.repo === undefined) {
  process.stderr.write('사용법: make-perf-session.ts --home <ORA_HOME> --repo <작업 폴더>\n');
  process.exit(2);
}
const { home, repo } = values;

function timestamp(seq: number): string {
  return new Date(START_MS + seq * 10).toISOString();
}

function writeSession(sessionId: string, title: string, events: OraEvent[]): void {
  const dir = join(home, 'sessions', sessionId);
  mkdirSync(dir, { recursive: true });
  const text = events.map((event) => JSON.stringify(oraEventSchema.parse(event))).join('\n');
  writeFileSync(join(dir, 'transcript.jsonl'), `${text}\n`);
  const record = sessionRecordSchema.parse({
    schemaVersion: 1,
    id: sessionId,
    createdAt: timestamp(1),
    updatedAt: timestamp(events.length),
    title,
    actor: 'user',
    status: 'completed',
    endReason: 'passed',
    repo,
    models: [
      {
        model: 'fake/script',
        provider: 'fake',
        role: 'default',
        chainPosition: 0,
        source: 'config',
      },
    ],
    permissionMode: 'write',
    isolation: 'none',
    promptHash: 'perf',
    engineVersion: '0.0.0',
  });
  writeFileSync(join(dir, 'session.json'), `${JSON.stringify(record, null, 2)}\n`);
}

function makeEvents(sessionId: string) {
  let seq = 0;
  const events: OraEvent[] = [];
  const push = <T extends OraEvent['type']>(
    type: T,
    actor: OraEvent['actor'],
    payload: Extract<OraEvent, { type: T }>['payload'],
  ) => {
    seq += 1;
    events.push({ seq, ts: timestamp(seq), sessionId, actor, type, payload } as OraEvent);
  };
  push('session_start', 'engine', {
    configSummary: {},
    isolation: 'none',
    permissionMode: 'write',
    instructionFiles: [],
    promptHash: 'perf',
  });
  push('message', 'user', {
    role: 'user',
    content: [{ type: 'text', text: '성능 측정용 작업입니다.' }],
    instructions: ['성능 측정용 작업입니다.'],
  });
  return { events, push, count: () => seq };
}

const big = makeEvents(BIG_ID);
for (let group = 0; big.count() < BIG_EVENT_COUNT - 1; group += 1) {
  const callId = `c${group}`;
  big.push('intent', 'model', { text: `파일 ${group}을 읽는다` });
  big.push('tool_call', 'model', {
    callId,
    tool: 'file_read',
    args: { path: `src/file-${group}.ts` },
    tier: 'read',
  });
  big.push('tool_result', 'tool', {
    callId,
    status: 'ok',
    summary: `file-${group}.ts 40줄`,
    durationMs: 3,
  });
  big.push('message', 'model', {
    role: 'assistant',
    content: [{ type: 'text', text: `파일 ${group}을 읽었습니다. 다음 파일로 넘어갑니다.` }],
  });
}
big.push('session_end', 'engine', {
  status: 'completed',
  endReason: 'passed',
  summary: '성능 측정용 기록입니다.',
});
writeSession(BIG_ID, '이벤트 10만 줄 세션', big.events);

const diff = makeEvents(DIFF_ID);
const rows = Array.from({ length: DIFF_LINE_COUNT }, (_, index) =>
  index % 2 === 0
    ? [String(index + 1), '-', `const before${index} = ${index};`]
    : [String(index + 1), '+', `const after${index} = ${index};`],
);
diff.push('tool_call', 'model', {
  callId: 'edit1',
  tool: 'file_edit',
  args: { path: 'src/large.ts', diff: rows },
  tier: 'write',
});
diff.push('tool_result', 'tool', {
  callId: 'edit1',
  status: 'ok',
  summary: 'src/large.ts 수정',
  durationMs: 5,
});
diff.push('session_end', 'engine', {
  status: 'completed',
  endReason: 'passed',
  summary: '5,000줄 diff 기록입니다.',
});
writeSession(DIFF_ID, '5,000줄 diff 세션', diff.events);

process.stdout.write(`${BIG_ID} ${DIFF_ID}\n`);
