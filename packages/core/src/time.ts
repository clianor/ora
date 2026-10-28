const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** SPEC 4.1.1절의 기본 표기인 `+09:00` 오프셋 ISO 8601 문자열이다. */
export function formatKst(date: Date): string {
  return `${new Date(date.getTime() + KST_OFFSET_MS).toISOString().slice(0, -1)}+09:00`;
}
