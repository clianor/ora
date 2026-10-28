#!/bin/sh
# 기존 하네스 설정 경로를 가리키는 문자열이 엔진 소스에 들어오지 않게 막는다.
# 격리 모듈(isolation 디렉터리)만 예외다.
pattern='~/\.(agents|claude|pi|omp|codex|gemini)(/|$|[^A-Za-z0-9_-])'

if git grep -nE --untracked "$pattern" -- ':(glob)packages/**/src/**' ':(glob)apps/**/src/**' ':(exclude,glob)**/isolation/**'; then
  echo "금지 경로 문자열을 찾았습니다. 격리 모듈 밖에서는 기존 하네스 경로를 적지 않습니다." >&2
  exit 1
fi
