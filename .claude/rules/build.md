# Build & Development

## Commands

```bash
npm install          # 의존성 설치
npm run build        # TypeScript 컴파일 (tsc + prompt/persona/local 복사)
npm start            # tsx로 개발 실행
npm run dev          # watch 모드
npm run prod         # 프로덕션 실행 (빌드 필요)
npx vitest           # 테스트 실행
npx tsc --noEmit     # 타입 체크만
```

## Quality Gates

커밋 전 반드시 확인:
1. `npx tsc --noEmit` — 타입 에러 없음
2. `npx vitest run` — 테스트 전체 통과
3. `npm run build` — 빌드 성공

## Test Suite

- 테스트 프레임워크: vitest
- 설정: `vitest.config.ts`
- 테스트 파일: `src/**/*.test.ts`

## Key Config Files

| 파일 | 역할 |
|------|------|
| `mcp-servers.json` | MCP 서버 설정 |
| `.system.prompt` | 루트 시스템 프롬프트 |
| `slack-app-manifest.yaml` | Slack 앱 매니페스트 |
| `vitest.config.ts` | 테스트 설정 |
| `Dockerfile` / `docker-compose.yml` | 컨테이너 설정 |

## Runtime Data (auto-generated)

```
data/
├── user-settings.json      # 사용자별 설정
├── sessions.json           # 활성 세션
├── mcp-call-stats.json     # MCP 호출 통계
├── slack_jira_mapping.json # Slack-Jira 매핑
└── pending-forms.json      # 대기 폼
```
