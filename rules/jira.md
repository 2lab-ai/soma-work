# Jira MCP 사용 규칙

Atlassian MCP 서버(`https://mcp.atlassian.com/v1/sse`)를 통한 Jira 조작 시 반드시 지켜야 할 규칙.

## 1. Description 필드는 반드시 Markdown 문자열

### 규칙
`editJiraIssue`와 `createJiraIssue`의 `fields.description`은 **Markdown 문자열**을 기대한다.
Atlassian MCP 서버가 내부적으로 Markdown → ADF(Atlassian Document Format) 변환을 수행한다.

### 금지
```json
// ❌ Raw ADF JSON 객체를 직접 전달하면 실패
{
  "fields": {
    "description": {
      "type": "doc",
      "version": 1,
      "content": [...]
    }
  }
}
// Error: "Failed to convert markdown to adf"
```

### 올바른 사용
```json
// ✅ Markdown 문자열로 전달
{
  "fields": {
    "description": "## 제목\n\n- 항목 1\n- 항목 2\n\n| Col A | Col B |\n|-------|-------|\n| val1 | val2 |"
  }
}
```

## 2. 기존 Description 업데이트 시 원본 보존 프로토콜

기존 이슈의 description을 수정할 때는 원본 내용이 깨지기 쉽다. 반드시 아래 절차를 따른다:

1. **`getJiraIssue`로 현재 description 전문을 조회**한다
2. **원본 구조를 정확히 재현**한 후 신규 내용을 추가한다
3. 변환 과정에서 손실되는 요소를 인지한다:
   - Jira smartlink (`<custom data-type="smartlink">`) → Markdown link `[text](url)` 로 변환됨
   - ADF 전용 노드(inlineCard, panel 등)는 Markdown에서 완벽히 재현 불가
4. **Python 스크립트로 Markdown을 생성**하면 수동 오류를 줄일 수 있다

## 3. Markdown 포맷팅 가이드

### 중첩 불릿 리스트
4스페이스 인덴테이션으로 depth를 표현한다. Jira MCP는 이를 올바르게 ADF bulletList로 변환한다.

```markdown
- Level 1
    - Level 2
        - Level 3
            - Level 4
```

### 테이블
표준 Markdown 테이블 문법을 사용한다. ADF table로 정확히 변환된다.

```markdown
| Header A | Header B |
|----------|----------|
| Cell 1   | Cell 2   |
```

### 코드 (인라인)
백틱으로 감싼다: `` `code here` ``

### 링크
표준 Markdown 링크를 사용한다. ADF inlineCard로 변환되지는 않지만, 클릭 가능한 링크로 렌더링된다.

```markdown
[MIN-44](https://insightquest.atlassian.net/browse/MIN-44)
```

### 구분선
`---`를 사용한다. ADF rule 노드로 변환된다.

### 이스케이프
Jira 렌더링에서 특수문자가 해석되지 않도록 백슬래시로 이스케이프한다:
```markdown
- 파트너\[메뉴 폴더\]
- API \*수수료 플랜 설정
```

## 4. JQL 주의사항

### 예약어 프로젝트 키
`MIN`, `MAX`, `COUNT` 등 JQL 예약어와 겹치는 프로젝트 키는 반드시 따옴표로 감싼다:

```
// ❌ 실패
project = MIN AND status = "To Do"

// ✅ 성공
project = "MIN" AND status = "To Do"
```

## 5. Cloud ID

InsightQuest Jira Cloud ID: `bf859f4f-9d43-47f3-bc6e-bf6079fbb9d6`

모든 Jira MCP 호출에 이 값을 `cloudId` 파라미터로 전달한다.
