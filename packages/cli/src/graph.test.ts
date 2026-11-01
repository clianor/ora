import { execFile, execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { oraEventSchema } from '@ora/protocol';
import type { OraEvent } from '@ora/protocol';
import { expect, test } from 'vitest';

const CLI_PATH = fileURLToPath(new URL('./main.ts', import.meta.url));
const TEST_TIMEOUT_MS = 120_000;

type Block = Record<string, unknown>;

const use = (callId: string, tool: string, input: Record<string, unknown>): Block => ({
  type: 'tool_use',
  callId,
  tool,
  input: { intent: `${tool} 호출`, ...input },
});
const respond = (...content: Block[]) => ({ content });
const say = respond({ type: 'text', text: '마쳤습니다.' });

const exists = (file: string) => `node -e "process.exit(require('fs').existsSync('${file}')?0:1)"`;
const noisy = 'node -e "for(let i=0;i<100;i++)console.log(\'x\'.repeat(300));process.exit(1)"';

const node = (
  id: string,
  after: string[],
  verifyCommand: string,
  options: { agent?: string; writeScope?: string[] } = {},
) => ({
  id,
  intent: `${id}가 필요하다`,
  content: `${id} 일을 한다`,
  writeScope: options.writeScope ?? [],
  agent: options.agent ?? 'scout',
  verifyCommand,
  after,
});
const advance: object[] = [];
const closing = [
  respond(use('k1', 'stage.advance', { to: 'learn', skipReason: '작은 작업이다' })),
  respond(
    use('k3', 'memory.propose', { text: '그래프는 검증된 노드만 넘긴다.', source: 'foo.js' }),
  ),
  say,
];

interface Project {
  readonly dir: string;
  readonly home: string;
  readonly head: string;
}

function createProject(): Project {
  const root = mkdtempSync(join(tmpdir(), 'ora-graph-'));
  const dir = join(root, 'project');
  const home = join(root, 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  git('init', '--quiet');
  writeFileSync(join(dir, 'foo.js'), 'exports.add = (a, b) => a + b;\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'init');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
  return { dir: realpathSync(dir), home, head };
}

function run(project: Project, args: string[], responses: object[], config?: object) {
  const scriptPath = join(project.home, 'script.json');
  writeFileSync(scriptPath, JSON.stringify({ responses }));
  const configPath = join(project.home, 'engine.config.json');
  writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, ...config }));
  const { promise, resolve } = Promise.withResolvers<{ code: number; stdout: string }>();
  execFile(
    process.execPath,
    [CLI_PATH, ...args, '--model-script', scriptPath, '--config', configPath],
    { cwd: project.dir, env: { ...process.env, ORA_HOME: project.home } },
    (error, stdout) => {
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout });
    },
  );
  return promise;
}

function readSessions(home: string) {
  return readdirSync(join(home, 'sessions')).map((id) => {
    const dir = join(home, 'sessions', id);
    const events: OraEvent[] = readFileSync(join(dir, 'transcript.jsonl'), 'utf8')
      .split('\n')
      .flatMap((line) => {
        try {
          const parsed = oraEventSchema.safeParse(JSON.parse(line));
          return parsed.success ? [parsed.data] : [];
        } catch {
          return [];
        }
      });
    const record = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')) as {
      delegatedBy?: unknown;
    };
    return { id, events, isChild: record.delegatedBy !== undefined };
  });
}

const parentOf = (home: string) => {
  const parent = readSessions(home).find((session) => !session.isChild);
  if (parent === undefined) throw new Error('부모 세션이 없습니다.');
  return parent;
};

// (가) `ora run`으로 graph.plan의 거부 세 가지와 읽기 전용 예외, 독립 노드 둘의 동시 실행을 한 번에 확인한다.
test(
  '고리·없는 노드·쓰기 범위 겹침 그래프는 거부하고, 읽기 전용 독립 노드는 받아들여 동시에 돈다',
  async () => {
    const project = createProject();
    const verify = exists('foo.js');
    const write = (id: string, scope: string[]) =>
      node(id, [], verify, { agent: 'task', writeScope: scope });
    const result = await run(
      project,
      ['run', '그래프로 나눈다', '--permission', 'bypass-permissions'],
      [
        ...advance,
        respond(
          use('g1', 'graph.plan', {
            nodes: [node('n1', ['n2'], verify), node('n2', ['n1'], verify)],
          }),
          use('g2', 'graph.plan', { nodes: [node('n1', ['n9'], verify)] }),
          use('g3', 'graph.plan', { nodes: [write('n1', ['src']), write('n2', ['src/a'])] }),
        ),
        respond(
          use('g4', 'graph.plan', { nodes: [node('n1', [], verify), node('n2', [], verify)] }),
        ),
        say,
        say,
        ...closing,
      ],
    );
    expect(result.code, result.stdout).toBe(0);

    const { events } = parentOf(project.home);
    const results = events.flatMap((event) =>
      event.type === 'tool_result' ? [event.payload] : [],
    );
    for (const callId of ['g1', 'g2', 'g3']) {
      expect(results.find((item) => item.callId === callId)?.status).toBe('error');
    }
    expect(results.find((item) => item.callId === 'g4')?.status).toBe('ok');
    const order = events.flatMap((event) =>
      event.type === 'delegate_start' || event.type === 'delegate_end' ? [event.type] : [],
    );
    expect(order).toEqual(['delegate_start', 'delegate_start', 'delegate_end', 'delegate_end']);
  },
  TEST_TIMEOUT_MS,
);

// (가) 노드 3개 그래프 하나가 선후 순서, 엔진 검증 실패 뒤 다시 시도, 계보, 진단 상한을 지키며 끝까지 도는지 확인한다.
test(
  '앞선 노드가 끝나야 뒤 노드가 시작하고, 엔진 검증이 실패하면 다시 시도해 계보에 기준 커밋과 시도 번호를 남긴다',
  async () => {
    const project = createProject();
    const result = await run(
      project,
      ['run', '그래프로 나눈다', '--permission', 'bypass-permissions'],
      [
        ...advance,
        respond(
          use('g1', 'graph.plan', {
            nodes: [
              node('n1', [], exists('foo.js')),
              node('n2', ['n1'], exists('a.txt'), { agent: 'task', writeScope: ['a.txt'] }),
              node('n3', ['n2'], `${exists('b.txt')} || ${noisy}`, {
                agent: 'task',
                writeScope: ['b.txt'],
              }),
            ],
          }),
        ),
        say,
        respond(use('w1', 'file_write', { path: 'a.txt', content: 'a\n' })),
        say,
        // n3의 첫 시도는 파일을 쓰지 않고 검증됐다고 보고한다. 엔진 검증이 실패해야 한다.
        respond({ type: 'text', text: '검증을 통과했습니다. verified입니다.' }),
        respond(use('w2', 'file_write', { path: 'b.txt', content: 'b\n' })),
        say,
        ...closing,
      ],
    );
    expect(result.code, result.stdout).toBe(0);

    const { events } = parentOf(project.home);
    const nodes = events.flatMap((event) => (event.type === 'graph_node' ? [event.payload] : []));
    const start = (id: string) =>
      events.findIndex((event) => event.type === 'graph_node' && event.payload.nodeId === id);
    expect(start('n1')).toBeLessThan(start('n2'));
    expect(start('n2')).toBeLessThan(start('n3'));

    const lineage = events.flatMap((event) =>
      event.type === 'node_lineage' ? [event.payload] : [],
    );
    expect(lineage.filter((item) => item.nodeId === 'n3').map((item) => item.attempt)).toEqual([
      1, 2,
    ]);
    expect(lineage.filter((item) => item.nodeId === 'n3').map((item) => item.verdict)).toEqual([
      'failed',
      'passed',
    ]);
    for (const item of lineage) {
      expect(item.baseCommit).toBe(project.head);
      expect(item.childSessionId).toMatch(/^s-/);
    }
    const retried = nodes.find((item) => item.nodeId === 'n3' && item.diagnostic !== undefined);
    const diagnostic = retried?.diagnostic ?? '';
    expect(diagnostic.length).toBeGreaterThan(0);
    expect(diagnostic.split('\n').length).toBeLessThanOrEqual(20);
    expect(new TextEncoder().encode(diagnostic).length).toBeLessThanOrEqual(2000);
    const n3Statuses = events.flatMap((event) =>
      event.type === 'todo_update' && event.payload.todoId === 'n3' ? [event.payload.to] : [],
    );
    expect(n3Statuses).toEqual(['pending', 'attempted', 'failed', 'attempted', 'verified']);
    expect(events.some((event) => event.type === 'objective')).toBe(true);
    expect(events.findLast((event) => event.type === 'graph_end')?.payload).toMatchObject({
      status: 'verified',
      attempts: 4,
    });
  },
  TEST_TIMEOUT_MS,
);

// (가) 동시 세션 상한이 1이어도 부모가 슬롯을 노드에게 빌려 주므로, 독립 노드 둘과 뒤따르는 노드 하나가 대기하며 차례로 끝까지 도는지 확인한다.
test(
  '동시 상한이 1이면 노드는 자리가 날 때까지 대기했다가 차례로 시작해 그래프가 끝난다',
  async () => {
    const project = createProject();
    const verify = exists('foo.js');
    const result = await run(
      project,
      ['run', '그래프로 나눈다', '--permission', 'bypass-permissions'],
      [
        ...advance,
        respond(
          use('g1', 'graph.plan', {
            nodes: [node('n1', [], verify), node('n2', [], verify), node('n3', ['n2'], verify)],
          }),
        ),
        say,
        say,
        say,
        ...closing,
      ],
      { limits: { maxConcurrentSessions: 1 } },
    );
    expect(result.code, result.stdout).toBe(0);

    const events = parentOf(project.home).events;
    const order = events.flatMap((event) =>
      event.type === 'delegate_start' || event.type === 'delegate_end' ? [event.type] : [],
    );
    expect(order).toEqual([
      'delegate_start',
      'delegate_end',
      'delegate_start',
      'delegate_end',
      'delegate_start',
      'delegate_end',
    ]);
    expect(events.findLast((event) => event.type === 'graph_end')?.payload).toMatchObject({
      status: 'verified',
    });
  },
  TEST_TIMEOUT_MS,
);

// (가) 다시 시도 3회 뒤 failed와 뒤 노드 blocked, 사용자 메시지로 재개하면 failed·blocked만 다시 도는지 확인한다.
test(
  '다시 시도 3회 뒤 노드는 failed가 되고 뒤 노드는 blocked가 되며, 재개하면 verified 노드는 건너뛴다',
  async () => {
    const project = createProject();
    const graph = respond(
      use('g1', 'graph.plan', {
        nodes: [
          node('n0', [], exists('foo.js')),
          node('n1', ['n0'], exists('fix.txt'), { agent: 'task', writeScope: ['fix.txt'] }),
          node('n2', ['n1'], exists('foo.js')),
        ],
      }),
    );
    await run(
      project,
      ['run', '그래프로 나눈다', '--permission', 'bypass-permissions'],
      [...advance, graph, say, say, say, say, say, say],
    );
    const first = parentOf(project.home);
    const firstEvents = first.events;
    const firstEnd = firstEvents.findLast((event) => event.type === 'graph_end');
    expect(firstEnd?.payload).toMatchObject({ status: 'failed' });
    const states = firstEnd?.type === 'graph_end' ? firstEnd.payload.nodes : [];
    expect(states.map((item) => [item.id, item.state, item.attempts])).toEqual([
      ['n0', 'verified', 1],
      ['n1', 'failed', 4],
      ['n2', 'blocked', 0],
    ]);
    const childrenBefore = readSessions(project.home).filter((session) => session.isChild).length;
    expect(childrenBefore).toBe(5);

    const resumed = await run(
      project,
      ['resume', first.id, '--steer', '다시 돌려 주세요', '--permission', 'bypass-permissions'],
      [
        respond(use('w1', 'file_write', { path: 'fix.txt', content: 'ok\n' })),
        say,
        say,
        ...closing,
      ],
    );
    expect(existsSync(join(project.dir, 'fix.txt')), resumed.stdout).toBe(true);

    const after = parentOf(project.home).events;
    const reruns = after.filter((event) => event.type === 'graph_run' && event.payload.isRerun);
    expect(reruns).toHaveLength(1);
    const lineage = after.flatMap((event) =>
      event.type === 'node_lineage' ? [event.payload] : [],
    );
    expect(lineage.filter((item) => item.nodeId === 'n0')).toHaveLength(1);
    expect(readSessions(project.home).filter((session) => session.isChild)).toHaveLength(7);
    expect(after.findLast((event) => event.type === 'graph_end')?.payload).toMatchObject({
      status: 'verified',
    });
  },
  TEST_TIMEOUT_MS,
);
