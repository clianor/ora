#!/bin/sh
# 기존 하네스 설정 경로를 가리키는 문자열이 엔진 소스에 들어오지 않게 막는다.
# 격리 모듈(isolation 디렉터리)만 예외다.
pattern='~/\.(agents|claude|pi|omp|codex|gemini)(/|$|[^A-Za-z0-9_-])'

if git grep -nE --untracked "$pattern" -- ':(glob)packages/**/src/**' ':(glob)apps/**/src/**' ':(exclude,glob)**/isolation/**'; then
  echo "금지 경로 문자열을 찾았습니다. 격리 모듈 밖에서는 기존 하네스 경로를 적지 않습니다." >&2
  exit 1
fi

# 저장소는 안의 실제 파일만으로 완결된다. 심링크는 Windows와 zip 내려받기에서 깨진다.
symlinks=$(git ls-files -s | awk '$1 == "120000" { print $4 }')
if [ -n "$symlinks" ]; then
  echo "$symlinks"
  echo "저장소가 심링크를 추적합니다. 실제 파일로 바꿉니다." >&2
  exit 1
fi
