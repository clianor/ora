import { join } from 'node:path';
import { runSession } from '@ora/core';
import type { DelegatePort, EngineDeps, EngineSettings } from '@ora/core';
import type { OraEvent } from '@ora/protocol';
import { createSessionStorage } from '@ora/store';
import type { Config } from './config.ts';
import { intersectTools, mergeAgents, readAllAgents } from './isolation/agent-files.ts';
import { createSessionId, tryAcquireSlot } from './supervisor.ts';

export interface DelegatePortOptions {
  /** 부모 세션의 엔진 의존성이다. 하위 세션이 도구, 모델, 작업 공간을 그대로 쓴다. */
  readonly parentDeps: () => EngineDeps;
  readonly settings: EngineSettings;
  readonly config: Config;
  readonly oraHome: string;
  readonly sessionsDir: string;
  readonly repo?: string;
  readonly onEvent: (event: OraEvent) => void;
  /** 실행 중인 하위 세션의 소프트 스톱 함수다. 위임 카드의 "중지"가 이 목록으로 그 하위 세션만 멈춘다. */
  readonly children: Map<string, () => void>;
}

const isFileWrite = (tool: string): boolean => tool === 'file_write' || tool === 'file_edit';

function formatBrief(brief: Parameters<DelegatePort['run']>[0]['brief']): string {
  return [
    '## 브리프',
    `목표: ${brief.goal}`,
    `쓰기 범위: ${brief.writeScope.length === 0 ? '없음(파일을 바꾸지 않는다)' : brief.writeScope.join(', ')}`,
    `검증 명령: ${brief.verifyCommand ?? '없음'}`,
    `중단 조건: ${brief.stopCondition}`,
  ].join('\n');
}

/** 하위 세션을 같은 워커 프로세스 안에서 `runSession`으로 돌린다. 부모의 대화 이력은 넘기지 않고 브리프만 넘긴다 (SPEC 2.15.1절). */
export function createDelegatePort(options: DelegatePortOptions): DelegatePort {
  const { config, oraHome } = options;
  return {
    async run(request) {
      const deps = options.parentDeps();
      const agents = mergeAgents(
        await readAllAgents({
          projectDir: join(request.cwd, '.ora', 'agents'),
          globalDir: join(oraHome, 'agents'),
        }),
      );
      const definition = agents.find((agent) => agent.name === request.agent);
      if (definition === undefined) {
        return {
          error: `알 수 없는 에이전트: ${request.agent}. 쓸 수 있는 정의: ${agents.map((agent) => agent.name).join(', ')}`,
        };
      }
      const tools = intersectTools(
        definition,
        deps.tools.filter((tool) => request.parentToolNames.includes(tool.name)),
      );
      const release = await tryAcquireSlot(
        join(oraHome, 'slots'),
        config.limits.maxConcurrentSessions,
      );
      if (release === undefined) {
        return {
          error: `동시 세션 상한(limits.maxConcurrentSessions ${config.limits.maxConcurrentSessions})에 닿아 하위 세션을 시작하지 못했습니다. 실행 중인 세션이 끝난 뒤 다시 위임합니다.`,
        };
      }
      const sessionId = createSessionId();
      const stop = new AbortController();
      options.children.set(sessionId, () => {
        stop.abort();
      });
      try {
        const storage = await createSessionStorage(join(options.sessionsDir, sessionId));
        const changed = new Set<string>();
        const pending = new Map<string, { path: string; added: number; deleted: number }>();
        const cwdPrefix = `${request.cwd.replace(/\/$/, '')}/`;
        let steps = 0;
        let added = 0;
        let deleted = 0;
        await request.onStart({ sessionId, tools, maxSteps: definition.maxSteps });
        const { approval: parentApproval } = request;
        const childDeps: EngineDeps = {
          models: deps.models,
          tools: deps.tools,
          runner: deps.runner,
          workspace: deps.workspace,
          clock: deps.clock,
          ...(deps.skills === undefined ? {} : { skills: deps.skills }),
          ...(deps.alwaysApprovals === undefined ? {} : { alwaysApprovals: deps.alwaysApprovals }),
          ...(deps.restrictedFolders === undefined
            ? {}
            : { restrictedFolders: deps.restrictedFolders }),
          ...(deps.delegate === undefined ? {} : { delegate: deps.delegate }),
          sink: {
            async append(event) {
              await storage.transcript.append(event);
              options.onEvent(event);
              if (event.type === 'model_request') steps += 1;
              if (event.type === 'tool_call' && isFileWrite(event.payload.tool)) {
                const { path, content, oldText, newText } = event.payload.args;
                if (typeof path === 'string') {
                  const lines = (text: unknown) =>
                    typeof text === 'string' && text !== '' ? text.split('\n').length : 0;
                  pending.set(event.payload.callId, {
                    path,
                    added: lines(content) + lines(newText),
                    deleted: lines(oldText),
                  });
                }
              }
              if (event.type === 'tool_result' && event.payload.status === 'ok') {
                const write = pending.get(event.payload.callId);
                if (write !== undefined) {
                  changed.add(
                    write.path.startsWith(cwdPrefix)
                      ? write.path.slice(cwdPrefix.length)
                      : write.path,
                  );
                  added += write.added;
                  deleted += write.deleted;
                }
              }
            },
          },
          store: storage.sessions,
          // 하위 세션의 기억은 staging에만 쓴다. LESSONS.md에 합치는 일은 부모 세션의 유지보수가 맡는다 (SPEC 3.5절).
          memory: {
            ...deps.memory,
            maintain: () => Promise.resolve({ merged: [], invalidated: [] }),
          },
          ...(parentApproval === undefined
            ? {}
            : {
                approval: {
                  request: (approvalRequest, signal) =>
                    parentApproval.request(
                      {
                        ...approvalRequest,
                        from: {
                          sessionId,
                          agent: definition.name,
                          intent: request.intent,
                        },
                      },
                      signal,
                    ),
                },
              }),
        };
        const outcome = await runSession(childDeps, {
          sessionId,
          task: formatBrief(request.brief),
          cwd: request.cwd,
          ...(options.repo === undefined ? {} : { repo: options.repo }),
          settings: {
            ...options.settings,
            permissionMode: request.permissionMode,
            maxSteps: definition.maxSteps,
          },
          configSummary: { delegatedFrom: request.parentSessionId, agent: definition.name },
          signal: request.signal,
          softStop: AbortSignal.any([request.softStop, stop.signal]),
          delegation: {
            depth: request.depth + 1,
            delegatedBy: {
              sessionId: request.parentSessionId,
              callId: request.callId,
              agent: definition.name,
              writeScope: [...request.brief.writeScope],
              maxSteps: definition.maxSteps,
            },
            role: definition.role,
            allowedTools: tools,
            ledger: request.ledger,
            title: `${definition.name} · ${request.intent}`,
            systemSuffix: definition.body,
          },
        });
        return {
          sessionId,
          status: outcome.status,
          endReason: outcome.endReason,
          summary: outcome.summary,
          todos: outcome.todos,
          cost: outcome.cost,
          changedFiles: [...changed].sort(),
          steps,
          added,
          deleted,
        };
      } catch (error) {
        return {
          error: `하위 세션이 실패했습니다: ${error instanceof Error ? error.message : String(error)}`,
        };
      } finally {
        options.children.delete(sessionId);
        await release();
      }
    },
  };
}
