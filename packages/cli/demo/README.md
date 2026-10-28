# 시연 스크립트

가짜 모델이 정해진 순서로 응답해서 웹 UI의 주요 흐름을 한 번에 보여 줍니다.

## 실행

저장소 루트에서 다음 명령을 실행합니다.

```sh
packages/cli/demo/start.sh
```

- 출력 첫 줄이 시작 URL입니다. 브라우저로 엽니다.
- 웹 결과물이 `apps/web/dist`에 없으면 API만 제공합니다. 다른 경로는 `ORA_WEB_DIR=<경로>`로 정합니다.
- 포트를 정하려면 `start.sh --port <번호>`로 실행합니다.
- 실행할 때마다 `${TMPDIR:-/tmp}/ora-demo-run/`을 지우고 새로 만듭니다. 다른 위치는 `ORA_DEMO_RUN_DIR=<경로>`로 정합니다. 기본 경로가 아닌 폴더는 `.ora-demo-run` 표시 파일이 있을 때만 지우고, 이미 있는 다른 폴더는 지우지 않고 멈춥니다. `ORA_DEMO_RUN_DIR=packages/cli/demo/.run`처럼 이 폴더 안으로 두는 경우에 대비해 `.run/`을 `.gitignore`에 넣었습니다. 다만 `prettier --check`는 `.gitignore`를 읽지 않으므로 저장소 안에 두면 산출물이 검사에 걸립니다.

`start.sh`가 하는 일은 다음과 같습니다.

1. `project/`를 실행 폴더의 `work/`로 복사하고 `git init`으로 브랜치 `demo`를 만듭니다. 모델이 고치는 파일은 복사본이고 저장소의 파일은 바뀌지 않습니다.
2. `ORA_HOME`을 실행 폴더의 `home/`으로 둡니다. 세션 기록, 기억, 항상 승인(`permissions.json`)이 모두 이 안에 쌓입니다.
3. `engine.config.json`의 `always-ask` 모드로 `ora serve --model-script model-script.json`을 띄웁니다. 작업 폴더는 실행 폴더의 `work/`입니다.

## 화면에서 볼 수 있는 흐름

새 세션을 만들면 모델 스크립트가 다음 순서로 진행합니다.

1. `ask_user`: 질문 2개. 첫째는 하나만 고르고 둘째는 `multiSelect`입니다.
2. `todo.update`: todo `t1`을 선언합니다.
3. `file_read`: `calc.mjs`를 읽습니다. 읽기는 `always-ask`에서도 묻지 않습니다.
4. `file_edit`: 뺄셈 버그를 고칩니다. 쓰기라서 승인 대화상자(인자 상세)가 뜹니다.
5. `shell`(`cat calc.mjs`): 두 번째 승인 대화상자가 뜹니다. 명령 전문과 cwd, 위험도를 보여 줍니다.
6. `verify.run`: 세 번째 승인 대화상자가 뜹니다. 승인하면 `node check.mjs`를 실행하고 증거를 남깁니다.
7. 단계를 넘겨 Learn까지 마치고 `completed`로 끝납니다.

승인할 때 "이 세션 동안"이나 "항상"을 고르면 규칙이 `session.json` 또는 실행 폴더의 `home/permissions.json`에 저장됩니다. 같은 세션을 다시 시작해도 같은 명령은 묻지 않습니다.

## 한계

모델 스크립트는 한 번 재생하는 고정 응답입니다. 세션을 재개하면 스크립트가 처음부터 다시 돌아서 같은 호출을 반복합니다.
