# Soma Work - Bot Workflow Rules

## 배포 시 릴리즈 노트 자동 생성 (GitHub Issue)

develop 브랜치를 dev2 또는 stage에 배포할 때마다 아래 절차를 반드시 수행한다.

### 절차
1. 마지막 배포 태그/커밋과 현재 커밋 간 `git log --oneline` 및 `git diff --stat`를 분석
2. 운영자 체감 변경사항만 선별 (내부 리팩토링, 코드 정리, CI 설정 변경 등 제외)
3. `GucciAdminService/Config/SiteMenuStruct.yaml`의 Path 필드에서 LinkUrl 매핑
4. **GitHub Issue를 생성하여 릴리즈 노트를 기록한다** (insightquest-io/Gucci 리포)

### GitHub Issue 생성 규칙

**Issue 제목**: `[{환경}] Release Note {YYYY-MM-DD}`
- 예: `[dev2] Release Note 2026-04-09`

**Issue 라벨**: `release-note`, `{환경}` (dev2 / stage / prod)

**Issue 본문 템플릿**:
```markdown
## Release Note — {YYYY-MM-DD}

**Environment**: {dev2 | stage | prod}
**Deploy commit**: {short SHA} (`{branch}`)
**Previous deploy**: {short SHA}

### Changes

| Category | Title | Description | LinkUrl |
|----------|-------|-------------|---------|
| 🆕 New | ... | ... | /path |
| ✨ Improved | ... | ... | /path |
| 🔧 Fixed | ... | ... | /path |

### Commits included
- {commit hash} {message}
- ...

<details>
<summary>API Payload (JSON)</summary>

\`\`\`json
{AddReleaseNoteReq JSON}
\`\`\`

</details>
```

### 릴리즈 노트 항목 작성 규칙

**제목 (Title)**
- 명사형 마무리, 15자 이내
- 카테고리와 중복되는 동사 제외 (New인데 "추가" 쓰지 않음)
- 개발 용어 금지 (API, 엔드포인트, 리팩토링 등)

**설명 (Description)** - 카테고리별 패턴:
- New (0): `[메뉴 경로]에서 [무엇을] [할 수 있습니다]`
- Improved (1): `[메뉴 경로]에서 [기존 방식]이 [변경 방식]으로 변경됩니다`
- Fixed (2): `[메뉴 경로]에서 [증상] 문제를 수정했습니다`

**LinkUrl**: SiteMenuStruct.yaml의 Path 필드와 매핑

**Category**: 0=New, 1=Improved, 2=Fixed

### JSON Payload 형식
```json
{
  "ReleaseNote": {
    "Version": "YYYY.MM.DD",
    "CreatedAt": "ISO8601",
    "UpdatedAt": null,
    "Items": [
      {
        "Category": 0,
        "Title": "15자 이내 명사형",
        "Description": "카테고리별 패턴에 따른 설명",
        "LinkUrl": "/menu/path",
        "Order": 0
      }
    ]
  }
}
```

### API 연동 (네트워크 접근 가능 시)
- Endpoint: `POST /api/Internal/ReleaseNotes`
- Header: `X-API-KEY: {ADMIN_INGEST_AUTH_KEY}`
- Body: 위 JSON 형식
- 현재 네트워크 격리 상태이므로 Issue 내 JSON payload로 대체

### 선별 기준
- 포함: UI 변경, 새 기능, 설정 항목 추가/변경, 버그 수정
- 제외: 리팩토링, 코드 정리, 테스트 추가, CI/CD 변경, 내부 구조 변경, 주석 수정
