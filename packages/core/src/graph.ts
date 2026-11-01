import type { GraphNodeSpec } from '@ora/protocol';

const DIAGNOSTIC_MAX_BYTES = 2000;
const DIAGNOSTIC_MAX_LINES = 20;

const normalizeScope = (path: string): string => path.replace(/^(\.\/)+/, '').replace(/\/+$/, '');

/** 경로 접두어로 판정한다. 같은 경로이거나 한쪽이 다른 쪽의 디렉터리면 겹친다. */
function doScopesOverlap(a: string, b: string): boolean {
  const left = normalizeScope(a);
  const right = normalizeScope(b);
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** 그래프를 거부하는 이유 목록이다. 비어 있으면 받아들인다. */
export function validateGraph(
  nodes: readonly GraphNodeSpec[],
  agentNames: readonly string[],
  takenIds: ReadonlySet<string>,
): string[] {
  const reasons: string[] = [];
  const byId = new Map<string, GraphNodeSpec>();
  for (const node of nodes) {
    if (byId.has(node.id)) reasons.push(`노드 ID ${node.id}가 두 번 나옵니다.`);
    else if (takenIds.has(node.id)) reasons.push(`노드 ID ${node.id}는 이미 있는 todo ID입니다.`);
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    for (const dep of node.after) {
      if (!byId.has(dep)) reasons.push(`${node.id}가 없는 노드 ${dep}를 가리킵니다.`);
    }
    if (!agentNames.includes(node.agent)) {
      reasons.push(`${node.id}가 없는 에이전트 ${node.agent}를 가리킵니다.`);
    }
    for (const path of node.writeScope) {
      if (/[*?[\]{}]/.test(path)) {
        reasons.push(`${node.id}의 쓰기 범위 ${path}에 글롭 패턴을 쓸 수 없습니다.`);
      }
    }
  }
  if (reasons.length > 0) return reasons;

  // 앞선 노드가 없는 노드부터 차례로 걷어 내고, 남는 노드가 있으면 고리다.
  const remaining = new Map(nodes.map((node) => [node.id, new Set(node.after)]));
  for (;;) {
    const ready = [...remaining].filter(([, deps]) => deps.size === 0).map(([id]) => id);
    if (ready.length === 0) break;
    for (const id of ready) remaining.delete(id);
    for (const deps of remaining.values()) for (const id of ready) deps.delete(id);
  }
  if (remaining.size > 0) {
    reasons.push(`고리가 있습니다: ${[...remaining.keys()].join(', ')}`);
    return reasons;
  }

  const writers = nodes.filter((node) => node.writeScope.length > 0);
  for (const [index, first] of writers.entries()) {
    for (const second of writers.slice(index + 1)) {
      const hit = first.writeScope
        .flatMap((a) => second.writeScope.map((b) => [a, b] as const))
        .find(([a, b]) => doScopesOverlap(a, b));
      if (hit !== undefined) {
        reasons.push(
          `${first.id}와 ${second.id}의 쓰기 범위가 ${normalizeScope(hit[0].length <= hit[1].length ? hit[0] : hit[1])}/에서 겹칩니다. 범위를 나눠 다시 냅니다.`,
        );
      }
    }
  }
  return reasons;
}

/** 노드마다 의존 단계를 센다. 앞선 노드가 없으면 1단계다. */
export function computeLevels(nodes: readonly GraphNodeSpec[]): Map<string, number> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const levels = new Map<string, number>();
  const levelOf = (id: string): number => {
    const known = levels.get(id);
    if (known !== undefined) return known;
    const node = byId.get(id);
    const level = 1 + Math.max(0, ...(node?.after ?? []).map(levelOf));
    levels.set(id, level);
    return level;
  };
  for (const node of nodes) levelOf(node.id);
  return levels;
}

/** 진단을 마지막 20줄, 2,000바이트 이내로 자른다. 자르면 뒤쪽(실패 원인이 남는 쪽)을 남긴다. */
export function capDiagnostic(text: string): string {
  const tail = text.trim().split('\n').slice(-DIAGNOSTIC_MAX_LINES).join('\n');
  const bytes = new TextEncoder().encode(tail);
  if (bytes.length <= DIAGNOSTIC_MAX_BYTES) return tail;
  return new TextDecoder()
    .decode(bytes.slice(bytes.length - DIAGNOSTIC_MAX_BYTES))
    .replace(/^\uFFFD+/, '');
}
