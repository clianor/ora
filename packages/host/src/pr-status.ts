import { execFile } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CleanupCandidate,
  CleanupListResponse,
  CleanupResult,
  PrChecks,
  PrInfo,
  PrState,
  PrStatusRefresh,
  PrStatusResponse,
  WorktreePrEntry,
} from '@ora/protocol';
import { UsageError } from './config.ts';

/**
 * 한 요청에 담는 브랜치 수다. 별칭 50개는 노드 수가 브랜치당 PR 5개까지 합쳐 250개라 GitHub 한도(500,000)와
 * 요청 한도 비용(1) 안에 들고, 명령행 인자 길이도 몇 KB에 머문다.
 */
const BRANCHES_PER_REQUEST = 50;
const PR_PER_BRANCH = 5;
const PR_FIELDS =
  'number url state isDraft headRefOid mergedAt closedAt createdAt isCrossRepository commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }';
/** 마지막으로 읽은 뒤 이 시간이 지나야 60초 간격 조회가 GitHub에 다시 묻는다. */
const POLL_MS = 55_000;
const FOCUS_MS = 5_000;
const WATCH_DEBOUNCE_MS = 300;

export interface PrStatusApiOptions {
  readonly env: NodeJS.ProcessEnv;
  /** 폴더 아래에서 도는 세션과 터미널의 수다. 삭제를 막는 조건이다. */
  readonly countBusy: (path: string) => Promise<{ sessions: number; terminals: number }>;
  /** 삭제한 worktree 폴더를 `worktrees.json`에서 지운다. */
  readonly forgetWorktrees: (paths: string[]) => Promise<void>;
}

export interface PrStatusApi {
  get(folder: string, refresh: PrStatusRefresh): Promise<PrStatusResponse>;
  listCleanup(folder: string): Promise<CleanupListResponse>;
  cleanup(folder: string, paths: string[]): Promise<CleanupResult>;
  close(): void;
}

interface GhPr {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  headRefOid: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  createdAt: string;
  isCrossRepository: boolean;
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

interface RepoCache {
  version: number;
  fetchedAt: number;
  isDirty: boolean;
  status: PrStatusResponse;
  watchers: FSWatcher[];
}

interface RunResult {
  code: number | string | undefined;
  stdout: string;
  stderr: string;
}

function run(
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  const { promise, resolve } = Promise.withResolvers<RunResult>();
  execFile(file, args, { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolve({
      code: error === null ? 0 : ((error as NodeJS.ErrnoException).code ?? 1),
      stdout,
      stderr,
    });
  });
  return promise;
}

/** git 실패는 stderr 원문을 담은 오류로 돌려준다. */
async function git(env: NodeJS.ProcessEnv, cwd: string, args: string[]): Promise<string> {
  const result = await run('git', args, cwd, env);
  if (result.code !== 0) throw new UsageError(result.stderr.trim() || `git ${args[0] ?? ''} 실패`);
  return result.stdout.trim();
}

const gitOrUndefined = (env: NodeJS.ProcessEnv, cwd: string, args: string[]) =>
  git(env, cwd, args).catch(() => undefined);

interface GitWorktree {
  path: string;
  branch?: string;
}

/** 첫 항목이 저장소 본체다. */
async function listGitWorktrees(env: NodeJS.ProcessEnv, cwd: string): Promise<GitWorktree[]> {
  const out = await git(env, cwd, ['worktree', 'list', '--porcelain']);
  const items: GitWorktree[] = [];
  for (const block of out.split('\n\n')) {
    let path: string | undefined;
    let branch: string | undefined;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice(9);
      else if (line.startsWith('branch refs/heads/')) branch = line.slice(18);
    }
    if (path !== undefined) {
      items.push({ path: await realpath(path).catch(() => path), ...(branch ? { branch } : {}) });
    }
  }
  return items;
}

async function readDefaultBranch(env: NodeJS.ProcessEnv, cwd: string): Promise<string | undefined> {
  const remote = await gitOrUndefined(env, cwd, [
    'symbolic-ref',
    '--short',
    '-q',
    'refs/remotes/origin/HEAD',
  ]);
  if (remote) return remote.replace(/^origin\//, '');
  for (const name of ['main', 'master']) {
    if (
      (await gitOrUndefined(env, cwd, ['rev-parse', '--verify', '-q', `refs/heads/${name}`])) !==
      undefined
    ) {
      return name;
    }
  }
  return undefined;
}

/** `https://github.com/o/r.git`, `git@github.com:o/r.git`, `ssh://git@github.com/o/r`를 읽는다. */
function parseGithubRemote(url: string): { owner: string; name: string } | undefined {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { owner: match[1], name: match[2] };
}

function summarizeChecks(state: string | undefined): PrChecks {
  if (state === 'SUCCESS') return 'pass';
  if (state === 'FAILURE' || state === 'ERROR') return 'fail';
  if (state === 'PENDING' || state === 'EXPECTED') return 'running';
  return 'none';
}

function toPrInfo(pr: GhPr): PrInfo {
  const state: PrState = pr.state === 'OPEN' && pr.isDraft ? 'DRAFT' : pr.state;
  return {
    number: pr.number,
    url: pr.url,
    state,
    checks: summarizeChecks(pr.commits.nodes[0]?.commit.statusCheckRollup?.state),
    headRefOid: pr.headRefOid,
    createdAt: pr.createdAt,
    ...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {}),
    ...(pr.closedAt ? { closedAt: pr.closedAt } : {}),
  };
}

/** 같은 저장소에서 온 PR 중 가장 최근에 만든 하나를 고른다. 쿼리가 만든 날짜 내림차순으로 돌려준다. */
function pickLatest(prs: GhPr[]): GhPr | undefined {
  return prs.find((pr) => !pr.isCrossRepository);
}

function explainGhFailure(result: RunResult): string {
  if (result.code === 'ENOENT') return 'gh가 설치돼 있지 않아 PR 상태를 읽지 못했습니다.';
  const text = result.stderr.trim();
  if (/gh auth login|not logged in|authentication|GH_TOKEN/i.test(text)) {
    return 'gh에 로그인하지 않아 PR 상태를 읽지 못했습니다. gh auth login으로 로그인합니다.';
  }
  return `gh가 실패해 PR 상태를 읽지 못했습니다: ${text.split('\n')[0] ?? ''}`.trim();
}

/**
 * 브랜치마다 별칭을 하나 두고, 브랜치 이름은 GraphQL 변수로 넘긴다.
 * 포크의 PR이 같은 이름의 브랜치로 먼저 나오면 같은 저장소 PR을 가리므로 `first`는 1보다 크게 둔다.
 */
function buildPrQuery(count: number): string {
  const variables = Array.from({ length: count }, (_, index) => `$b${String(index)}: String!`).join(
    ', ',
  );
  const aliases = Array.from(
    { length: count },
    (_, index) =>
      `a${String(index)}: pullRequests(headRefName: $b${String(index)}, first: ${String(PR_PER_BRANCH)}, orderBy: {field: CREATED_AT, direction: DESC}, states: [OPEN, CLOSED, MERGED]) { nodes { ${PR_FIELDS} } }`,
  ).join(' ');
  return `query($owner: String!, $name: String!, ${variables}) { repository(owner: $owner, name: $name) { ${aliases} } }`;
}

interface PrQueryResponse {
  data?: { repository?: Record<string, { nodes: GhPr[] } | undefined> | null };
}

async function fetchPrsByBranch(
  env: NodeJS.ProcessEnv,
  repo: string,
  remote: { owner: string; name: string },
  branches: string[],
): Promise<Map<string, GhPr[]>> {
  const prs = new Map<string, GhPr[]>();
  for (let start = 0; start < branches.length; start += BRANCHES_PER_REQUEST) {
    const chunk = branches.slice(start, start + BRANCHES_PER_REQUEST);
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${buildPrQuery(chunk.length)}`,
      '-f',
      `owner=${remote.owner}`,
      '-f',
      `name=${remote.name}`,
      ...chunk.flatMap((branch, index) => ['-f', `b${String(index)}=${branch}`]),
    ];
    const result = await run('gh', args, repo, env);
    if (result.code !== 0) throw new Error(explainGhFailure(result));
    let parsed: PrQueryResponse;
    try {
      parsed = JSON.parse(result.stdout) as PrQueryResponse;
    } catch {
      throw new Error('gh의 응답을 읽지 못해 PR 상태를 읽지 못했습니다.');
    }
    const repository = parsed.data?.repository;
    if (repository === undefined || repository === null) {
      throw new Error('GitHub 저장소를 찾지 못해 PR 상태를 읽지 못했습니다.');
    }
    for (const [index, branch] of chunk.entries()) {
      prs.set(branch, repository[`a${String(index)}`]?.nodes ?? []);
    }
  }
  return prs;
}

export function createPrStatusApi(options: PrStatusApiOptions): PrStatusApi {
  const { env } = options;
  const caches = new Map<string, RepoCache>();
  const inflight = new Map<string, Promise<PrStatusResponse>>();

  const watchRefs = async (repo: string, cache: RepoCache): Promise<void> => {
    if (cache.watchers.length > 0) return;
    const commonDir = await gitOrUndefined(env, repo, ['rev-parse', '--git-common-dir']);
    if (commonDir === undefined) return;
    const root = await realpath(join(repo, commonDir)).catch(() => undefined);
    if (root === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const mark = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        cache.isDirty = true;
      }, WATCH_DEBOUNCE_MS);
    };
    for (const [target, isRecursive] of [
      [join(root, 'refs', 'remotes'), true],
      [join(root, 'packed-refs'), false],
    ] as const) {
      try {
        const watcher = watch(target, { recursive: isRecursive }, mark);
        watcher.on('error', () => undefined);
        watcher.unref();
        cache.watchers.push(watcher);
      } catch {
        // 감시할 수 없는 폴더는 60초 간격 조회가 대신한다.
      }
    }
  };

  const buildStatus = async (
    repo: string,
    version: number,
    worktrees: GitWorktree[],
    defaultBranch: string | undefined,
    prs: Map<string, GhPr[]> | undefined,
    unavailable: string | undefined,
    remote: { owner: string; name: string } | undefined,
  ): Promise<PrStatusResponse> => {
    const entries: WorktreePrEntry[] = [];
    for (const [index, item] of worktrees.entries()) {
      const isDefault = item.branch !== undefined && item.branch === defaultBranch;
      const entry: WorktreePrEntry = {
        path: item.path,
        ...(item.branch ? { branch: item.branch } : {}),
        isMain: index === 0,
        isDefault,
      };
      if (isDefault) {
        const counts = await gitOrUndefined(env, item.path, [
          'rev-list',
          '--left-right',
          '--count',
          `origin/${item.branch}...HEAD`,
        ]);
        const [behind, ahead] = (counts ?? '').split(/\s+/).map(Number);
        if (behind !== undefined && ahead !== undefined && !Number.isNaN(behind + ahead)) {
          entry.sync = { behind, ahead };
        }
      } else if (item.branch !== undefined && prs !== undefined) {
        const latest = pickLatest(prs.get(item.branch) ?? []);
        if (latest !== undefined) entry.pr = toPrInfo(latest);
        else if (remote !== undefined && defaultBranch !== undefined) {
          entry.createUrl = `https://github.com/${remote.owner}/${remote.name}/compare/${defaultBranch}...${item.branch}?expand=1`;
        }
      }
      entries.push(entry);
    }
    return { repo, version, ...(unavailable ? { unavailable } : {}), worktrees: entries };
  };

  /** 로컬 워크트리 브랜치의 PR을 저장소마다 GraphQL 요청 한 번(청크 단위)으로 읽는다. */
  const fetchStatus = async (repo: string, cache: RepoCache | undefined): Promise<RepoCache> => {
    const next: RepoCache = cache ?? {
      version: 0,
      fetchedAt: 0,
      isDirty: false,
      status: { repo, version: 0, worktrees: [] },
      watchers: [],
    };
    const originUrl = await gitOrUndefined(env, repo, ['remote', 'get-url', 'origin']);
    const remote = originUrl === undefined ? undefined : parseGithubRemote(originUrl);
    const worktrees = await listGitWorktrees(env, repo);
    const defaultBranch = await readDefaultBranch(env, repo);
    let prs: Map<string, GhPr[]> | undefined;
    let unavailable: string | undefined;
    if (remote === undefined) {
      unavailable =
        originUrl === undefined
          ? '원격(origin)이 없어 PR 상태를 읽지 못했습니다.'
          : '원격이 GitHub가 아니라 PR 상태를 읽지 못했습니다.';
    } else {
      const branches = [
        ...new Set(
          worktrees
            .map((item) => item.branch)
            .filter((branch): branch is string => branch !== undefined && branch !== defaultBranch),
        ),
      ];
      try {
        prs = await fetchPrsByBranch(env, repo, remote, branches);
      } catch (error) {
        unavailable = error instanceof Error ? error.message : String(error);
      }
    }
    next.version += 1;
    next.fetchedAt = Date.now();
    next.isDirty = false;
    next.status = await buildStatus(
      repo,
      next.version,
      worktrees,
      defaultBranch,
      prs,
      unavailable,
      remote,
    );
    caches.set(repo, next);
    await watchRefs(repo, next);
    return next;
  };

  const get = async (folder: string, refresh: PrStatusRefresh): Promise<PrStatusResponse> => {
    const first = (await listGitWorktrees(env, folder))[0];
    if (first === undefined) throw new UsageError(`git 저장소가 아닙니다: ${folder}`);
    const repo = first.path;
    const pending = inflight.get(repo);
    if (pending !== undefined) return pending;
    const task = (async () => {
      const cache = caches.get(repo);
      if (cache === undefined || refresh === 'force' || cache.isDirty) {
        return (await fetchStatus(repo, cache)).status;
      }
      const limit = refresh === 'focus' ? FOCUS_MS : POLL_MS;
      if (Date.now() - cache.fetchedAt < limit) return cache.status;
      return (await fetchStatus(repo, cache)).status;
    })().finally(() => inflight.delete(repo));
    inflight.set(repo, task);
    return task;
  };

  const countCommits = async (path: string, args: string[]): Promise<number | undefined> => {
    const out = await gitOrUndefined(env, path, ['rev-list', '--count', ...args]);
    return out === undefined ? undefined : Number(out);
  };

  const judge = async (entry: WorktreePrEntry): Promise<CleanupCandidate | undefined> => {
    const pr = entry.pr;
    if (entry.isMain || entry.isDefault || pr === undefined || entry.branch === undefined) return;
    if (pr.state !== 'MERGED' && pr.state !== 'CLOSED') return;
    const group = pr.state === 'MERGED' ? 'merged' : 'closed';
    const reasons: string[] = [];
    const changes = (await gitOrUndefined(env, entry.path, ['status', '--porcelain'])) ?? '';
    const changed = changes === '' ? 0 : changes.split('\n').length;
    if (changed > 0) reasons.push(`커밋하지 않은 변경 ${String(changed)}개`);
    const busy = await options.countBusy(entry.path);
    if (busy.sessions > 0) reasons.push(`실행 중인 세션 ${String(busy.sessions)}개`);
    if (busy.terminals > 0) reasons.push(`실행 중인 터미널 ${String(busy.terminals)}개`);
    const unpushed = await countCommits(entry.path, ['HEAD', '--not', '--remotes']);
    const isOnRemote = unpushed === 0;
    if (pr.state === 'MERGED') {
      const after = await countCommits(entry.path, [`${pr.headRefOid}..HEAD`]);
      if (after === undefined) reasons.push('PR의 마지막 커밋을 이 컴퓨터에서 찾지 못함');
      else if (after > 0) reasons.push(`머지 뒤 새 커밋 ${String(after)}개`);
    } else if (unpushed === undefined || unpushed > 0) {
      reasons.push(
        `원격에 없는 커밋 ${unpushed === undefined ? '여러' : String(unpushed)}개 · 지우면 사라집니다`,
      );
    }
    const at = pr.state === 'MERGED' ? pr.mergedAt : pr.closedAt;
    return {
      path: entry.path,
      branch: entry.branch,
      group,
      number: pr.number,
      url: pr.url,
      ...(at ? { at } : {}),
      isOnRemote,
      ...(reasons.length > 0 ? { blocked: reasons.join(' · ') } : {}),
    };
  };

  const listCleanup = async (folder: string): Promise<CleanupListResponse> => {
    const status = await get(folder, 'force');
    if (status.unavailable !== undefined) {
      throw new UsageError(`PR 상태 없이는 삭제할 수 없습니다. ${status.unavailable}`);
    }
    const candidates: CleanupCandidate[] = [];
    for (const entry of status.worktrees) {
      const candidate = await judge(entry);
      if (candidate !== undefined) candidates.push(candidate);
    }
    return { repo: status.repo, candidates };
  };

  return {
    get,
    listCleanup,
    async cleanup(folder, paths) {
      const { repo, candidates } = await listCleanup(folder);
      const result: CleanupResult = { removed: [], failed: [] };
      const removedPaths: string[] = [];
      for (const requested of paths) {
        const path = await realpath(requested).catch(() => requested);
        const candidate = candidates.find((item) => item.path === path);
        if (candidate === undefined) {
          result.failed.push({ path: requested, reason: '삭제 대상이 아닙니다.' });
        } else if (candidate.blocked !== undefined) {
          result.failed.push({ path: requested, reason: candidate.blocked });
        } else {
          try {
            await git(env, repo, ['worktree', 'remove', candidate.path]);
            await git(env, repo, ['branch', '-D', candidate.branch]);
            result.removed.push(candidate.path);
            removedPaths.push(candidate.path);
          } catch (error) {
            result.failed.push({
              path: requested,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      if (removedPaths.length > 0) {
        await options.forgetWorktrees(removedPaths);
        const cache = caches.get(repo);
        if (cache !== undefined) cache.isDirty = true;
      }
      return result;
    },
    close() {
      for (const cache of caches.values()) for (const watcher of cache.watchers) watcher.close();
      caches.clear();
    },
  };
}
