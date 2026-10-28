/** 전송 형식들이 함께 쓰는 HTTP 도우미다. */

export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  if (signal.aborted) {
    reject(signal.reason);
    return promise.then(() => undefined);
  }
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', onAbort);
    resolve(undefined);
  }, ms);
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal.reason);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return promise.then(() => undefined);
}

/** SSE 본문을 프레임 단위로 읽는다. 청크 경계에서 잘린 줄은 이어 붙인다. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replaceAll('\r\n', '\n');
    let end = buffer.indexOf('\n\n');
    while (end !== -1) {
      const data = buffer
        .slice(0, end)
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      buffer = buffer.slice(end + 2);
      if (data !== '') yield data;
      end = buffer.indexOf('\n\n');
    }
  }
}
