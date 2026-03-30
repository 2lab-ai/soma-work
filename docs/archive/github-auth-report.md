# GitHub 인증 현황 리포트

**생성일**: 2026-01-21
**작업 디렉토리**: `/Users/dd/dev.claude-code-slack-bot`

---

## 1. 인증 소스 요약

| 소스 | 위치 | 용도 | 현재 상태 |
|------|------|------|----------|
| **gh CLI** | `~/.config/gh/hosts.yml` | GitHub API, git credential | ✅ 정상 |
| **Git Global** | `~/.gitconfig` | 모든 repo 기본 설정 | ⚠️ 봇이 오염시킴 |
| **Git Local** | `.git/config` | 이 repo 전용 | ✅ 정상 |
| **Git System** | `/etc/gitconfig` | 시스템 전체 | ❌ 없음 |
| **macOS Keychain** | Keychain Access | credential 캐시 | ❌ 사용 안함 |
| **환경변수** | `GITHUB_TOKEN`, `GH_TOKEN` | API 인증 override | ❌ 미설정 |

---

## 2. gh CLI 인증

### 등록된 계정
```
github.com:
  ├── icedac (Active) ← 현재 사용중
  │   └── Token: gho_8Jza...
  │   └── Scopes: gist, read:org, repo, workflow
  │
  └── devinsightquest (Inactive)
      └── Token: gho_zpFN...
      └── Scopes: gist, read:org, repo, workflow
```

### 사용 방법
```bash
# 현재 계정으로 API 호출
gh api user
gh pr create
gh repo view

# 계정 전환
gh auth switch -u devinsightquest

# 토큰 직접 획득
gh auth token
```

---

## 3. Git Credential Helper 체인

Git은 credential helper를 **순서대로** 시도합니다:

```
1. [System] osxkeychain          ← /Library/Developer/.../gitconfig
2. [Global] (empty)              ← ~/.gitconfig (override용)
3. [Global] gh auth git-credential ← ~/.gitconfig
4. [Local]  (empty)              ← .git/config (override용)
5. [Local]  gh auth git-credential ← .git/config
```

**현재 동작**: empty helper가 먼저 나와서 osxkeychain을 skip하고, `gh auth git-credential`이 인증 처리

---

## 4. 문제: 봇의 Global Config 오염

### 원인
`src/github/git-credentials-manager.ts`에서 GitHub App 토큰을 global git config에 주입:

```typescript
// 이 코드가 문제
execSync(`git config --global url."https://x-access-token:${token}@github.com/".insteadOf "https://github.com/"`)
execSync(`git config --global credential.https://github.com.username ${token}`)
```

### 증상
```bash
# 봇 실행 후 global config에 추가됨:
url.https://x-access-token:ghs_XXX@github.com/.insteadof=https://github.com/
credential.https://github.com.username=ghs_XXX
```

### 영향
- **모든 git 작업**이 봇의 GitHub App 토큰을 사용하게 됨
- 개인 `gh auth`가 무시됨
- 토큰 만료 시 모든 git push 실패

### 해결책
봇 코드 수정 필요:
```typescript
// 방법 1: 환경변수 사용 (권장)
process.env.GIT_ASKPASS = '/path/to/token-helper.sh'

// 방법 2: local config만 사용
execSync(`git config --local ...`)

// 방법 3: GIT_CONFIG_GLOBAL override
process.env.GIT_CONFIG_GLOBAL = '/path/to/bot-specific-gitconfig'
```

---

## 5. 현재 사용 가능한 인증

### ✅ Claude Code에서 사용 가능

| 작업 | 명령어 | 인증 |
|------|--------|------|
| git push | `git push` | gh auth (icedac) |
| PR 생성 | `gh pr create` | gh auth (icedac) |
| PR 수정 | `gh pr edit` | gh auth (icedac) |
| Issue 생성 | `gh issue create` | gh auth (icedac) |
| API 호출 | `gh api ...` | gh auth (icedac) |

### ⚠️ 주의사항

1. **봇 재시작 후** global config가 다시 오염될 수 있음
2. **정리 명령어** (필요시):
   ```bash
   git config --global --unset credential.https://github.com.username
   git config --global --unset-all "url.https://x-access-token:*.insteadof"
   ```

---

## 6. 권장 설정

### ~/.gitconfig (Global)
```ini
[credential "https://github.com"]
    helper =
    helper = !/opt/homebrew/bin/gh auth git-credential

[credential "https://gist.github.com"]
    helper =
    helper = !/opt/homebrew/bin/gh auth git-credential
```

### .git/config (Local) - 이미 설정됨
```ini
[credential]
    helper =
    helper = !gh auth git-credential
```

---

## 7. 인증 흐름 다이어그램

```
┌─────────────────────────────────────────────────────────────┐
│                      git push                                │
└─────────────────────┬───────────────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  Credential Helper Chain                                     │
│  ┌─────────────────┐                                        │
│  │ 1. osxkeychain  │ ──► SKIP (empty helper로 무력화)       │
│  └─────────────────┘                                        │
│  ┌─────────────────┐                                        │
│  │ 2. gh auth      │ ──► ~/.config/gh/hosts.yml 참조        │
│  └────────┬────────┘                                        │
└───────────┼─────────────────────────────────────────────────┘
            ▼
┌─────────────────────────────────────────────────────────────┐
│  gh hosts.yml                                                │
│  ┌─────────────────────────────────────────────┐            │
│  │ user: icedac                                │            │
│  │ oauth_token: gho_8Jza...                    │            │
│  └─────────────────────────────────────────────┘            │
└─────────────────────┬───────────────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  GitHub API                                                  │
│  Authorization: token gho_8Jza...                           │
│  User: icedac                                                │
└─────────────────────────────────────────────────────────────┘
```

---

## 8. 빠른 참조

```bash
# 현재 인증 상태 확인
gh auth status

# Git credential helper 확인
git config --show-origin --get-all credential.helper

# Global config 오염 확인
git config --global --list | grep -E "(url.*insteadof|credential.*username)"

# 오염 정리
git config --global --unset credential.https://github.com.username
git config --global --unset-all "url.https://x-access-token:*"

# Push 테스트
git push --dry-run
```
