import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{packages,apps}/*/src/**/*.test.ts'],
    // 첫 테스트 파일이 들어오면 이 옵션을 지운다.
    passWithNoTests: true,
  },
});
