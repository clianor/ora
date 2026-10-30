import { join } from 'node:path';
import { ruleKey } from '@ora/core';
import type {
  GeneralSettings,
  IsolationSettings,
  IsolationSettingsResponse,
  ModelSettings,
  PermissionRulesResponse,
  PermissionSettings,
  PermissionSettingsResponse,
} from '@ora/protocol';
import { UsageError, loadConfig } from './config.ts';
import { updateConfigFile } from './config-file.ts';
import { HARNESS_DIRS } from './isolation/skill-files.ts';
import { expandHomePath, resolveOraHome } from './isolation/ora-home.ts';
import { createPermissionsStore, PERMISSIONS_FILE } from './permissions-store.ts';

/** 맨 앞 `~`를 홈 폴더로 풀어 절대 경로로 만든다. 그 밖의 상대 경로는 거부한다. */
function expandHome(folder: string): string {
  const expanded = expandHomePath(folder);
  if (!expanded.startsWith('/')) {
    throw new UsageError(`항상 묻는 폴더는 /나 ~/로 시작하는 경로로 적습니다: ${folder}`);
  }
  return expanded;
}

export interface SettingsApiOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly configPath?: string;
  /** 지금 연결된 MCP 서버의 도구 이름이다. */
  readonly listMcpToolNames: () => Promise<string[]>;
}

/** 세션이 쓰는 내장 도구 이름이다. `permissions.tools`에 정책을 더할 때 고른다. */
const BUILTIN_TOOL_NAMES = ['shell', 'file_read', 'file_write', 'file_edit', 'history.read'];

export interface SettingsApi {
  getGeneral(): Promise<GeneralSettings>;
  setGeneral(next: GeneralSettings): Promise<GeneralSettings>;
  getModels(): Promise<ModelSettings>;
  setModels(next: ModelSettings): Promise<ModelSettings>;
  getPermissions(): Promise<PermissionSettingsResponse>;
  setPermissions(next: PermissionSettings): Promise<PermissionSettingsResponse>;
  getIsolation(runningSessionCount: number): Promise<IsolationSettingsResponse>;
  setIsolation(
    next: IsolationSettings,
    runningSessionCount: number,
  ): Promise<IsolationSettingsResponse>;
  listRules(): Promise<PermissionRulesResponse>;
  /** 파일을 읽지 못하면 지우지 않고 이유를 돌려준다. */
  removeRule(key: string): Promise<PermissionRulesResponse>;
}

const asObject = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * 설정 화면 다섯 페이지가 읽고 쓰는 호스트 API다 (SPEC 8.2.1절). 설정 파일은 화면의 사용자 요청으로만 쓰고, 모델 도구는 이 경로에 닿지 못한다 (SPEC 5.7절).
 * 세션은 시작할 때 설정을 읽으므로 바꾼 값은 다음 세션부터 적용한다.
 */
export function createSettingsApi(options: SettingsApiOptions): SettingsApi {
  const oraHome = resolveOraHome(options.env);
  const configFile = options.configPath ?? join(oraHome, 'engine.config.json');
  const permissionsStore = createPermissionsStore(join(oraHome, PERMISSIONS_FILE));
  const load = () => loadConfig(options.configPath, oraHome);

  const getGeneral = async (): Promise<GeneralSettings> => {
    const config = await load();
    return {
      maxSteps: config.limits.maxSteps,
      maxRepairsPerTodo: config.limits.maxRepairsPerTodo,
      noProgressSteps: config.limits.noProgressSteps,
      maxConcurrentSessions: config.limits.maxConcurrentSessions,
      isReviewEnabled: config.verify.review,
      compactAtRatio: config.context.compactAtRatio,
      isIdleSummaryEnabled: config.context.idleEnabled,
    };
  };
  const getModels = async (): Promise<ModelSettings> => {
    const config = await load();
    return {
      roles: Object.fromEntries(
        Object.entries(config.roles).map(([role, { chain }]) => [role, chain]),
      ),
      revertPolicy: config.fallback.revertPolicy,
    };
  };
  const getPermissions = async (): Promise<PermissionSettingsResponse> => {
    const config = await load();
    const mcpNames = await options.listMcpToolNames();
    return {
      mode: config.permissions.mode,
      tools: config.permissions.tools,
      restrictedFolders: config.permissions.restrictedFolders,
      availableTools: [...new Set([...BUILTIN_TOOL_NAMES, ...mcpNames])],
    };
  };
  const getIsolation = async (runningSessionCount: number): Promise<IsolationSettingsResponse> => ({
    isolation: (await load()).isolation,
    runningSessionCount,
    unreadDirectories: HARNESS_DIRS,
  });
  const listRules = async (): Promise<PermissionRulesResponse> => {
    const result = await permissionsStore.list();
    return result.error === undefined
      ? { rules: result.rules.map((rule) => ({ key: ruleKey(rule), rule })) }
      : { rules: [], error: result.error };
  };

  return {
    getGeneral,
    async setGeneral(next) {
      await updateConfigFile(configFile, (file) => ({
        ...file,
        limits: {
          ...asObject(file.limits),
          maxSteps: next.maxSteps,
          maxRepairsPerTodo: next.maxRepairsPerTodo,
          noProgressSteps: next.noProgressSteps,
          maxConcurrentSessions: next.maxConcurrentSessions,
        },
        verify: { ...asObject(file.verify), review: next.isReviewEnabled },
        context: {
          ...asObject(file.context),
          compactAtRatio: next.compactAtRatio,
          idleEnabled: next.isIdleSummaryEnabled,
        },
      }));
      return getGeneral();
    },
    getModels,
    async setModels(next) {
      await updateConfigFile(configFile, (file) => ({
        ...file,
        roles: Object.fromEntries(
          Object.entries(next.roles).map(([role, chain]) => [role, { chain }]),
        ),
        // 이 저장이 옛 `fallback.on`을 지운다.
        fallback: { revertPolicy: next.revertPolicy },
      }));
      return getModels();
    },
    getPermissions,
    async setPermissions(next) {
      await updateConfigFile(configFile, (file) => ({
        ...file,
        permissions: {
          ...asObject(file.permissions),
          mode: next.mode,
          tools: next.tools,
          restrictedFolders: next.restrictedFolders.map(expandHome),
        },
      }));
      return getPermissions();
    },
    getIsolation,
    async setIsolation(next, runningSessionCount) {
      await updateConfigFile(configFile, (file) => ({ ...file, isolation: next.isolation }));
      return getIsolation(runningSessionCount);
    },
    listRules,
    async removeRule(key) {
      const removed = await permissionsStore.remove(key);
      if (!removed.removed) return { rules: [], error: removed.reason };
      return listRules();
    },
  };
}
