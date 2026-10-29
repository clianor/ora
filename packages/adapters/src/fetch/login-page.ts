import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';

const CLOSE_SCRIPT = 'window.close();';
const SCRIPT_HASH = createHash('sha256').update(CLOSE_SCRIPT).digest('base64');

/** 브라우저는 스크립트로 연 창만 `window.close()`로 닫게 하므로, 글만 읽어도 다음 행동을 알 수 있어야 한다. */
const MESSAGES = {
  success: '로그인이 끝났습니다. 이 창을 닫고 Ora로 돌아갑니다.',
  failure: '로그인에 실패했습니다. 이 창을 닫고 Ora에서 다시 시도합니다.',
} as const;

/** OAuth 콜백 서버가 브라우저에 돌려주는 결과 페이지다. 외부 자원 없이 이 페이지의 인라인 스크립트(해시로 지정)만 허용한다. */
export function sendLoginResult(res: ServerResponse, isSuccess: boolean): void {
  const message = isSuccess ? MESSAGES.success : MESSAGES.failure;
  res.writeHead(isSuccess ? 200 : 400, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `default-src 'none'; script-src 'sha256-${SCRIPT_HASH}'`,
  });
  res.end(
    `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Ora 로그인</title></head><body><p>${message}</p><script>${CLOSE_SCRIPT}</script></body></html>`,
  );
}
