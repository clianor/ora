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

/** 같은 저장소의 PR 수가 이 값을 넘으면 오래된 PR은 목록에서 빠진다. */
const PR_LIMIT = 500;
const PR_JSON_FIELDS =
  'number,url,state,isDraft,headRefName,headRefOid,statusCheckRollup,mergedAt,closedAt,createdAt,isCrossRepository';
/** 마지막으로 읽은 뒤 이 시간이 지나야 60초 간격 조회가 GitHub 변경 여부를 묻는다. */
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
  headRefName: string;
  headRefOid: string;
  statusCheckRollup?: { status?: string; conclusion?: string; state?: string }[] | null;
  mergedAt?: string | null;
  closedAt?: string | null;
  createdAt: string;
  isCrossRepository?: boolean;
}

interface RepoCache {
  version: number;
  fetchedAt: number;
  isDirty: boolean;
  etag: string | undefined;
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

function summarizeChecks(rollup: GhPr['statusCheckRollup']): PrChecks {
  if (!rollup || rollup.length === 0) return 'none';
  let isRunning = false;
  for (const item of rollup) {
    const result =
      [item.conclusion, item.state]
        .filter((value): value is string => value !== undefined && value !== '')
        .map((value) => value.toUpperCase())
        .at(0) ?? '';
    const progress = (item.status ?? '').toUpperCase();
    if (
      ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(
        result,
      )
    ) {
      return 'fail';
    }
    if (
      (progress !== '' && progress !== 'COMPLETED') ||
      ['PENDING', 'EXPECTED'].includes(result) ||
      (result === '' && progress === '')
    ) {
      isRunning = true;
    }
  }
  return isRunning ? 'running' : 'pass';
}

function toPrInfo(pr: GhPr): PrInfo {
  const state: PrState = pr.state === 'OPEN' && pr.isDraft ? 'DRAFT' : pr.state;
  return {
    number: pr.number,
    url: pr.url,
    state,
    checks: summarizeChecks(pr.statusCheckRollup),
    headRefOid: pr.headRefOid,
    createdAt: pr.createdAt,
    ...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {}),
    ...(pr.closedAt ? { closedAt: pr.closedAt } : {}),
  };
}

/** 같은 저장소에서 같은 브랜치를 head로 한 PR 중 가장 최근에 만든 하나다. */
function pickLatest(prs: GhPr[], branch: string): GhPr | undefined {
  return prs
    .filter((pr) => pr.headRefName === branch && pr.isCrossRepository !== true)
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function explainGhFailure(result: RunResult): string {
  if (result.code === 'ENOENT') return 'gh가 설치돼 있지 않아 PR 상태를 읽지 못했습니다.';
  const text = result.stderr.trim();
  if (/gh auth login|not logged in|authentication|GH_TOKEN/i.test(text)) {
    return 'gh에 로그인하지 않아 PR 상태를 읽지 못했습니다. gh auth login으로 로그인합니다.';
  }
  return `gh가 실패해 PR 상태를 읽지 못했습니다: ${text.split('\n')[0] ?? ''}`.trim();
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
    prs: GhPr[] | undefined,
    unavailable: string | undefined,
    remote: { owner: string; name: string } | undefined,
  ): Promise<PrStatusResponse> => {
    const worktrees = await listGitWorktrees(env, repo);
    const defaultBranch = await readDefaultBranch(env, repo);
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
        const latest = pickLatest(prs, item.branch);
        if (latest !== undefined) entry.pr = toPrInfo(latest);
        else if (remote !== undefined && defaultBranch !== undefined) {
          entry.createUrl = `https://github.com/${remote.owner}/${remote.name}/compare/${defaultBranch}...${item.branch}?expand=1`;
        }
      }
      entries.push(entry);
    }
    return { repo, version, ...(unavailable ? { unavailable } : {}), worktrees: entries };
  };

  /** 열린 PR 전체를 `gh` 호출 한 번으로 읽는다. */
  const fetchStatus = async (repo: string, cache: RepoCache | undefined): Promise<RepoCache> => {
    const next: RepoCache = cache ?? {
      version: 0,
      fetchedAt: 0,
      isDirty: false,
      etag: undefined,
      status: { repo, version: 0, worktrees: [] },
      watchers: [],
    };
    const originUrl = await gitOrUndefined(env, repo, ['remote', 'get-url', 'origin']);
    const remote = originUrl === undefined ? undefined : parseGithubRemote(originUrl);
    let prs: GhPr[] | undefined;
    let unavailable: string | undefined;
    if (remote === undefined) {
      unavailable =
        originUrl === undefined
          ? '원격(origin)이 없어 PR 상태를 읽지 못했습니다.'
          : '원격이 GitHub가 아니라 PR 상태를 읽지 못했습니다.';
    } else {
      const result = await run(
        'gh',
        ['pr', 'list', '--state', 'all', '--json', PR_JSON_FIELDS, '--limit', String(PR_LIMIT)],
        repo,
        env,
      );
      if (result.code !== 0) unavailable = explainGhFailure(result);
      else {
        try {
          prs = JSON.parse(result.stdout) as GhPr[];
        } catch {
          unavailable = 'gh의 응답을 읽지 못해 PR 상태를 읽지 못했습니다.';
        }
      }
    }
    next.version += 1;
    next.fetchedAt = Date.now();
    next.isDirty = false;
    next.status = await buildStatus(repo, next.version, prs, unavailable, remote);
    if (remote !== undefined && unavailable === undefined) {
      next.etag = await probeEtag(repo, remote, undefined).then((probe) => probe.etag);
    } else next.etag = undefined;
    caches.set(repo, next);
    await watchRefs(repo, next);
    return next;
  };

  /**
   * 조건부 요청으로 PR 목록이 바뀌었는지 묻는다. 304면 GitHub 사용 한도를 쓰지 않는다.
   * `gh pr list`는 ETag를 보낼 수 없어, 변경 여부만 `gh api -i`로 묻고 바뀌었을 때 `gh pr list`를 한 번 부른다.
   */
  const probeEtag = async (
    repo: string,
    remote: { owner: string; name: string },
    etag: string | undefined,
  ): Promise<{ isChanged: boolean; etag: string | undefined }> => {
    const args = [
      'api',
      '-i',
      `repos/${remote.owner}/${remote.name}/pulls?state=all&per_page=100`,
      ...(etag === undefined ? [] : ['-H', `If-None-Match: ${etag}`]),
    ];
    const result = await run('gh', args, repo, env);
    const head = result.stdout.split('\r\n\r\n')[0] ?? result.stdout.split('\n\n')[0] ?? '';
    if (/^HTTP\/\S+ 304/.test(head)) return { isChanged: false, etag };
    const found = /^etag:\s*(.+)$/im.exec(head)?.[1]?.trim();
    return { isChanged: true, etag: found };
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
      const age = Date.now() - cache.fetchedAt;
      const limit = refresh === 'focus' ? FOCUS_MS : POLL_MS;
      if (refresh === 'read' && age < POLL_MS) return cache.status;
      if (age < limit) return cache.status;
      const originUrl = await gitOrUndefined(env, repo, ['remote', 'get-url', 'origin']);
      const remote = originUrl === undefined ? undefined : parseGithubRemote(originUrl);
      if (
        remote === undefined ||
        cache.status.unavailable !== undefined ||
        cache.etag === undefined
      ) {
        return (await fetchStatus(repo, cache)).status;
      }
      const probe = await probeEtag(repo, remote, cache.etag);
      if (!probe.isChanged) {
        cache.fetchedAt = Date.now();
        return cache.status;
      }
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
