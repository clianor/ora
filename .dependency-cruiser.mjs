const workspacePath = '^(packages|apps)/';

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: '순환 의존은 계층의 단방향 규칙을 깨뜨립니다.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment:
        '해석할 수 없는 import입니다. 경로나 package.json 선언을 확인합니다. Vite 플러그인이 만드는 virtual: 모듈은 예외입니다.',
      from: {},
      to: { couldNotResolve: true, pathNot: '^virtual:' },
    },
    {
      name: 'no-undeclared-deps',
      severity: 'error',
      comment: 'package.json에 선언하지 않은 npm 패키지를 import합니다.',
      from: {},
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
    },
    {
      name: 'no-dev-deps-in-src',
      severity: 'error',
      comment:
        '배포 코드가 devDependencies를 import합니다. 데스크톱 앱은 electron-builder가 Electron을 따로 싣고 나머지를 번들하므로 electron을 devDependencies에 둡니다.',
      from: { path: `${workspacePath}[^/]+/src/`, pathNot: ['\\.test\\.ts$', '^apps/desktop/'] },
      to: { dependencyTypes: ['npm-dev'] },
    },
    {
      name: 'no-orphans',
      severity: 'error',
      comment: '아무도 import하지 않고 아무것도 import하지 않는 파일입니다. 삭제하거나 연결합니다.',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)[^/]+\\.config\\.(js|mjs|cjs|ts)$',
          '^\\.dependency-cruiser\\.mjs$',
        ],
      },
      to: {},
    },
    {
      name: 'no-relative-cross-package',
      severity: 'error',
      comment: '다른 패키지는 상대 경로가 아니라 패키지 이름(@ora/...)으로 import합니다.',
      from: { path: '^(packages|apps)/([^/]+)/' },
      to: { path: workspacePath, pathNot: '^$1/$2/', dependencyTypes: ['local'] },
    },

    {
      name: 'pure-layers-no-node-builtins',
      severity: 'error',
      comment: 'protocol과 core는 Node 내장 모듈을 import하지 않습니다.',
      from: { path: '^packages/(protocol|core)/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'protocol-imports-no-workspace',
      severity: 'error',
      comment: 'protocol(0계층)은 다른 워크스페이스 패키지를 import하지 않습니다.',
      from: { path: '^packages/protocol/' },
      to: { path: workspacePath, pathNot: '^packages/protocol/' },
    },
    {
      name: 'core-imports-protocol-only',
      severity: 'error',
      comment: 'core(1계층)는 protocol만 import합니다. 인프라는 core가 선언한 포트로만 만납니다.',
      from: { path: '^packages/core/' },
      to: { path: workspacePath, pathNot: '^packages/(core|protocol)/' },
    },
    {
      name: 'infra-imports-core-and-protocol-only',
      severity: 'error',
      comment: '인프라(2계층)는 core와 protocol만 import합니다. 인프라끼리도 import하지 않습니다.',
      from: { path: '^packages/(adapters|tools|memory|store)/' },
      to: { path: workspacePath, pathNot: ['^packages/(core|protocol)/', '^packages/$1/'] },
    },
    {
      name: 'host-imports-no-presentation',
      severity: 'error',
      comment: 'host(3계층)는 표현 계층을 import하지 않습니다.',
      from: { path: '^packages/host/' },
      to: { path: '^(apps/|packages/cli/)' },
    },
    {
      name: 'cli-through-host',
      severity: 'error',
      comment: 'cli는 host와 protocol만 import합니다.',
      from: { path: '^packages/cli/' },
      to: { path: workspacePath, pathNot: '^packages/(cli|host|protocol)/' },
    },
    {
      name: 'renderer-imports-protocol-only',
      severity: 'error',
      comment: '화면 코드는 protocol만 import합니다. 엔진과는 HostClient로만 통신합니다.',
      from: { path: '^apps/web/|^apps/desktop/src/renderer/' },
      to: { path: '^packages/', pathNot: '^packages/protocol/' },
    },
    {
      name: 'desktop-main-through-host',
      severity: 'error',
      comment: 'Electron 메인 프로세스는 host와 protocol만 import합니다.',
      from: { path: '^apps/desktop/src/main/' },
      to: { path: '^packages/', pathNot: '^packages/(host|protocol)/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '^(tmp|coverage|eval/tasks|\\.claude)/|(^|/)(dist|release)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'node', 'default', 'types'],
    },
  },
};
