# Ora

에이전트 엔진과 데스크톱 셸을 만드는 TypeScript 모노레포다. 요구사항의 정본은 `SPEC.md`다. 이 파일은 1,250줄이 넘으므로 `grep -n '^##' SPEC.md`로 절을 찾아 필요한 절만 읽는다.

`SPEC.md`는 사용자 승인 없이 고치지 않는다. 바꿀 내용이 생기면 바뀌기 전과 후를 먼저 보여 준다.

저장소는 격리된 상태로 둔다. 저장소 안의 실제 파일만 쓰고, 심링크, 저장소 밖 경로, 개인 환경에 기대지 않는다. 심링크는 `pnpm check:paths`가 막는다.

## 명령

모든 명령은 mise가 고정한 Node 24와 pnpm 12.15.0으로 돌린다. 셸에서 mise를 활성화하지 않았다면 명령 앞에 `mise exec --`를 붙인다.

- 환경 준비: `mise install && mise exec -- pnpm install`
- 전체 검사: `pnpm check`. 종료 코드 0이 완료 조건이다.
- 개별 검사: `pnpm check:format`, `check:types`, `check:lint`, `check:test`, `check:arch`, `check:unused`, `check:paths`, `check:licenses`, `check:secrets`, `check:agents`, `check:claude-md`
- 지시 파일과 스킬을 고친 뒤: `pnpm check:agents && pnpm check:claude-md`. 채점과 승격은 `claude-md-management` 스킬로 한다.
- 포맷 자동 수정: `pnpm format`
- 테스트 파일 하나: `pnpm exec vitest run <경로>`
- 패키지 하나의 타입 검사: `pnpm --filter @ora/core run typecheck`

## 계층 구조

포트와 어댑터 구조다. import는 아래 표에서 바깥 계층이 안쪽 계층으로만 향한다.

| 계층     | 패키지                                 | import할 수 있는 대상                                     |
| -------- | -------------------------------------- | --------------------------------------------------------- |
| 0 계약   | `protocol`                             | `zod`뿐이다                                               |
| 1 코어   | `core`                                 | `protocol`                                                |
| 2 인프라 | `adapters`, `tools`, `memory`, `store` | `core`, `protocol`. 인프라끼리는 import하지 않는다        |
| 3 호스트 | `host`                                 | 0~2계층 전부                                              |
| 4 표현   | `cli`, `apps/*`                        | `cli`는 `host`와 `protocol`. 화면 코드는 `protocol`뿐이다 |

- 코어는 인프라를 import하지 않는다. `packages/core/src/ports/`에 선언한 인터페이스로 부르고, 호스트가 구현체를 넣는다.
- `protocol`과 `core`는 Node 내장 모듈과 브라우저 전역을 쓰지 않는다.
- 규칙의 정본은 `.dependency-cruiser.mjs`다.
- 상태의 정본은 이벤트 스트림(`transcript.jsonl`)이다. `session.json`과 `todos.json`은 이벤트로 다시 만들 수 있는 캐시다.
- todo의 `verified`와 `failed`는 엔진의 검증 로직만 쓴다. 모델이 이 값을 쓰는 경로를 만들지 않는다.

## 코드 규칙

- 상대 import에 `.ts` 확장자를 붙인다. Node가 `.ts`를 직접 실행하며 빌드 단계는 없다.
- `enum`, `namespace`, 생성자 매개변수 프로퍼티를 쓰지 않는다. `erasableSyntaxOnly`가 막는다.
- 다른 패키지는 패키지 이름(`@ora/protocol`)으로 import하고, 그 패키지의 `exports`가 가리키는 `src/index.ts`만 쓴다. 상대 경로로 다른 패키지 파일을 import하면 `pnpm check:arch`가 막는다.
- 의존성 버전은 `pnpm-workspace.yaml`의 `catalog:`에만 적고, `package.json`은 `catalog:`로 참조한다.
- 새 의존성의 라이선스는 MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD 중 하나여야 한다. 개발 도구(`devDependencies`)에는 BlueOak-1.0.0과 MPL-2.0도 허용한다. `pnpm check:licenses`가 검사한다.
- 새 도구를 직접 만들기 전에 기존 도구가 있는지 찾고, 도입하기 전에 사용자에게 확인한다.
- 비밀 값은 환경변수에서만 읽는다. 설정 파일, 이벤트, 로그에는 쓰지 않는다.
- `~/.agents`, `~/.claude` 같은 기존 하네스 경로와 `process.env.HOME`, `homedir()`은 `isolation/` 디렉터리 밖에서 쓰지 않는다. `pnpm check:paths`와 린트가 막는다.
- 식별자는 영어로 쓰고, 함수 이름은 동사로 시작한다.

## 화면

- 화면은 OpenPencil MCP로 `design/`에 먼저 디자인하고, 사용자 승인을 받은 뒤 구현한다. 승인 전에는 `apps/web` 코드를 만들지 않는다.
- 색, 간격, 반경, 모션은 디자인 토큰 파일 하나에서만 정의한다. 테마는 `light`, `dark`, `system` 셋이다 (SPEC 8.5절).
- OpenPencil 작업 전에 `open-pencil` 스킬을, 화면 구현 전에 `frontend-design` 스킬을 읽는다. 두 스킬은 외부 원문을 고정 버전으로 들여온 것이라 고치지 않는다. `open-pencil`은 앱 버전과 같은 태그(`v0.16.0`)를, `frontend-design`은 anthropics/skills 커밋 `dbd4588`을 쓴다. 앱을 올리면 같은 태그의 스킬로 바꾼다.
- 토큰의 정본은 `design/tokens/Ora/Light.tokens.json`과 `Dark.tokens.json`이다. OpenPencil에는 `import_design_tokens`로 가져간다. OpenPencil 0.16의 JSX는 변수를 만들지 못하고 `designVar`로 참조만 한다.

## 테스트

- 새 `test()`는 사용자가 겪는 동작 하나를 끝까지 확인하는 e2e로 쓴다. 단위 테스트는 e2e가 입력을 만들 수 없는 분기에만 쓴다.
- 첫 테스트 파일을 추가하면 `vitest.config.ts`의 `passWithNoTests`를 지운다.

## 함정

- TypeScript는 6.0.x에 고정한다. typescript-eslint가 6.1 이상을 지원하지 않으므로 7.x로 올리지 않는다.
- pnpm 12는 의존성의 빌드 스크립트를 기본으로 막는다. 필요하면 `pnpm-workspace.yaml`의 `allowBuilds`에 추가하고 사용자에게 알린다.
- pnpm 버전을 올릴 때는 `mise.toml`과 `package.json`의 `packageManager`를 함께 바꾼다.
- Git 훅(`lefthook.yml`)은 `mise exec --`로 도구를 찾는다. 그래서 `mise`만 PATH에 있으면 PATH에 `node`와 `pnpm`이 없어도 고정 버전으로 돈다. omp가 `CI=true`를 넣어도 건너뛰지 않는다.
- 훅이 실패하면 우회하지 않고 실패한 검사를 고친다. pre-push는 `pnpm check` 전체를 돌린다.
