# Portrait Grid Extractor — Vertical Trace

> STV Trace | Created: 2026-03-09
> Spec: docs/portrait-extractor/spec.md

## Scenario 1 — Grid Cell Calculation

### 1.1 Flow

```
 extract-portraits.py
       │
       │  load source image
       ▼
 ┌─────────────────────────────────────────────────────┐
 │  Image.open(path) → img                             │
 │  cell_w = img.width / 6   (= 307.3px)              │
 │  cell_h = img.height / 7  (= 329.1px)              │
 │                                                     │
 │  For each (col, row) in 6×7 grid:                   │
 │    x1 = int(col * cell_w)                           │
 │    y1 = int(row * cell_h) + TOP_CUT                 │
 │    x2 = int((col+1) * cell_w)                       │
 │    y2 = int((row+1) * cell_h) - BOTTOM_CUT          │
 │                                                     │
 │  Constants:                                         │
 │    TOP_CUT = 30px  (텍스트 라벨 제거)                 │
 │    BOTTOM_CUT = 30px (텍스트 라벨 제거)               │
 │    Portrait size: ~307 × 269px                      │
 └─────────────────────────────────────────────────────┘
```

### 1.2 Contract Tests
| Test Name | Category | Reference |
|-----------|----------|-----------|
| test_cell_calculation | Happy Path | Scenario 1 |
| test_crop_dimensions | Contract | Scenario 1, crop size |

## Scenario 2 — Name Mapping & Batch Extraction

### 2.1 Flow

```
 For each source image:
       │
       │  lookup NAME_MAP[(image_key, row, col)]
       ▼
 ┌─────────────────────────────────────────────────────┐
 │  img.crop((x1, y1, x2, y2)) → portrait             │
 │  portrait.save(f"assets/profile/{name}_{col}_{row}.png") │
 │                                                     │
 │  Source files:                                      │
 │    bhqze6 → 세계 역사 인물 42개                      │
 │    yniacl → 삼국지 인물 42개                         │
 │                                                     │
 │  Invariants:                                        │
 │    - 총 84개 파일 생성                                │
 │    - 모든 파일 동일 크기                              │
 │    - 파일명 충돌 없음 (name_x_y로 유니크)             │
 └─────────────────────────────────────────────────────┘
```

### 2.2 Contract Tests
| Test Name | Category | Reference |
|-----------|----------|-----------|
| test_total_output_count | Invariant | 84 files |
| test_output_filenames | Contract | name_col_row.png format |
| test_uniform_size | Invariant | all same dimensions |

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| top_cut=30, bottom_cut=30 | tiny | 픽셀 분석으로 확인, 모든 셀에서 텍스트 제거됨 |
| int() 경계 계산 | tiny | 소수점 cell 크기를 정수 좌표로 변환 |
| 이름 수동 매핑 | small | AI 생성 텍스트 아티팩트로 OCR 불가 |

## Implementation Status

| Scenario | Trace | Tests | Verify | Status |
|----------|-------|-------|--------|--------|
| 1. Grid Cell Calculation | done | GREEN | Verified | Complete |
| 2. Name Mapping & Extraction | done | GREEN | Verified | Complete |

## Trace Deviations

- Image 2 (삼국지) 이름: AI 생성 텍스트가 왜곡되어 삼국지 캐릭터 이름을 수동 추론으로 매핑
  - 확실: 제갈량, 관우, 장비, 조조, 사마의, 초선, 하후돈
  - 추론: 나머지 캐릭터 (표준 삼국지 로스터 기반)

## Verified At

2026-03-09 — All 2 scenarios GREEN + Verified
- 84 files extracted (42 per source image)
- Uniform size: 307×269px
- No text labels in output
