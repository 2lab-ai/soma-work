# 인증 규칙 — 단일 경로 원칙

## 절대 규칙

**모든 Claude API 호출은 Agent SDK (`@anthropic-ai/claude-agent-sdk`) 의 `query()` 함수만 사용한다.**

- `@anthropic-ai/sdk` (Anthropic SDK 직접 호출) 금지
- `ANTHROPIC_API_KEY` 기반 인증 코드 신규 생성 금지
- `new Anthropic(...)` 클라이언트 생성 금지

## 인증 흐름

```
OAuth (CLAUDE_CODE_OAUTH_TOKEN)
  └─> credentials-manager.ts (검증/복구)
       └─> @anthropic-ai/claude-agent-sdk query() (유일한 호출 경로)
```

## 적용 범위

| 용도 | 방식 | 비고 |
|------|------|------|
| 메인 대화 (streamQuery) | Agent SDK `query()` | claude-handler.ts |
| 디스패치 분류 | Agent SDK `query()` | claude-handler.ts `dispatchOneShot` |
| 요약 (summarizer) | Agent SDK `query()` | conversation/summarizer.ts |
| 제목 생성 (title-generator) | Agent SDK `query()` | conversation/title-generator.ts |

## 새 기능 추가 시

LLM 호출이 필요하면:
1. `ensureValidCredentials()` 로 자격증명 검증
2. `query({ prompt, options })` 로 호출
3. `Options.maxTurns = 1`, `tools = []` 로 one-shot 구성

**절대로 별도의 Anthropic SDK 클라이언트를 만들지 마라.**
