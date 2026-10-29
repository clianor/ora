/** 앞부분과 뒷부분만 남기고 가운데를 자른다. */
export function truncateMiddle(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  const half = Math.floor(maxBytes / 2);
  const head = bytes.subarray(0, half).toString('utf8');
  const tail = bytes.subarray(bytes.length - half).toString('utf8');
  return `${head}\n[... 가운데 ${bytes.length - 2 * half}바이트를 잘랐습니다 ...]\n${tail}`;
}
