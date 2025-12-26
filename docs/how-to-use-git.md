# Git/GitHub 인증 방식 가이드

이 프로젝트에서 Git/GitHub 작업 시 3가지 인증 방식이 사용됨. 각각의 용도와 제한사항을 명확히 구분해야 함.

## 1. MCP GitHub (GitHub App 인증)

### 인증 방식
- GitHub App Installation Token (`ghs_*`)
- `mcp-servers.json`의 github 서버에서 사용

### 용도
- PR 생성, 리뷰, 코멘트
- 파일 읽기/쓰기 (get_file_contents, create_or_update_file)
- Branch 생성/삭제
- Issue 관리

### 제한사항
- **`.github/workflows/*` 파일 수정 불가** - GitHub App은 `workflows` 권한을 가질 수 없음
- API rate limit: 5000 requests/hour per installation

### 사용 예시
```
MCP: github → create_pull_request
MCP: github → get_file_contents
MCP: github → create_branch
```

---

## 2. gh CLI (GitHub CLI)

### 인증 방식
- `gh auth login`으로 설정된 OAuth 토큰 또는 PAT
- `~/.config/gh/hosts.yml`에 저장됨

### 용도
- PR 생성/관리 (`gh pr create`, `gh pr merge`)
- Issue 관리 (`gh issue create`)
- API 직접 호출 (`gh api`)
- **workflow 파일이 포함된 PR 생성 가능** (PAT에 `workflow` scope가 있는 경우)

### 확인 방법
```bash
gh auth status
```

### 사용 예시
```bash
# PR 생성 (workflow 파일 포함 가능)
gh pr create --title "title" --body "body"

# API 호출
gh api repos/{owner}/{repo}/pulls
```

---

## 3. Git 로컬 인증 (git CLI)

### 인증 방식
- `GitCredentialsManager`가 GitHub App 토큰을 주입
- `~/.git-credentials` 파일에 저장
- git config의 `url.*.insteadOf` 규칙으로 적용

### 현재 설정
```bash
# ~/.git-credentials
https://x-access-token:{ghs_token}@github.com

# git config
url.https://x-access-token:{ghs_token}@github.com/.insteadOf=https://github.com/
```

### 용도
- `git clone`, `git fetch`, `git pull`
- `git push` (일반 파일)
- `git commit` (로컬)

### 제한사항
- **`.github/workflows/*` 파일 push 불가** - GitHub App 토큰 사용 중이므로
- 토큰 만료 시 자동 갱신됨 (`TokenRefreshScheduler`)

### 확인 방법
```bash
git remote -v
# origin https://x-access-token:ghs_*@github.com/org/repo.git
```

---

## 상황별 사용 가이드

| 작업 | 권장 방식 | 이유 |
|------|----------|------|
| 일반 파일 push | Git 로컬 (3) | 자동 인증됨 |
| PR 생성 (일반 파일) | MCP GitHub (1) | API로 직접 생성 |
| PR 생성 (workflow 포함) | gh CLI (2) | workflow 권한 필요 |
| 파일 내용 읽기 | MCP GitHub (1) | 빠름, rate limit 여유 |
| 리뷰 코멘트 | MCP GitHub (1) | API 직접 호출 |

---

## GitHub App의 Workflows 권한 제한 (중요)

### GitHub App은 `workflows` 권한을 가질 수 없음

이건 GitHub App 설정 문제가 아니라 **GitHub 정책적 제한**임. GitHub App permissions 목록에 `workflows` scope 자체가 존재하지 않음.

| 권한 | GitHub App | PAT (Personal Access Token) |
|------|------------|-----|
| Contents (파일 읽기/쓰기) | ✅ 가능 | ✅ 가능 |
| Actions (workflow 실행 관리) | ✅ 가능 | ✅ 가능 |
| **Workflows (workflow 파일 수정)** | ❌ 불가능 | ✅ 가능 |

### 왜 막아놨나?

보안상 의도적으로 차단:
- `.github/workflows/*` 파일은 CI/CD 파이프라인을 정의
- 악의적인 앱이 workflow 수정 → secrets 탈취, 악성코드 실행 가능
- GitHub가 이 공격 벡터를 원천 차단

### 결론

GitHub App에 아무리 권한을 추가해도 workflow 파일은 수정 불가. PAT 또는 gh CLI 사용 필수.

---

## Workflow 파일 수정이 필요한 경우

GitHub App 토큰으로는 `.github/workflows/*` 파일을 push할 수 없음. 다음 방법 중 하나 사용:

### Option A: gh CLI 사용
```bash
# gh auth의 토큰 사용
cd /path/to/repo
git remote set-url origin https://github.com/org/repo.git
gh auth setup-git  # gh 토큰을 git에 연결
git push origin branch-name
```

### Option B: 수동 처리 요청
workflow 파일 변경이 필요한 경우 사용자에게 직접 push 요청:
```
GitHub App 권한 제한으로 workflow 파일 push 불가.
다음 명령어로 직접 push 필요:
  git push origin {branch-name}
```

### Option C: GitHub Web UI
1. GitHub 웹에서 직접 파일 편집
2. "Create a new branch" 선택 후 PR 생성

---

## 관련 코드

| 파일 | 역할 |
|------|------|
| `src/github/git-credentials-manager.ts` | Git 로컬 인증 관리 |
| `src/github/token-refresh-scheduler.ts` | GitHub App 토큰 자동 갱신 |
| `src/github/api-client.ts` | GitHub API 클라이언트 |
| `mcp-servers.json` | MCP GitHub 서버 설정 |

---

## 에러 메시지 해석

### "refusing to allow a GitHub App to create or update workflow"
```
! [remote rejected] branch -> branch (refusing to allow a GitHub App to create or update workflow `.github/workflows/xxx.yml` without `workflows` permission)
```
**원인**: GitHub App 토큰으로 workflow 파일 push 시도
**해결**: gh CLI 또는 수동 push 필요

### "Permission denied (publickey)"
```
git@github.com: Permission denied (publickey).
```
**원인**: SSH 키 미설정 상태에서 SSH URL 사용
**해결**: HTTPS URL 사용 (`git clone https://...`)
