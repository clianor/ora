#!/bin/sh
# 시연용 서버를 띄운다. 예제 프로젝트와 Ora 홈을 모두 임시 폴더 안에 새로 만들어, 사용자 홈이나 저장소를 건드리지 않는다.
set -e
DEMO_DIR=$(cd "$(dirname "$0")" && pwd)
DEFAULT_RUN_DIR="${TMPDIR:-/tmp}/ora-demo-run"
RUN_DIR="${ORA_DEMO_RUN_DIR:-$DEFAULT_RUN_DIR}"
MARKER=".ora-demo-run"
# 기본 경로가 아닌 폴더는 이 스크립트가 만든 표시 파일이 있을 때만 지운다. 엉뚱한 폴더를 통째로 지우지 않으려는 것이다.
if [ "$RUN_DIR" != "$DEFAULT_RUN_DIR" ] && [ -e "$RUN_DIR" ] && [ ! -f "$RUN_DIR/$MARKER" ]; then
  echo "ORA_DEMO_RUN_DIR($RUN_DIR)이 이미 있고 이 스크립트가 만든 폴더가 아니라서 지우지 않습니다." >&2
  exit 1
fi
rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR/home"
touch "$RUN_DIR/$MARKER"
cp -R "$DEMO_DIR/project" "$RUN_DIR/work"
cd "$RUN_DIR/work"
git init --quiet -b demo
ORA_HOME="$RUN_DIR/home" exec node "$DEMO_DIR/../src/main.ts" serve \
  --model-script "$DEMO_DIR/model-script.json" \
  --config "$DEMO_DIR/engine.config.json" \
  --web-dir "${ORA_WEB_DIR:-$DEMO_DIR/../../../apps/web/dist}" \
  "$@"
