import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { withFileLock, writeFileAtomic } from '@ora/adapters';
import { BOARD_CHILD_LANES, boardFileSchema } from '@ora/protocol';
import type {
  BoardCard,
  BoardCardStatus,
  BoardCardView,
  BoardFile,
  BoardResponse,
  BoardWorktree,
  CreateBoardCardBody,
  SessionStatus,
  StartBoardCardResponse,
  UpdateBoardCardBody,
} from '@ora/protocol';
import { resolveOraHome } from './isolation/ora-home.ts';

/** 규칙을 어긴 요청이다. `code`로 테스트와 화면이 규칙을 가르고, `message`는 사용자에게 보이는 이유다. */
export class BoardError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const REASONS = {
  parentRequired: '검증·검토 카드에는 상위 카드가 있어야 합니다.',
  parentNotBuilder: '상위 카드는 builder 카드여야 합니다.',
  parentNotAllowed: '상위 카드는 검증·검토 카드에만 둘 수 있습니다.',
  parentMissing: '상위 카드를 찾을 수 없습니다.',
  locked: '세션을 시작한 카드는 담당과 상위 카드를 바꿀 수 없습니다.',
  deleteRunning: '세션이 실행 중인 카드는 삭제할 수 없습니다.',
  parentRunning: '상위 카드의 세션이 실행 중이라 시작할 수 없습니다.',
  alreadyRunning: '이 카드의 세션이 이미 실행 중입니다.',
  noDefinition: '담당 이름과 같은 에이전트 정의가 없어 시작할 수 없습니다.',
  noVerifyCommand: '검증 카드에는 검증 명령이 필요합니다.',
  cardMissing: '카드를 찾을 수 없습니다.',
} as const;

interface BoardSessionInfo {
  readonly status: SessionStatus;
  readonly repo?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BoardApiDeps {
  readonly env: NodeJS.ProcessEnv;
  /** 폴더가 속한 저장소의 메인 워크트리 실제 경로다. 알려진 워크트리인지는 호출하는 쪽이 이미 확인했다. */
  readonly resolveRepo: (cwd: string) => Promise<string>;
  /** 알려진 워크트리가 아니면 던진다. */
  readonly assertKnownWorktree: (cwd: string) => Promise<void>;
  readonly listWorktrees: (repo: string) => Promise<{ path: string; branch?: string }[]>;
  readonly readSession: (id: string) => Promise<BoardSessionInfo | undefined>;
  readonly listSessions: () => Promise<readonly BoardSessionInfo[]>;
  /** 이 폴더에서 쓸 수 있는 에이전트 정의 이름이다. */
  readonly listAgentNames: (cwd: string) => Promise<string[]>;
  readonly startSession: (request: {
    task: string;
    cwd: string;
    agent: string;
    verifyCommand?: string;
  }) => Promise<string>;
}

const ACTIVE: readonly SessionStatus[] = ['created', 'running'];
const WAITING: readonly SessionStatus[] = ['awaiting_approval', 'awaiting_user'];

function toCardStatus(info: BoardSessionInfo | undefined): BoardCardStatus {
  if (info === undefined) return 'not_started';
  if (ACTIVE.includes(info.status)) return 'running';
  if (WAITING.includes(info.status)) return 'awaiting_approval';
  if (info.status === 'completed' || info.status === 'merged' || info.status === 'archived') {
    return 'done';
  }
  return 'failed';
}

/** 저장소 키다. 폴더 이름만으로는 이름이 같은 두 저장소가 한 파일을 쓰므로 경로 해시를 붙인다. */
function createBoardKey(repo: string): string {
  const name = basename(repo).replace(/[^A-Za-z0-9._-]/g, '_') || 'repo';
  return `${name}-${createHash('sha256').update(repo).digest('hex').slice(0, 8)}`;
}

const isChildLane = (lane: string) => (BOARD_CHILD_LANES as readonly string[]).includes(lane);

export interface BoardApi {
  read(cwd: string): Promise<BoardResponse>;
  createCard(cwd: string, body: Omit<CreateBoardCardBody, 'repo'>): Promise<BoardCardView>;
  updateCard(
    cwd: string,
    id: string,
    body: Omit<UpdateBoardCardBody, 'repo'>,
  ): Promise<BoardCardView>;
  deleteCard(cwd: string, id: string): Promise<void>;
  startCard(cwd: string, id: string, worktree: string): Promise<StartBoardCardResponse>;
  listWorktrees(cwd: string): Promise<BoardWorktree[]>;
}

export function createBoardApi(deps: BoardApiDeps): BoardApi {
  const boardsDir = join(resolveOraHome(deps.env), 'boards');

  /** 읽고, 고치고, 쓰는 한 번이 파일 락 안에서 직렬로 돈다. */
  const mutate = async <T>(repo: string, change: (file: BoardFile) => T): Promise<T> => {
    await mkdir(boardsDir, { recursive: true, mode: 0o700 });
    const path = join(boardsDir, `${createBoardKey(repo)}.json`);
    return withFileLock(`${path}.lock`, async () => {
      const file = await readBoard(path);
      const result = change(file);
      await writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`);
      return result;
    });
  };
  const readBoard = async (path: string): Promise<BoardFile> => {
    const text = await readFile(path, 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    return text === undefined
      ? { schemaVersion: 1, cards: [] }
      : boardFileSchema.parse(JSON.parse(text));
  };
  const load = async (repo: string): Promise<BoardFile> =>
    readBoard(join(boardsDir, `${createBoardKey(repo)}.json`));

  const statusOf = async (card: BoardCard) => {
    const lastId = card.sessionIds[card.sessionIds.length - 1];
    const info = lastId === undefined ? undefined : await deps.readSession(lastId);
    return { info, status: toCardStatus(info) };
  };

  const buildView = async (
    card: BoardCard,
    cards: readonly BoardCard[],
    definitions: readonly string[],
    names: ReadonlyMap<string, string>,
  ): Promise<BoardCardView> => {
    const { info, status } = await statusOf(card);
    const parent =
      card.parentId === undefined ? undefined : cards.find((c) => c.id === card.parentId);
    let startBlockedReason: string | undefined;
    if (!definitions.includes(card.lane)) startBlockedReason = REASONS.noDefinition;
    else if (card.lane === 'verifier' && parent !== undefined) {
      const parentStatus = (await statusOf(parent)).status;
      if (parentStatus === 'running' || parentStatus === 'awaiting_approval') {
        startBlockedReason = REASONS.parentRunning;
      }
    }
    return {
      ...card,
      status,
      parentDeleted: card.parentId !== undefined && parent === undefined,
      isLocked: card.sessionIds.length > 0,
      ...(info?.repo === undefined ? {} : { lastWorktree: info.repo }),
      ...(info?.repo === undefined
        ? {}
        : { lastWorktreeName: names.get(info.repo) ?? basename(info.repo) }),
      ...(info === undefined
        ? {}
        : { lastStartedAt: info.createdAt, lastUpdatedAt: info.updatedAt }),
      ...(parent === undefined ? {} : { parentTitle: parent.title }),
      ...(startBlockedReason === undefined ? {} : { startBlockedReason }),
    };
  };

  const worktreeNames = async (repo: string): Promise<Map<string, string>> =>
    new Map(
      (await deps.listWorktrees(repo)).map((item) => [
        item.path,
        item.branch ?? basename(item.path),
      ]),
    );

  const viewOf = async (repo: string, id: string): Promise<BoardCardView> => {
    const { cards } = await load(repo);
    const card = cards.find((c) => c.id === id);
    if (card === undefined) throw new BoardError(404, 'card_missing', REASONS.cardMissing);
    return buildView(card, cards, await deps.listAgentNames(repo), await worktreeNames(repo));
  };

  const checkParent = (lane: string, parentId: string | undefined, cards: readonly BoardCard[]) => {
    if (!isChildLane(lane)) {
      if (parentId !== undefined)
        throw new BoardError(400, 'parent_not_allowed', REASONS.parentNotAllowed);
      return;
    }
    if (parentId === undefined)
      throw new BoardError(400, 'parent_required', REASONS.parentRequired);
    const parent = cards.find((c) => c.id === parentId);
    if (parent === undefined) throw new BoardError(400, 'parent_missing', REASONS.parentMissing);
    if (parent.lane !== 'builder')
      throw new BoardError(400, 'parent_not_builder', REASONS.parentNotBuilder);
  };

  const resolve = async (cwd: string) => {
    await deps.assertKnownWorktree(cwd);
    return deps.resolveRepo(cwd);
  };

  return {
    async read(cwd) {
      const repo = await resolve(cwd);
      const { cards } = await load(repo);
      const [definitions, names] = await Promise.all([
        deps.listAgentNames(repo),
        worktreeNames(repo),
      ]);
      return {
        repo,
        repoName: basename(repo),
        cards: await Promise.all(cards.map((card) => buildView(card, cards, definitions, names))),
      };
    },
    async createCard(cwd, body) {
      const repo = await resolve(cwd);
      const card: BoardCard = {
        id: `c-${randomBytes(5).toString('hex')}`,
        title: body.title,
        description: body.description,
        lane: body.lane,
        writeScope: body.lane === 'verifier' ? [] : body.writeScope,
        ...(body.verifyCommand === undefined ? {} : { verifyCommand: body.verifyCommand }),
        ...(body.parentId === undefined ? {} : { parentId: body.parentId }),
        sessionIds: [],
        createdAt: new Date().toISOString(),
      };
      await mutate(repo, (file) => {
        checkParent(card.lane, card.parentId, file.cards);
        file.cards.push(card);
      });
      return viewOf(repo, card.id);
    },
    async updateCard(cwd, id, body) {
      const repo = await resolve(cwd);
      await mutate(repo, (file) => {
        const index = file.cards.findIndex((c) => c.id === id);
        const current = file.cards[index];
        if (current === undefined) throw new BoardError(404, 'card_missing', REASONS.cardMissing);
        const lane = body.lane ?? current.lane;
        const parentId =
          body.parentId === undefined ? current.parentId : (body.parentId ?? undefined);
        if (
          current.sessionIds.length > 0 &&
          (lane !== current.lane || parentId !== current.parentId)
        ) {
          throw new BoardError(409, 'locked', REASONS.locked);
        }
        checkParent(lane, parentId, file.cards);
        const verifyCommand =
          body.verifyCommand === undefined
            ? current.verifyCommand
            : (body.verifyCommand ?? undefined);
        const next: BoardCard = {
          id: current.id,
          title: body.title ?? current.title,
          description: body.description ?? current.description,
          lane,
          writeScope: lane === 'verifier' ? [] : (body.writeScope ?? current.writeScope),
          ...(verifyCommand === undefined ? {} : { verifyCommand }),
          ...(parentId === undefined ? {} : { parentId }),
          sessionIds: current.sessionIds,
          createdAt: current.createdAt,
        };
        file.cards[index] = next;
      });
      return viewOf(repo, id);
    },
    async deleteCard(cwd, id) {
      const repo = await resolve(cwd);
      const { cards } = await load(repo);
      const card = cards.find((c) => c.id === id);
      if (card === undefined) throw new BoardError(404, 'card_missing', REASONS.cardMissing);
      const { status } = await statusOf(card);
      if (status === 'running' || status === 'awaiting_approval') {
        throw new BoardError(409, 'running', REASONS.deleteRunning);
      }
      await mutate(repo, (file) => {
        file.cards = file.cards.filter((c) => c.id !== id);
      });
    },
    async startCard(cwd, id, worktree) {
      const repo = await resolve(cwd);
      await deps.assertKnownWorktree(worktree);
      const { cards } = await load(repo);
      const card = cards.find((c) => c.id === id);
      if (card === undefined) throw new BoardError(404, 'card_missing', REASONS.cardMissing);
      if (!(await deps.listAgentNames(worktree)).includes(card.lane)) {
        throw new BoardError(409, 'no_definition', REASONS.noDefinition);
      }
      const own = (await statusOf(card)).status;
      if (own === 'running' || own === 'awaiting_approval') {
        throw new BoardError(409, 'already_running', REASONS.alreadyRunning);
      }
      const parent =
        card.parentId === undefined ? undefined : cards.find((c) => c.id === card.parentId);
      if (card.lane === 'verifier' && parent !== undefined) {
        const parentStatus = (await statusOf(parent)).status;
        if (parentStatus === 'running' || parentStatus === 'awaiting_approval') {
          throw new BoardError(409, 'parent_running', REASONS.parentRunning);
        }
      }
      const verifyCommand = card.verifyCommand ?? parent?.verifyCommand;
      if (card.lane === 'verifier' && verifyCommand === undefined) {
        throw new BoardError(409, 'no_verify_command', REASONS.noVerifyCommand);
      }
      const sessionId = await deps.startSession({
        task: [
          `# ${card.title}`,
          card.description,
          `쓰기 범위: ${card.writeScope.length === 0 ? '없음(파일을 바꾸지 않는다)' : card.writeScope.join(', ')}`,
          `검증 명령: ${verifyCommand ?? '없음'}`,
          ...(parent === undefined ? [] : [`상위 카드: ${parent.title}`]),
        ].join('\n'),
        cwd: worktree,
        agent: card.lane,
        ...(card.lane === 'verifier' && verifyCommand !== undefined ? { verifyCommand } : {}),
      });
      await mutate(repo, (file) => {
        file.cards.find((c) => c.id === id)?.sessionIds.push(sessionId);
      });
      return { sessionId, card: await viewOf(repo, id) };
    },
    async listWorktrees(cwd) {
      const repo = await resolve(cwd);
      const [worktrees, sessions] = await Promise.all([
        deps.listWorktrees(repo),
        deps.listSessions(),
      ]);
      return worktrees.map((worktree, index) => {
        const inside = sessions.filter((s) => s.repo === worktree.path);
        return {
          path: worktree.path,
          ...(worktree.branch === undefined ? {} : { branch: worktree.branch }),
          isMain: index === 0,
          runningSessions: inside.filter((s) => toCardStatus(s) === 'running').length,
          awaitingApprovalSessions: inside.filter((s) => toCardStatus(s) === 'awaiting_approval')
            .length,
        };
      });
    },
  };
}
