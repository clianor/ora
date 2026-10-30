import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

const browserGlobals = ['window', 'document', 'localStorage', 'sessionStorage', 'navigator'];

export default defineConfig(
  globalIgnores([
    '**/node_modules/',
    '**/dist/',
    '**/release/',
    '**/coverage/',
    'tmp/',
    'eval/tasks/',
    'pnpm-lock.yaml',
    '.claude/skills/impeccable/',
  ]),
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-nested-ternary': 'error',
      'no-void': 'error',
      'id-match': ['error', '^[A-Za-z0-9_$]+$', { onlyDeclarations: true }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['packages/protocol/**/*.ts', 'packages/core/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...browserGlobals.map((name) => ({
          name,
          message: 'protocol과 core는 브라우저 전역에 의존하지 않습니다.',
        })),
      ],
    },
  },
  {
    files: ['**/*.ts'],
    ignores: ['**/isolation/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='HOME']",
          message: 'HOME은 격리 모듈에서만 읽습니다. 그 밖의 모듈은 설정에서 받은 경로를 씁니다.',
        },
        {
          selector:
            "MemberExpression[object.object.name='process'][object.property.name='env'][property.value='HOME']",
          message: 'HOME은 격리 모듈에서만 읽습니다. 그 밖의 모듈은 설정에서 받은 경로를 씁니다.',
        },
        {
          selector:
            "CallExpression[callee.name='homedir'], CallExpression[callee.property.name='homedir']",
          message:
            '홈 디렉터리는 격리 모듈에서만 구합니다. 그 밖의 모듈은 설정에서 받은 경로를 씁니다.',
        },
      ],
    },
  },
);
