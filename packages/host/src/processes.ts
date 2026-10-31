import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { basename, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CleanupProcess, LivePort } from '@ora/protocol';

/**
 * 워크트리에 속한 프로세스와 포트를 찾는다 (SPEC 2.12절, 2.12.2절). darwin 기준이다.
 *
 * - Ora 터미널의 셸은 환경변수 `ORA_TERMINAL_ID`를 물려주고, 세션 셸 도구는 `ORA_SESSION_PROC`을 물려준다.
 *   `ps -E`가 이 값을 읽으므로 부모가 launchd(1)로 바뀐 프로세스도 찾는다.
 * - macOS의 `ps -o sess`는 항상 0이고 SIP 보호 실행 파일(`sleep` 등)은 환경변수가 보이지 않는다. 그런 프로세스는
 *   셸이 살아 있을 때의 부모 사슬로 한 번 알아낸 뒤 `pid`와 시작 시각으로 기억해 둔다.
 * ponytail: 셸이 사라진 뒤에야 처음 보이는 SIP 보호 프로세스는 Ora 밖 프로세스로 센다. 조회 사이 간격이 한도다.
 */

export const TERMINAL_ENV = 'ORA_TERMINAL_ID';
export const SESSION_ENV = 'ORA_SESSION_PROC';

const KILL_GRACE_MS = 5000;
const COMMAND_TIMEOUT_MS = 5000;
const POLL_MS = 100;
const LAUNCHERS = new Set([
  'node',
  'bun',
  'deno',
  'python',
  'python3',
  'ruby',
  'sh',
  'bash',
  'zsh',
]);

interface ProcessEntry {
  pid: number;
  ppid: number;
  pgid: number;
  started: string;
  name: string;
  terminalId?: string;
  isSessionProc: boolean;
}

export interface OraShell {
  id: string;
  cwd: string;
  /** 셸이 아직 살아 있을 때의 PID다. */
  pid: number | undefined;
}

export interface ProcessRef {
  pid: number;
  started: string;
  name: string;
  /** 이 프로세스가 LISTEN 중인 포트다. */
  ports: LivePort[];
}

interface WorktreeProcesses {
  path: string;
  /** Ora 터미널과 세션 셸 도구가 띄운 프로세스다. 대기 중인 셸은 뺀다. */
  ora: ProcessRef[];
  /** 셸과 같은 프로세스 그룹에 남은 셸 내부 프로세스다. 목록에는 보이지 않고 삭제 때 `ora`와 같은 규칙으로 종료한다. */
  inner: ProcessRef[];
  /** 작업 폴더만 이 워크트리 안인 Ora 밖 프로세스다. */
  external: ProcessRef[];
}

function run(file: string, args: string[]): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  // lsof는 결과가 없으면 종료 코드 1을 돌려주므로 오류를 구분하지 않고 출력만 쓴다.
  // 외부 명령이 응답하지 않아도 호출한 쪽이 영원히 기다리지 않도록 시간을 제한하고, 초과하면 빈 출력으로 본다.
  execFile(
    file,
    args,
    { maxBuffer: 128 * 1024 * 1024, timeout: COMMAND_TIMEOUT_MS, killSignal: 'SIGKILL' },
    (_error, stdout) => {
      resolve(stdout);
    },
  );
  return promise;
}

const PS_LINE =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/;

function nameOf(command: string): string {
  const tokens = command.split(/\s+/);
  const first = basename(tokens[0] ?? '');
  if (!LAUNCHERS.has(first)) return first;
  const args = tokens.slice(1);
  const evalIndex = args.findIndex((token) =>
    ['-e', '-p', '-c', '--eval', '--print'].includes(token),
  );
  const script = args.find(
    (token, index) => !token.startsWith('-') && (evalIndex < 0 || index < evalIndex),
  );
  return script === undefined ? first : basename(script).replace(/\.(m|c)?js$/, '');
}

async function readTable(): Promise<ProcessEntry[]> {
  const text = await run('/bin/ps', ['-axwwE', '-o', 'pid=,ppid=,pgid=,lstart=,command=']);
  const entries: ProcessEntry[] = [];
  for (const line of text.split('\n')) {
    const match = PS_LINE.exec(line);
    if (match === null) continue;
    const [, pid, ppid, pgid, started, command = ''] = match;
    const terminalId = new RegExp(` ${TERMINAL_ENV}=([a-z0-9-]+)`).exec(command)?.[1];
    entries.push({
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      started: (started ?? '').replace(/\s+/g, ' '),
      name: nameOf(command),
      ...(terminalId === undefined ? {} : { terminalId }),
      isSessionProc: command.includes(` ${SESSION_ENV}=1`),
    });
  }
  return entries;
}

/** `lsof -Fpn` 출력을 PID별 작업 폴더로 바꾼다. `pids`를 주면 그 프로세스만 읽는다. */
async function readCwds(pids?: number[]): Promise<Map<number, string>> {
  const args = ['-a', '-d', 'cwd', '-Fpn', '-w'];
  if (pids !== undefined) {
    if (pids.length === 0) return new Map();
    args.push('-p', pids.join(','));
  }
  const cwds = new Map<number, string>();
  let pid = 0;
  for (const line of (await run('lsof', args)).split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n')) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

async function readListeners(): Promise<Map<number, LivePort[]>> {
  const text = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn', '-w']);
  const byPid = new Map<number, LivePort[]>();
  let pid = 0;
  let name = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('c')) name = line.slice(1);
    else if (line.startsWith('n')) {
      const match = /^(.*):(\d+)$/.exec(line.slice(1));
      if (match?.[1] === undefined || match[2] === undefined) continue;
      const list = byPid.get(pid) ?? [];
      const port = Number(match[2]);
      const address = match[1].replace(/^\[(.*)\]$/, '$1');
      if (!list.some((item) => item.port === port && item.address === address)) {
        list.push({ port, address, pid, name, isExternal: false });
      }
      byPid.set(pid, list);
    }
  }
  return byPid;
}

const isInside = (folder: string, root: string): boolean =>
  folder === root || folder.startsWith(root + sep);

/** 폴더가 속한 워크트리 중 가장 깊은 것이다. 워크트리가 다른 워크트리 안에 있어도 안쪽에 센다. */
function owningWorktree(folder: string, worktrees: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const root of worktrees) {
    if (isInside(folder, root) && (best === undefined || root.length > best.length)) best = root;
  }
  return best;
}

export interface ProcessScanner {
  /** 워크트리마다 프로세스와 포트를 찾는다. `isFull`이면 모든 프로세스의 작업 폴더를 읽고, 아니면 포트를 연 프로세스만 읽는다. */
  scan(
    worktrees: readonly string[],
    shells: readonly OraShell[],
    isFull: boolean,
  ): Promise<WorktreeProcesses[]>;
  /** SIGTERM을 보내고 5초 안에 끝나지 않으면 SIGKILL을 보낸다. 끝나지 않은 프로세스를 돌려준다. */
  terminate(
    targets: readonly Pick<ProcessRef, 'pid' | 'started' | 'name'>[],
  ): Promise<ProcessRef[]>;
}

export function createProcessScanner(): ProcessScanner {
  /** `pid|시작 시각`으로 기억한 Ora 터미널 프로세스와 그 워크트리다. */
  const remembered = new Map<string, string>();
  const keyOf = (entry: Pick<ProcessEntry, 'pid' | 'started'>) => `${entry.pid}|${entry.started}`;

  const scanOnce: ProcessScanner['scan'] = async (worktrees, shells, isFull) => {
    const [table, listeners] = await Promise.all([readTable(), readListeners()]);
    const byPid = new Map(table.map((entry) => [entry.pid, entry]));
    const children = new Map<number, ProcessEntry[]>();
    for (const entry of table) {
      const list = children.get(entry.ppid) ?? [];
      list.push(entry);
      children.set(entry.ppid, list);
    }
    const descendants = (root: number): ProcessEntry[] => {
      const found: ProcessEntry[] = [];
      const queue = [root];
      for (let pid = queue.pop(); pid !== undefined; pid = queue.pop()) {
        for (const child of children.get(pid) ?? []) {
          found.push(child);
          queue.push(child.pid);
        }
      }
      return found;
    };

    const self = new Set<number>();
    for (let pid: number | undefined = process.pid; pid !== undefined && pid > 1;) {
      self.add(pid);
      pid = byPid.get(pid)?.ppid;
    }
    // 호스트의 직계 자식은 워커와 이 조회가 띄운 도구다. 세션 셸 도구는 그 아래 손자다.
    const hostChildren = new Set((children.get(process.pid) ?? []).map((entry) => entry.pid));
    for (const pid of hostChildren) self.add(pid);

    const shellPids = new Set(
      shells.flatMap((shell) => (shell.pid === undefined ? [] : [shell.pid])),
    );
    const owned = new Map<number, string>();
    const terminalCwd = new Map(shells.map((shell) => [shell.id, shell.cwd]));
    for (const shell of shells) {
      const root = owningWorktree(shell.cwd, worktrees);
      if (root === undefined) continue;
      if (shell.pid !== undefined) {
        for (const entry of descendants(shell.pid)) owned.set(entry.pid, root);
      }
    }
    for (const entry of table) {
      const root = remembered.get(keyOf(entry));
      if (root !== undefined) owned.set(entry.pid, root);
      if (entry.terminalId !== undefined) {
        const cwd = terminalCwd.get(entry.terminalId);
        const mapped = cwd === undefined ? undefined : owningWorktree(cwd, worktrees);
        if (mapped !== undefined) owned.set(entry.pid, mapped);
      }
    }

    const wantCwd = table
      .filter((entry) => !self.has(entry.pid) && !shellPids.has(entry.pid))
      .filter((entry) => !owned.has(entry.pid))
      .map((entry) => entry.pid);
    const cwds = await readCwds(isFull ? undefined : wantCwd.filter((pid) => listeners.has(pid)));
    // 세션 셸 도구의 프로세스는 작업 폴더로 워크트리를 정한다.
    for (const entry of table) {
      if (!entry.isSessionProc || self.has(entry.pid)) continue;
      const cwd = cwds.get(entry.pid);
      const root = cwd === undefined ? undefined : owningWorktree(cwd, worktrees);
      if (root !== undefined) owned.set(entry.pid, root);
    }

    const live = new Set<string>();
    const results = new Map<string, WorktreeProcesses>(
      worktrees.map((path) => [path, { path, ora: [], inner: [], external: [] }]),
    );
    const toRef = (entry: ProcessEntry, isExternal: boolean): ProcessRef => ({
      pid: entry.pid,
      started: entry.started,
      name: entry.name,
      ports: (listeners.get(entry.pid) ?? []).map((port) => ({
        ...port,
        name: entry.name,
        isExternal,
      })),
    });
    for (const entry of table) {
      if (self.has(entry.pid) || shellPids.has(entry.pid)) continue;
      const root = owned.get(entry.pid);
      if (root !== undefined) {
        // 작업 제어가 켜진 셸은 명령과 `&` 작업을 각자의 프로세스 그룹으로 띄운다. 셸 그룹에 남은 프로세스는 셸 내부 도우미다.
        if (shellPids.has(entry.pgid) && !listeners.has(entry.pid)) {
          results.get(root)?.inner.push(toRef(entry, false));
          continue;
        }
        live.add(keyOf(entry));
        remembered.set(keyOf(entry), root);
        results.get(root)?.ora.push(toRef(entry, false));
        continue;
      }
      const cwd = cwds.get(entry.pid);
      const external = cwd === undefined ? undefined : owningWorktree(cwd, worktrees);
      if (external !== undefined) results.get(external)?.external.push(toRef(entry, true));
    }
    for (const key of remembered.keys()) if (!live.has(key)) remembered.delete(key);
    return [...results.values()];
  };

  const terminate: ProcessScanner['terminate'] = async (targets) => {
    const identity = async () => {
      const table = await readTable();
      return new Map(table.map((entry) => [entry.pid, entry.started]));
    };
    // 다른 프로그램이 같은 PID를 다시 받았을 수 있으므로 시작 시각이 같은 것만 보낸다.
    const sent = new Map<number, (typeof targets)[number]>();
    const before = await identity();
    for (const target of targets) {
      if (before.get(target.pid) !== target.started) continue;
      try {
        process.kill(target.pid, 'SIGTERM');
        sent.set(target.pid, target);
      } catch {
        // 이미 끝난 프로세스다.
      }
    }
    const pending = async (): Promise<(typeof targets)[number][]> => {
      const now = await identity();
      return [...sent.values()].filter((target) => now.get(target.pid) === target.started);
    };
    const deadline = Date.now() + KILL_GRACE_MS;
    let left = await pending();
    while (left.length > 0 && Date.now() < deadline) {
      await sleep(POLL_MS);
      left = await pending();
    }
    for (const target of left) {
      try {
        process.kill(target.pid, 'SIGKILL');
      } catch {
        // 그 사이에 끝났다.
      }
    }
    const killDeadline = Date.now() + 2000;
    while (left.length > 0 && Date.now() < killDeadline) {
      await sleep(POLL_MS);
      left = await pending();
    }
    return left.map((target) => ({ ...target, ports: [] }));
  };

  /** 같은 조회가 겹치면 하나만 실행하고 결과를 나눠 쓴다. 조회가 느려도 요청이 쌓이지 않는다. */
  const inflight = new Map<string, Promise<WorktreeProcesses[]>>();
  const scan: ProcessScanner['scan'] = (worktrees, shells, isFull) => {
    const key = `${String(isFull)}|${worktrees.join('\n')}`;
    const pending = inflight.get(key);
    if (pending !== undefined) return pending;
    const task = scanOnce(worktrees, shells, isFull).finally(() => inflight.delete(key));
    inflight.set(key, task);
    return task;
  };

  return { scan, terminate };
}

/** 저장소의 모든 worktree 폴더를 실제 경로로 돌려준다. */
export async function listWorktreePaths(folder: string): Promise<string[]> {
  const text = await run('git', ['-C', folder, 'worktree', 'list', '--porcelain']);
  const paths = text
    .split('\n')
    .flatMap((line) => (line.startsWith('worktree ') ? [line.slice(9)] : []));
  return Promise.all(paths.map((path) => realpath(path).catch(() => path)));
}

export function toCleanupProcess(ref: ProcessRef): CleanupProcess {
  const port = ref.ports[0]?.port;
  return { pid: ref.pid, name: ref.name, ...(port === undefined ? {} : { port }) };
}
