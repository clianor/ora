import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const hostDir = fileURLToPath(new URL('../../packages/host/src/', import.meta.url));

// 메인 프로세스와 세션 워커는 워크스페이스 패키지를 한 파일로 묶는다. 패키징한 앱에는 pnpm 링크가 없다.
await build({
  root,
  configFile: false,
  logLevel: 'warn',
  ssr: { noExternal: true, external: ['electron', 'node-pty'] },
  build: {
    ssr: true,
    target: 'node24',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: { main: 'src/main/index.ts', worker: `${hostDir}worker.ts` },
      output: { entryFileNames: '[name].js', format: 'es' },
    },
  },
});

// 샌드박스 preload는 CommonJS 한 파일이어야 한다.
await build({
  root,
  configFile: false,
  logLevel: 'warn',
  build: {
    target: 'node24',
    outDir: 'dist',
    emptyOutDir: false,
    lib: { entry: 'src/preload/index.ts', formats: ['cjs'], fileName: () => 'preload.cjs' },
    rollupOptions: { external: ['electron'] },
  },
});
