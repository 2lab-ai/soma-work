# Sandbox gh CLI TLS Fix

Claude Code 샌드박스 환경에서 `gh` (및 다른 Go 기반 CLI)가 TLS 인증서 검증에
실패하는 증상과 그 해결책. 2026-04-16 기준 업스트림(Anthropic) 픽스 없음 →
유저 사이드 우회 확정.

## 증상

```
$ gh auth status
X Failed to log in to github.com using token ...
  - The token in ... is invalid.

$ gh api user
Get "https://api.github.com/user": tls: failed to verify certificate:
x509: OSStatus -26276
```

- 토큰은 **유효**하다. `curl -H "Authorization: token $(gh auth token)" ...`은 정상 동작.
- `openssl s_client -proxy localhost:<proxy> ...`도 진짜 GitHub cert(Sectigo 발행) 수신 확인.
- 오직 `gh` (Go 바이너리)만 실패.

## 근본 원인

`OSStatus -26276` = `errSecInvalidExtendedKeyUsage` (Apple Security.framework).

`gh`는 Go로 컴파일되어 있고, macOS에서는 Go의 `crypto/x509`가 **cgo를 통해
`Security.framework`의 `SecTrustEvaluateWithError()`를 직접 호출**한다.
Claude Code의 macOS 샌드박스 프로파일은 `com.apple.trustd` Mach IPC 서비스
lookup을 차단한다. 그 결과 trust evaluation이 실패.

- DNS 실패 아님 (에러 메시지가 TLS 단계).
- MITM 아님 (openssl로 실제 Sectigo 서명 확인됨).
- 토큰/권한 문제 아님 (동일 토큰으로 curl은 동작).

이건 macOS 샌드박스 내부의 trustd 경로 차단만의 문제다.

## 왜 env 변수로 못 고치는가

macOS에서 Go가 `Security.framework`를 직접 사용하므로, Linux/BSD용 env 변수
들은 전부 무시된다:

| 환경변수 | macOS에서 동작? |
|---|---|
| `SSL_CERT_FILE` | 무시 |
| `SSL_CERT_DIR` | 무시 |
| `GODEBUG=x509usefallbackroots=1` 단독 | 무시 (fallback roots 임포트 없으면 빈 풀) |
| `CGO_ENABLED=0` 재빌드 | 부분 동작. 아래 방법이 더 정확 |

## 업스트림 이슈 현황 (참고)

- `#23416` — 샌드박스가 Security.framework syscall 막음. **Open**.
- `#26466` — 샌드박스 꺼도 프록시가 MITM. **Open**.
- `#29533` — trustd IPC 차단 확정. **Open**.
- `#34876` — 가장 정확한 기술 분석. **Closed (not planned)**.
- `#36363` — `excludedCommands`도 프록시 못 피함. **Closed (duplicate)**.

요약: 4개월째 공식 픽스 없음. 단기 해결 기대 불가.

## 해결책: fallback roots 임베디드 빌드

`golang.org/x/crypto/x509roots/fallback`을 `gh` 소스에 blank import로 추가해
재빌드. 이 패키지는 Mozilla NSS CA 번들을 바이너리에 임베드하고, 런타임에
`GODEBUG=x509usefallbackroots=1`을 주면 Go가 **순수 Go 검증기 + 임베디드 CA**
경로로 동작한다. `Security.framework`를 완전히 우회.

본 환경은 프록시가 MITM하지 않고 단순 CONNECT tunnel이므로 실제 GitHub
cert가 그대로 도착 → fallback NSS bundle의 Sectigo 루트로 검증 성공.

> **주의**: 만약 프록시가 TLS MITM을 한다면(본 환경 아님) 이 방법만으로는
> 해결 안 됨. 프록시 CA를 fallback 번들에 추가로 임베드하거나
> `NO_PROXY`로 `api.github.com` 등을 예외 처리해야 한다.

## 빌드 & 설치

스크립트: `scripts/build-gh-fallback.sh`

```bash
./scripts/build-gh-fallback.sh
```

스크립트가 하는 일:

1. 최신 `cli/cli` 릴리스 태그 감지 후 shallow clone.
2. `cmd/gh/fallback_roots.go` 생성해 `_ "golang.org/x/crypto/x509roots/fallback"`
   blank import 추가.
3. `go get` + `go mod tidy`.
4. `-trimpath` + 버전 ldflags로 `~/.local/bin/gh`에 빌드.
5. Smoke test로 `gh --version`, `gh api user` 검증.

빌드 후 확인:

```
$ ~/.local/bin/gh --version
gh version 2.89.0+fallback (2026-04-16T...)

$ GODEBUG=x509usefallbackroots=1 ~/.local/bin/gh api user -q .login
icedac
```

## PATH 우선순위 확보

Claude Code의 비인터랙티브 bash는 `~/.local/bin`을 PATH에 포함하지 않는다.
Homebrew의 `gh`가 먼저 잡혀 원래 문제가 재현된다. 두 가지 접근이 있다.

**방법 A — Homebrew 심볼릭 링크 wrapper로 교체 (현재 적용)**

`/opt/homebrew/bin/gh`는 심볼릭 링크이고 디렉토리가 쓰기 가능하므로, 링크를
제거하고 같은 자리에 wrapper 스크립트를 둔다:

```bash
#!/usr/bin/env bash
exec env GODEBUG=x509usefallbackroots=1 "$HOME/.local/bin/gh" "$@"
```

이 방식의 장점:
- 모든 쉘 환경(인터랙티브/비인터랙티브 불문)에서 일관되게 fallback 빌드 사용.
- Claude Code bash 포함해 `which gh` → wrapper.

단점 및 주의:
- `brew upgrade gh` 시 wrapper가 원본 심볼릭 링크로 덮이므로 재설치 필요.
- Homebrew 관리 대상을 유저 수정으로 덮는 구조라 추적이 어려울 수 있음.

**방법 B — shell rc alias (유저 인터랙티브 쉘 전용)**

```bash
export PATH="$HOME/.local/bin:$PATH"
alias gh='GODEBUG=x509usefallbackroots=1 $HOME/.local/bin/gh'
```

Claude Code 비인터랙티브 bash에는 적용 안 됨.

권장: **방법 A를 기본**으로 사용하고, 유저 쉘엔 선택적으로 방법 B를 병행.

## 검증

```bash
which gh
# /opt/homebrew/bin/gh  (wrapper)

gh --version
# gh version 2.89.0+fallback (...)

gh auth status
# ✓ Logged in to github.com account icedac ...

gh api user -q .login
# icedac
```

## 실패 후보 레시피 (시도하지 말 것)

- `SSL_CERT_FILE=/etc/ssl/cert.pem gh ...` — macOS에선 무반응
- `SSL_CERT_DIR` — 동일
- `GODEBUG=x509usefallbackroots=1` 단독 (fallback 임포트 없는 스톡 gh) — 빈 풀
- `CGO_ENABLED=0`로만 재빌드 — 동작하지만 fallback roots 방식이 더 정확
- `dangerouslyDisableSandbox: true` — 자동화 루프에서 승인 프롬프트로 깨짐
- macOS login keychain에 프록시 CA 주입 — 전역 트러스트 변조, 보안상 금지

## 후속 과제

- [ ] `scripts/build-gh-fallback.sh` 리포 반영 + Makefile target
- [ ] `brew upgrade gh` 후 wrapper 복구 자동화 (brew post-install hook 또는 cron)
- [ ] `terraform`, `kubectl`, `helm` 등 다른 Go CLI에도 동일 패턴 필요 시 검토
- [ ] 업스트림 `#34876` 재오픈 여부 모니터링

## 참고

- Apple Security `errSecInvalidExtendedKeyUsage` (-26276): `Security/SecBase.h`
- Go x509 on darwin: `src/crypto/x509/root_darwin.go`
- `golang.org/x/crypto/x509roots/fallback`: Mozilla NSS 루트 번들 임베디드
- `GODEBUG` 키: `x509usefallbackroots=1` (fallback 풀 활성화)

검색 키워드 (영문):

- `"OSStatus -26276" golang macOS cgo Security.framework`
- `"tls: failed to verify certificate: x509: OSStatus -26276"`
- `go crypto/x509 darwin SecTrustEvaluateWithError sandbox`
- `gh cli macOS corporate proxy TLS verify fail`
