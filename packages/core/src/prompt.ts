import type { Isolation, PermissionMode, Todo } from '@ora/protocol';
import type { ToolSpec } from './ports/model.ts';
import type { RecallPack } from './ports/memory.ts';
import type { InstructionFile, PromptFile } from './ports/workspace.ts';

export interface PromptParts {
  readonly promptFiles: readonly PromptFile[];
  readonly tools: readonly ToolSpec[];
  readonly permissionMode: PermissionMode;
  readonly isolation: Isolation;
  readonly instructionFiles: readonly InstructionFile[];
  readonly recall: RecallPack;
}

/** SPEC 2.3.5절 순서: 엔진 규칙, 도구, 권한·격리 요약, 지시 파일, 회상 팩. 작업 요청은 첫 사용자 메시지에 넣는다. */
export function assembleSystemPrompt(parts: PromptParts): string {
  const sections = [
    ...parts.promptFiles.map((file) => file.content.trim()),
    `## 도구\n${parts.tools.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n')}`,
    `## 권한과 격리\n- 권한 모드: ${parts.permissionMode}\n- 격리 옵션: ${parts.isolation}`,
  ];
  if (parts.instructionFiles.length > 0) {
    const body = parts.instructionFiles
      .map((file) => `### ${file.path}\n${file.content.trim()}`)
      .join('\n\n');
    sections.push(`## 프로젝트 지시 파일\n${body}`);
  }
  if (parts.recall.lessons.length > 0) {
    const body = parts.recall.lessons.map((lesson) => `- ${lesson.id}: ${lesson.text}`).join('\n');
    sections.push(`## 회상한 교훈\n${body}`);
  }
  return sections.join('\n\n');
}

export function describeTodos(todos: readonly Todo[]): string {
  if (todos.length === 0) return '현재 todo: 없음';
  const lines = todos.map(
    (todo) =>
      `- ${todo.id} [${todo.status}] ${todo.content}` +
      (todo.verify === undefined ? '' : ` (검증: ${todo.verify.command})`),
  );
  return `현재 todo:\n${lines.join('\n')}`;
}
