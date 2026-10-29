/** 완성 무결성 게이트다 (SPEC 6.2절). 종료 코드 0인 검증 결과에서 스텁, 건너뜀, 단언 없는 검사를 찾는다. */

export interface GateResult {
  readonly passed: boolean;
  readonly findings: readonly string[];
  /** 기준선이 없어 스텁 검사를 하지 못한 파일이다. 실패 사유가 아니다. */
  readonly unchecked: readonly string[];
}

const STUB_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/\bTODO\b/, 'TODO'],
  [/\bFIXME\b/, 'FIXME'],
  [/NotImplemented/, 'NotImplemented'],
  [/not implemented/i, 'not implemented'],
  [/\bunimplemented!\s*\(/, 'unimplemented!()'],
  [/\btodo!\s*\(/, 'todo!()'],
];

/** 기준선에 없던 줄과 그 줄 번호(1부터)다. 같은 줄이 여러 번 있으면 기준선에 있던 개수만큼 앞에서부터 기존 줄로 본다. ponytail: 줄 순서를 보지 않는 비교라 줄을 옮기면 놓친다. */
function addedLines(before: string, after: string): Map<number, string> {
  const remaining = new Map<string, number>();
  for (const line of before.split('\n')) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  const added = new Map<number, string>();
  after.split('\n').forEach((line, index) => {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else added.set(index + 1, line);
  });
  return added;
}

/** 더한 줄에서 스텁을 찾아 `파일:줄 패턴` 한 줄씩 돌려준다. */
export function findStubs(file: string, before: string, after: string): string[] {
  const added = addedLines(before, after);
  const found: string[] = [];
  for (const [lineNumber, text] of added) {
    const hit = STUB_PATTERNS.find(([pattern]) => pattern.test(text));
    if (hit !== undefined) found.push(`${file}:${lineNumber} ${hit[1]}`);
  }
  const lines = after.split('\n');
  const indentOf = (line: string) => line.length - line.trimStart().length;
  lines.forEach((line, index) => {
    const def = /^\s*(?:async\s+)?def\s.*:\s*$/.exec(line);
    if (def === null) return;
    let bodyIndex = index + 1;
    while (bodyIndex < lines.length && (lines[bodyIndex] ?? '').trim() === '') bodyIndex += 1;
    if ((lines[bodyIndex] ?? '').trim() !== 'pass') return;
    let nextIndex = bodyIndex + 1;
    while (nextIndex < lines.length && (lines[nextIndex] ?? '').trim() === '') nextIndex += 1;
    const next = lines[nextIndex];
    if (next !== undefined && indentOf(next) > indentOf(line)) return;
    if (added.has(index + 1) || added.has(bodyIndex + 1)) {
      found.push(`${file}:${bodyIndex + 1} pass 하나뿐인 함수`);
    }
  });
  return found;
}

const SKIP_COUNTS: readonly (readonly [RegExp, string])[] = [
  [/(\d+)\s+(?:skipped|todo)\b/gi, 'skipped·todo'],
  [/(\d+)\s+xfailed\b/gi, 'xfailed'],
  [/(\d+)\s+pending\b/gi, 'pending'],
  [/^#\s+(?:skip|todo)\s+(\d+)/gim, '# skip·todo'],
];

/** 검증 출력에서 건너뜀·보류 집계가 1 이상인 항목을 찾는다. */
function findSkips(output: string): string[] {
  const found: string[] = [];
  for (const [pattern, label] of SKIP_COUNTS) {
    for (const match of output.matchAll(pattern)) {
      if (Number(match[1]) >= 1) found.push(`건너뜀: ${match[0].trim()} (${label})`);
    }
  }
  if (/^\s*--- SKIP/m.test(output)) found.push('건너뜀: --- SKIP (go)');
  return found;
}

const ZERO_TEST_PATTERNS: readonly RegExp[] = [
  /^#\s+tests\s+0\b/m,
  /\bcollected 0 items\b/,
  /\bRan 0 tests\b/,
  /\bNo tests found\b/i,
  /\bno test files found\b/i,
  /Tests:\s+0 total/,
  /^\s*0 passing\b/m,
  /\[no test files\]/,
  /no tests to run/i,
];

const ALWAYS_SUCCEEDS = /^(?:true|:|exit\s+0|echo(?:\s.*)?)$/;

/** 단언 없는 검사다. 항상 성공하는 명령이거나 테스트 0개를 보고한 출력이다. */
function findNoAssertion(command: string, output: string): string[] {
  const parts = command
    .split(/&&|;|\n/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const found: string[] = [];
  if (parts.length > 0 && parts.every((part) => ALWAYS_SUCCEEDS.test(part))) {
    found.push(`단언 없는 검사: 항상 성공하는 명령 (${command})`);
  }
  if (ZERO_TEST_PATTERNS.some((pattern) => pattern.test(output))) {
    found.push('단언 없는 검사: 테스트 0개를 보고했습니다');
  }
  return found;
}

export function judgeGate(input: {
  readonly command: string;
  readonly output: string;
  readonly stubs: readonly string[];
  readonly unchecked: readonly string[];
}): GateResult {
  const findings = [
    ...input.stubs,
    ...findSkips(input.output),
    ...findNoAssertion(input.command, input.output),
  ];
  return { passed: findings.length === 0, findings, unchecked: input.unchecked };
}
