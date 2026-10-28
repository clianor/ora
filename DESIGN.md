---
name: Ora
description: 다크 우선 중립 회색, 글 중심, 배경 밝기로 영역을 나누는 에이전트 데스크톱 셸
colors:
  dark-background: '#1F1F1F'
  dark-sidebar: '#181818'
  dark-surface: '#2A2A2A'
  dark-surface-sunken: '#161616'
  dark-surface-hover: '#262626'
  dark-border: '#2C2C2C'
  dark-foreground: '#ECECEC'
  dark-foreground-muted: '#B4B4B4'
  dark-foreground-subtle: '#939393'
  dark-primary: '#ECECEC'
  dark-primary-foreground: '#1F1F1F'
  dark-success: '#3FB950'
  dark-success-subtle: '#12261A'
  dark-danger: '#FF7B72'
  dark-danger-subtle: '#2D1517'
  dark-warning: '#D29922'
  dark-ring: '#8AB4F8'
  light-background: '#FFFFFF'
  light-sidebar: '#F9F9F9'
  light-surface: '#F4F4F4'
  light-surface-sunken: '#F7F7F8'
  light-surface-hover: '#EFEFEF'
  light-border: '#E8E8E8'
  light-foreground: '#0D0D0D'
  light-foreground-muted: '#4A4A4A'
  light-foreground-subtle: '#6B6B6B'
  light-primary: '#0D0D0D'
  light-primary-foreground: '#FFFFFF'
  light-success: '#116329'
  light-success-subtle: '#E6F4EA'
  light-danger: '#CF222E'
  light-danger-subtle: '#FDECEC'
  light-warning: '#7D5300'
  light-ring: '#1A66D9'
typography:
  body:
    fontFamily: 'Pretendard'
    fontSize: '15px'
    fontWeight: 400
    lineHeight: '24px'
  input:
    fontFamily: 'Pretendard'
    fontSize: '15px'
    fontWeight: 400
    lineHeight: '22px'
  title:
    fontFamily: 'Pretendard'
    fontSize: '14px'
    fontWeight: 600
    lineHeight: '20px'
  label:
    fontFamily: 'Pretendard'
    fontSize: '13px'
    fontWeight: 500
    lineHeight: '18px'
  body-sm:
    fontFamily: 'Pretendard'
    fontSize: '13px'
    fontWeight: 400
    lineHeight: '18px'
  caption:
    fontFamily: 'Pretendard'
    fontSize: '12px'
    fontWeight: 500
    lineHeight: '16px'
  meta:
    fontFamily: 'Pretendard'
    fontSize: '12px'
    fontWeight: 400
    lineHeight: '16px'
  code:
    fontFamily: 'JetBrains Mono'
    fontSize: '13px'
    fontWeight: 400
    lineHeight: '18px'
  code-diff:
    fontFamily: 'JetBrains Mono'
    fontSize: '12px'
    fontWeight: 400
    lineHeight: '18px'
  code-stat:
    fontFamily: 'JetBrains Mono'
    fontSize: '12px'
    fontWeight: 500
    lineHeight: '16px'
rounded:
  sm: '8px'
  md: '10px'
  lg: '14px'
  xl: '18px'
spacing:
  '1': '4px'
  '2': '8px'
  '3': '12px'
  '4': '16px'
  '5': '20px'
  '6': '24px'
components:
  sidebar:
    backgroundColor: '{colors.dark-sidebar}'
    textColor: '{colors.dark-foreground-muted}'
    width: '264px'
    padding: '14px 8px 12px'
  sidebar-session-row:
    backgroundColor: '{colors.dark-sidebar}'
    textColor: '{colors.dark-foreground-muted}'
    typography: '{typography.body-sm}'
    rounded: '{rounded.sm}'
    padding: '6px 10px 6px 32px'
  sidebar-session-row-selected:
    backgroundColor: '{colors.dark-surface-hover}'
    textColor: '{colors.dark-foreground}'
    typography: '{typography.label}'
    rounded: '{rounded.sm}'
    padding: '6px 10px 6px 32px'
  header-stage:
    backgroundColor: '{colors.dark-surface}'
    textColor: '{colors.dark-foreground}'
    typography: '{typography.caption}'
    rounded: '{rounded.sm}'
    height: '28px'
    padding: '0 10px'
  user-bubble:
    backgroundColor: '{colors.dark-surface}'
    textColor: '{colors.dark-foreground}'
    typography: '{typography.body}'
    rounded: '{rounded.xl}'
    padding: '10px 16px'
  tool-call-line:
    textColor: '{colors.dark-foreground-muted}'
    typography: '{typography.label}'
    height: '28px'
  diff-block:
    backgroundColor: '{colors.dark-surface-sunken}'
    textColor: '{colors.dark-foreground}'
    typography: '{typography.code-diff}'
    rounded: '{rounded.md}'
    padding: '6px 0'
  diff-row-added:
    backgroundColor: '{colors.dark-success-subtle}'
    textColor: '{colors.dark-foreground}'
    typography: '{typography.code-diff}'
    height: '22px'
    padding: '0 12px'
  diff-row-removed:
    backgroundColor: '{colors.dark-danger-subtle}'
    textColor: '{colors.dark-foreground}'
    typography: '{typography.code-diff}'
    height: '22px'
    padding: '0 12px'
  approval-card:
    backgroundColor: '{colors.dark-surface}'
    textColor: '{colors.dark-foreground}'
    typography: '{typography.title}'
    rounded: '{rounded.lg}'
    padding: '16px'
  approval-command:
    backgroundColor: '{colors.dark-background}'
    textColor: '{colors.dark-foreground}'
    typography: '{typography.code}'
    rounded: '{rounded.md}'
    padding: '10px 12px'
  composer:
    backgroundColor: '{colors.dark-surface}'
    textColor: '{colors.dark-foreground-subtle}'
    typography: '{typography.input}'
    rounded: '{rounded.xl}'
    width: '720px'
    padding: '12px 14px 10px'
  composer-chip:
    textColor: '{colors.dark-foreground-muted}'
    typography: '{typography.caption}'
    rounded: '{rounded.sm}'
    height: '26px'
    padding: '0 8px'
  todo-row:
    backgroundColor: '{colors.dark-sidebar}'
    textColor: '{colors.dark-foreground}'
    typography: '{typography.label}'
    rounded: '{rounded.md}'
    padding: '10px'
  todo-row-active:
    backgroundColor: '{colors.dark-surface-hover}'
    textColor: '{colors.dark-foreground}'
    typography: '{typography.label}'
    rounded: '{rounded.md}'
    padding: '10px'
  button-primary:
    backgroundColor: '{colors.dark-primary}'
    textColor: '{colors.dark-primary-foreground}'
    typography: '{typography.label}'
    rounded: '{rounded.sm}'
    height: '30px'
    padding: '0 12px'
  button-secondary:
    backgroundColor: '{colors.dark-surface-hover}'
    textColor: '{colors.dark-foreground}'
    typography: '{typography.label}'
    rounded: '{rounded.sm}'
    height: '30px'
    padding: '0 12px'
  button-ghost:
    textColor: '{colors.dark-foreground-muted}'
    typography: '{typography.label}'
    rounded: '{rounded.sm}'
    height: '30px'
    padding: '0 12px'
---

# Design System: Ora

## Overview

**Creative North Star: "The Quiet Workbench"**

Ora의 화면은 조용한 작업대입니다. 중립 회색 위에서 대화 글이 주인공이고, 색은 상태를 알릴 때만 나타납니다. 이 방향은 Paseo, ChatGPT, Claude, Orca가 공유하는 문법을 따릅니다. 승인된 시안은 `design/previews/direction-D-dark.png`와 `direction-D-light.png`입니다.

영역은 테두리 대신 배경 밝기로 나눕니다. 응답 글에는 상자를 두르지 않고, 도구 호출은 한 줄로 줄입니다. 화면 구성은 왼쪽 사이드바(264px), 가운데 대화(본문 너비 720px), 오른쪽 todo·증거 패널(340px)입니다. 창은 1440 × 900 시안 기준이고 모서리 반경은 12px입니다.

테마는 `light`, `dark`, `system` 셋이고 기본값은 `system`입니다. 다크 값을 먼저 정했고, 라이트는 같은 토큰 이름에 다른 값을 줍니다. 아래 색 이름은 토큰 파일의 이름과 같습니다.

**Key Characteristics:**

- 다크 우선 중립 회색이고, 색은 성공, 위험, 경고 상태에만 씁니다.
- 응답은 상자 없이 글로 보여 주고, 도구 호출은 한 줄입니다.
- 테두리 대신 배경 밝기 차이로 영역을 나눕니다.
- 글꼴은 Pretendard와 JetBrains Mono 두 가지입니다.
- 상태는 색과 함께 아이콘과 글자를 씁니다(SPEC 8.4절).

## Colors

팔레트는 순수한 중립 회색에 초록, 빨강, 황색 상태색 셋을 더한 구성입니다. 프론트매터가 값의 정본이고, 아래 설명은 쓰임만 적습니다. 키는 `dark-` 또는 `light-` 접두사에 아래 이름을 붙입니다.

### Primary

- **Ink Button** (`primary`): 실행 버튼과 전송·중지 원형 버튼의 배경입니다. 다크에서는 밝은 회색, 라이트에서는 거의 검정입니다. `primary-foreground`가 그 위의 글자색입니다.

### Neutral

- **Window** (`background`): 대화 영역과 앱 창의 바탕입니다. 승인 카드 안의 명령 상자도 이 색을 씁니다.
- **Sidebar** (`sidebar`): 사이드바와 오른쪽 todo·증거 패널의 바탕입니다.
- **Raised** (`surface`): 사용자 말풍선, 승인 카드, 입력창, 헤더 칩처럼 한 단계 올라온 면입니다.
- **Sunken** (`surface-sunken`): diff 블록처럼 한 단계 들어간 면입니다.
- **Hover** (`surface-hover`): 선택된 세션 행, 선택된 todo 행, 보조 버튼의 배경입니다.
- **Line** (`border`): 진행 막대의 빈 트랙에 씁니다. 영역을 나누는 테두리로는 쓰지 않습니다.
- **Ink** (`foreground`): 본문과 제목 글자색입니다.
- **Ink Muted** (`foreground-muted`): 응답 본문, 도구 호출 줄, 저장소 이름, 보조 글자색입니다.
- **Ink Subtle** (`foreground-subtle`): 입력창 안내문, 메타 정보, 아이콘의 기본색입니다.

### Status

- **Success** (`success`): 검증을 마친 todo 상태, 완료, 추가된 줄 수, 기기 연결 점에 씁니다. `success-subtle`은 추가된 diff 줄의 배경입니다.
- **Danger** (`danger`): 실패, 삭제된 줄 수입니다. `danger-subtle`은 삭제된 diff 줄의 배경입니다.
- **Warning** (`warning`): 승인 대기, 시도함, 위험도 표시입니다.

### Focus

- **Ring** (`ring`): 키보드 포커스 표시입니다. 요소 바깥에 2px 선으로 그립니다. 배경 대비는 다크 6.81:1, 라이트 4.84:1 이상입니다. 상태색이 아니므로 포커스 표시 밖에는 쓰지 않습니다.

### Named Rules

**The Status-Only Color Rule.** 상태가 없는 자리에는 색을 쓰지 않습니다. 초록, 빨강, 황색은 상태를 말할 때만 나타납니다.

**The Two-Mode Rule.** 컴포넌트는 의미 이름만 참조하고 모드별 값은 토큰 파일이 정합니다. 컴포넌트에 hex를 직접 적지 않습니다(SPEC 8.5절).

**The Ink Ceiling Rule.** 본문 글자는 `foreground`, `foreground-muted`, `foreground-subtle` 세 단계만 씁니다. 네 번째 회색을 만들지 않습니다.

## Typography

**Body Font:** Pretendard (한글 글자체)
**Mono Font:** JetBrains Mono (코드, 경로, 명령, 숫자 통계)

**Character:** 한국어를 먼저 읽는 UI이므로 Pretendard가 본문을 맡고, 코드 조각만 고정폭 글꼴로 구분합니다. 글 안의 코드 조각은 배경 없이 JetBrains Mono 13px에 `foreground` 색을 씁니다.

### Hierarchy

- **Body** (400, 15px, 24px): 사용자 말풍선과 에이전트 응답 글입니다. 응답 글은 `foreground-muted` 색입니다.
- **Input** (400, 15px, 22px): 입력창 글자입니다. 비어 있을 때는 `foreground-subtle`입니다.
- **Title** (600, 14px, 20px): 헤더의 세션 이름과 승인 카드 제목입니다.
- **Label** (500, 13px, 18px): 도구 호출 동사, 선택된 세션 이름, 버튼 글자입니다. todo 제목은 같은 크기에 줄 높이 20px입니다.
- **Body Small** (400, 13px, 18px): 사이드바 세션 이름, 저장소 이름, 보조 설명입니다.
- **Caption** (500, 12px, 16px): 헤더 칩의 단계 이름, 입력창 칩, 위험도 표시입니다.
- **Meta** (400, 12px, 16px): 세션 상태 줄, todo 출처 줄입니다. 승인 카드의 설명 글은 같은 크기에 줄 높이 18px입니다.
- **Code** (400, 13px, 18px): 도구 호출의 대상 파일, 승인 카드의 명령입니다. 명령은 줄 높이 20px입니다.
- **Code Diff** (400, 12px, 18px): diff 줄의 번호, 부호, 코드입니다.
- **Code Stat** (500, 12px, 16px): `+1 −1` 같은 줄 수 통계입니다.

### Named Rules

**The Mono-For-Machine Rule.** 파일 경로, 명령, 종료 코드, 줄 수 통계는 JetBrains Mono가 맡고, 사람이 쓴 문장은 Pretendard가 맡습니다.

## Layout

화면은 세 열입니다. 사이드바 264px, 가운데 대화 열, 오른쪽 패널 340px입니다. 가운데 열의 본문은 너비 720px로 가운데에 맞추고, 사용자 말풍선은 최대 520px입니다. 헤더 높이는 48px이고 좌우 여백은 20px입니다.

간격은 4px 단위입니다. 토큰은 `1`(4px), `2`(8px), `3`(12px), `4`(16px), `5`(20px), `6`(24px)입니다. 대화 안에서 블록 사이 간격은 `4`(16px), 도구 호출 줄 사이 간격은 `1`(4px)입니다. 이 단위에서 벗어난 간격을 쓰지 않습니다.

사이드바는 저장소 그룹 머리글(높이 28px)과 그 아래 세션 행으로 이뤄집니다. 그룹 사이 간격은 `4`(16px)입니다. 가장 아래에는 높이 32px의 기기 줄이 붙습니다.

반응형 규칙은 미정입니다. SPEC은 데스크톱 앱만 다루고 창 최소 크기를 정하지 않았습니다.

## Elevation & Depth

그림자를 쓰지 않는 평평한 시스템입니다. 깊이는 배경 밝기 층으로만 나타냅니다. 다크 기준으로 `surface-sunken`(#161616) < `sidebar`(#181818) < `background`(#1F1F1F) < `surface-hover`(#262626) < `surface`(#2A2A2A) 순서로 밝아집니다.

### Named Rules

**The Tonal Layer Rule.** 영역 구분은 테두리나 그림자가 아니라 배경 밝기로 합니다. 새 영역이 필요하면 기존 토큰 중 이웃과 한 단계 다른 값을 고릅니다.

**The Flat-By-Default Rule.** 시안에 그림자 값이 하나도 없습니다. 그림자가 필요하다는 근거가 생기기 전에는 추가하지 않습니다.

## Shapes

둥근 모서리가 기본이고 크기에 따라 네 단계입니다. `sm` 8px은 버튼, 칩, 세션 행, 헤더 칩입니다. `md` 10px은 diff 블록, 명령 상자, todo 행입니다. `lg` 14px은 승인 카드입니다. `xl` 18px은 사용자 말풍선과 입력창입니다.

원형 요소는 상태 점(6px, 8px)과 전송·중지 버튼(지름 30px), 창 조절 점(12px)입니다. 진행 막대는 높이 3px에 반경 2px이고, 이 값은 토큰에 없습니다. 테두리 선은 쓰지 않습니다.

## Components

### Sidebar 저장소 그룹과 세션 행

- **Sidebar:** 너비 264px, 배경 `sidebar`, 위 14px, 아래 12px, 좌우 8px 안쪽 여백입니다.
- **저장소 그룹 머리글:** 높이 28px, 폴더 아이콘 14px(`foreground-subtle`)과 저장소 이름(Label, `foreground-muted`)을 8px 간격으로 놓습니다.
- **세션 행:** 왼쪽 여백 32px, 오른쪽 10px, 위아래 6px, 반경 `sm`입니다. 첫 줄에 상태 점(6px)과 제목(Body Small, 말줄임)과 `+N −N` 통계(Code Stat)를 놓고, 둘째 줄에 Meta 글자로 상태를 적습니다.
- **선택된 행:** 배경이 `surface-hover`, 제목이 Label 500과 `foreground`로 바뀝니다.
- **상태 점:** 완료는 `success`, 승인 대기는 `warning`, 실패는 `danger`입니다. 상태 줄의 글자가 점의 뜻을 함께 알립니다.
- **기기 줄:** 높이 32px, 연결 점 8px, 기기 이름, 오른쪽에 추가와 설정 아이콘(16px, `foreground-subtle`)을 둡니다.

### Header 단계 표시

- **헤더:** 높이 48px, 좌우 20px. 사이드바 토글 아이콘, 세션 이름(Title), 저장소 이름(Body Small, `foreground-subtle`) 순서입니다.
- **단계 칩:** 높이 28px, 반경 `sm`, 배경 `surface`, 좌우 10px입니다. 단계 점 8개(6px, 간격 3px), 현재 단계 이름(Caption, `foreground`), `현재/8`(Meta, `foreground-subtle`)을 8px 간격으로 놓습니다.
- **단계 점:** 지난 단계는 `success`, 현재 단계는 `foreground`, 남은 단계는 `foreground-subtle`입니다. 단계는 Understand, Research, Decide, Plan, Execute, Verify, Operate, Learn 순서입니다(SPEC 2.3.2절).
- **변경 칩:** 같은 크기와 배경에 git 비교 아이콘과 `+N −N` 통계를 6px 간격으로 놓습니다.

### 사용자 말풍선

- 오른쪽 정렬, 최대 너비 520px, 배경 `surface`, 반경 `xl`(18px), 좌우 16px, 위아래 10px입니다.
- 글자는 Body 15/24, `foreground`입니다.

### 도구 호출 줄

- 높이 28px, 간격 8px의 한 줄입니다. 왼쪽에서 아이콘 15px(`foreground-subtle`), 동사(Label, `foreground-muted`), 대상(Code, `foreground-muted`), 줄 수 통계 순서입니다.
- 동사는 읽기, 수정입니다. 아이콘은 파일 읽기와 파일 수정이 다릅니다.
- 호출 줄에는 배경과 테두리가 없습니다. 펼치는 동작은 SPEC 8.2절을 따르고, 펼친 모양은 시안에 없어 미정입니다.

### Diff 블록

- 배경 `surface-sunken`, 반경 `md`(10px), 위아래 안쪽 여백 6px, 넘치는 부분은 잘라 냅니다.
- 줄 높이 22px, 좌우 12px, 간격 10px. 줄 번호(Code Diff, `foreground-subtle`), 부호, 코드(`foreground`) 순서입니다.
- 추가 줄은 배경 `success-subtle`에 부호 `success`, 삭제 줄은 `danger-subtle`에 부호 `danger`입니다. 부호 `+`와 `−`가 색과 함께 의미를 알립니다.

### 승인 카드

- 배경 `surface`, 반경 `lg`(14px), 안쪽 여백 16px, 내부 간격 12px입니다.
- 첫 줄: 방패 확인 아이콘 16px(`warning`), 제목 "이 명령을 실행할까요?"(Title), 오른쪽 끝에 위험도(Caption, `warning`)를 놓습니다.
- 명령 상자: 배경 `background`, 반경 `md`, 좌우 12px, 위아래 10px. `$ 명령`은 Code 13/20, `foreground`입니다. 작업 폴더 줄은 Code Diff 크기의 `foreground-subtle`입니다.
- 설명 글: Meta 12/18, `foreground-subtle`입니다.
- 버튼 줄: 오른쪽 정렬, 간격 8px. 거부(ghost), 이 세션 동안 허용(secondary), 실행(primary)을 놓습니다.

### 입력창과 칩

- 너비 720px, 배경 `surface`, 반경 `xl`, 위 12px, 아래 10px, 좌우 14px, 내부 간격 10px입니다.
- 안내문은 Input 15/22, `foreground-subtle`입니다. 문구는 "Ora에게 메시지, @파일, /명령"입니다.
- 아래 줄: 높이 28px. 첨부 아이콘 16px, 칩 셋(기본 모델, medium, yolo), 오른쪽 끝에 전송·중지 원형 버튼을 놓습니다.
- **칩:** 높이 26px, 반경 `sm`, 좌우 8px, 간격 4px. 글자는 Caption, `foreground-muted`입니다. 모델과 추론 강도 칩은 오른쪽에 아래 화살표 12px(`foreground-subtle`)이 붙고, 권한 칩은 방패 아이콘 14px이 앞에 붙습니다. 칩에는 배경이 없습니다.
- **전송·중지 버튼:** 지름 30px 원, 배경 `primary`, 아이콘 12px은 `primary-foreground`입니다.

### todo·증거 행

- 오른쪽 패널은 너비 340px, 배경 `sidebar`입니다. 상단 탭 줄은 높이 48px, 좌우 16px이고, 선택된 탭 "todo와 증거"는 Label 600 `foreground`, 나머지 탭(변경, 파일)은 Label 500 `foreground-subtle`입니다. 오른쪽에 `완료/전체`(Code Stat 크기, `foreground-muted`)를 놓습니다.
- 진행 막대: 높이 3px, 좌우 16px, 트랙 `border`, 채움 `success`입니다.
- 행: 반경 `md`, 안쪽 여백 10px, 간격 10px. 활성 행은 배경 `surface-hover`, 나머지는 `sidebar`입니다. 행 사이 간격은 2px입니다.
- 행 구성: 상태 아이콘 16px, 제목(13/19, 500, `foreground`), 상태 라벨(Caption)과 "출처 user·repo·model"(Meta, `foreground-subtle`), 검증 명령(Code 12px 크기, `foreground-muted`)과 결과(Code Stat 크기)를 놓습니다.
- 상태 매핑: 시도함은 점선 원과 `warning`, 검증됨은 확인 표시가 든 원과 `success`, 대기는 빈 원과 `foreground-subtle`입니다. 검증 명령이 없으면 "검증 명령을 아직 선언하지 않았습니다"를 Meta로 적습니다.
- 결과 값은 승인 대기면 `foreground-subtle`, `exit 0`이면 `success`입니다.

### 버튼 3종

- 공통: 높이 30px, 반경 `sm`, 좌우 12px, 글자 Label입니다.
- **Primary (실행):** 배경 `primary`, 글자 `primary-foreground` 600. 글자 뒤에 단축키 `↵`(JetBrains Mono 11/14, 500)를 6px 간격으로 붙입니다.
- **Secondary (이 세션 동안 허용):** 배경 `surface-hover`, 글자 `foreground` 500입니다.
- **Ghost (거부):** 배경 없음, 글자 `foreground-muted` 500입니다.
- 호버, 포커스, 눌림 상태의 모양은 시안에 없어 미정입니다. 모션은 `duration-fast` 120ms, `duration-base` 160ms, 곡선 `cubic-bezier(0.23, 1, 0.32, 1)`을 토큰 파일에서 가져옵니다.

## Do's and Don'ts

### Do:

- **Do** 영역을 나눌 때 배경 토큰 중 한 단계 다른 값을 고릅니다.
- **Do** 응답 글은 상자 없이 `foreground-muted` Body 15/24로 보여 줍니다.
- **Do** 도구 호출은 높이 28px 한 줄로 줄이고, 변경이 있으면 diff 블록을 바로 아래에 놓습니다.
- **Do** 상태를 색과 함께 아이콘이나 글자로 적습니다(SPEC 8.4절).
- **Do** 경로, 명령, 종료 코드, 줄 수는 JetBrains Mono로 씁니다.
- **Do** 두 테마를 함께 확인합니다. 토큰 이름은 같고 값만 다릅니다.

### Don't:

- **Don't** 영역 구분용 테두리 선을 긋지 않습니다. `border` 토큰은 진행 막대 트랙에만 씁니다.
- **Don't** 그림자와 그라데이션을 쓰지 않습니다.
- **Don't** 상태가 아닌 곳에 `success`, `danger`, `warning`을 쓰지 않습니다.
- **Don't** 컴포넌트에 hex 값을 직접 적지 않습니다. 토큰 파일에 없는 색이 필요하면 토큰을 먼저 추가합니다.
- **Don't** 색만으로 상태를 구분하지 않습니다.
- **Don't** 시안에 없는 컴포넌트를 이 문서에 추가하지 않습니다. 새 컴포넌트는 디자인을 먼저 그리고 승인받습니다(SPEC 8.3절).
