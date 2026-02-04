# Deployment

## Auto-Deploy

`dev` 브랜치에 push하면 GitHub Actions CI가 자동으로 서버에 배포.
`main` 브랜치도 동일하게 별도 인스턴스로 배포.

## Environment Variables

### Required
```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
BASE_DIRECTORY=/tmp           # 유저별 디렉토리 기준 ({BASE_DIRECTORY}/{userId}/)
```

### Optional
```env
ANTHROPIC_API_KEY=...           # Claude Code 구독 없을 때만 필요
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY="-----BEGIN RSA..."
GITHUB_INSTALLATION_ID=12345678
GITHUB_TOKEN=ghp_...            # PAT 폴백
CLAUDE_CODE_USE_BEDROCK=1
CLAUDE_CODE_USE_VERTEX=1
DEBUG=true
```

## macOS LaunchDaemon

```bash
./service.sh status|start|stop|restart|install|uninstall
./service.sh logs stderr 100    # stderr 로그
./service.sh logs follow        # 실시간 로그
```

- Service: `ai.2lab.soma-work.{main,dev}`
- Plist: `/Library/LaunchDaemons/ai.2lab.soma-work.{main,dev}.plist`
- Auto-start, Auto-restart on crash
- 서버 로그: `/opt/soma-work/{main,dev}/logs/{stdout,stderr}.log`

## Docker

```bash
docker-compose up -d          # 실행
docker-compose logs -f        # 로그
```

## Jira Mapping

```bash
npm run mapping:list   # 매핑 목록
npm run mapping:sync   # Jira에서 동기화
npm run mapping:add    # 수동 추가
```
