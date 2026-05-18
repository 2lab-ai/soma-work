# Portrait Grid Extractor — Spec

> STV Spec | Created: 2026-03-09

## 1. Overview

`assets/source/` 폴더의 2개 PNG 이미지(각 6×7 초상화 그리드)에서 개별 초상화를 크롭하여 `assets/profile/`에 저장하는 Python 스크립트.

## 2. User Stories

- As a developer, I want individual portrait images extracted from grid sheets, so that I can use them as profile icons in the bot.

## 3. Acceptance Criteria

- [ ] 2개 소스 이미지에서 총 84개 (42×2) 초상화 PNG 추출
- [ ] 초상화만 크롭 (하단 텍스트 라벨 제외, 얼굴 이미지만)
- [ ] 파일명: `{인물이름}_{col}_{row}.png` (0-indexed)
- [ ] 출력 디렉토리: `assets/profile/`
- [ ] 모든 초상화가 동일한 크기로 크롭

## 4. Scope

### In-Scope
- Python 스크립트 (`scripts/extract-portraits.py`)
- 이미지 크롭 및 저장
- 인물 이름 매핑 (이미지에 표시된 한국어 이름 사용)

### Out-of-Scope
- OCR 자동 인식 (수동 매핑)
- 이미지 리사이즈/후처리
- 봇 코드와의 통합

## 5. Architecture

### 5.1 기술 스택
- Python 3 + Pillow
- 단일 스크립트, 외부 의존성 최소

### 5.2 그리드 분석

| 항목 | 값 |
|------|-----|
| 소스 이미지 크기 | 1844 × 2304 px |
| 그리드 | 6열 × 7행 |
| 셀 크기 | ~307.3 × 329.1 px |
| 초상화 영역 | 셀 상단 ~80% (텍스트 라벨 하단 ~20% 제외) |

### 5.3 크롭 전략

1. 셀 경계 계산: `col * cell_w`, `row * cell_h`
2. 셀 내에서 초상화 영역만 크롭 (하단 텍스트 제거)
3. 정확한 초상화/텍스트 비율은 첫 번째 셀 수동 분석으로 결정

### 5.4 이름 매핑

두 개의 딕셔너리로 (row, col) → 이름 매핑:
- `WORLD_LEADERS`: bhqze6 이미지 (세계 역사 인물)
- `THREE_KINGDOMS`: yniacl 이미지 (삼국지 인물)

## 6. Non-Functional Requirements

- Performance: 1회성 스크립트, 성능 무관
- Security: 해당 없음
- Scalability: 해당 없음

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Python + Pillow | tiny | 이미지 처리 표준 도구, 이미 설치됨 |
| 수동 이름 매핑 | small | OCR보다 정확하고 84개 수준이라 수작업 가능 |
| 0-indexed x_y | tiny | 프로그래밍 관례 |
| 초상화만 크롭 (텍스트 제외) | tiny | 유저가 명시적으로 "초상화 이미지" 요청 |
| assets/profile/ 출력 | tiny | assets 하위 구조 유지 |

## 8. Open Questions

None

## 9. Next Step

→ `stv:trace`로 Vertical Trace 진행
