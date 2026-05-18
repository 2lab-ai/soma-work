# server-tools MCP Security Hardening + Test Quality — Spec

> STV Spec | Created: 2026-03-27 | Parent: PR #105 (mcp-server-extraction)

## 1. Overview

PR #105에서 머지된 `server-tools-mcp-server`에 SQL injection bypass 3건, SSH command injection 1건, 위험 SQL 함수 미차단, tautological 테스트, config-builder 통합 테스트 미비 등 10건의 결함이 발견됨.

보안 취약점 패치 + RED-GREEN 테스트 재작성 + config-builder 통합 테스트 추가.

## 2. AS-IS → TO-BE

### AS-IS
- `validateReadOnlyQuery()`: 블록 코멘트를 strip한 뒤 검증 → MySQL executable comment, token glue bypass 가능
- SSH args: `service`, `since`, `until` 미검증 → 원격 쉘 injection
- `SLEEP()`, `LOAD_FILE()` 등 위험 함수 미차단
- `tail=0` → `|| 100`으로 100 반환
- 테스트: 핸들러 호출 없이 로직 재구현 (tautological)
- config-builder: server-tools wiring 테스트 없음
- `config.example.json`: server-tools 섹션 없음

### TO-BE
- `validateReadOnlyQuery()`: executable comment 감지, 원본 쿼리에서 INTO OUTFILE 검사, 위험 함수 blocklist
- SSH args: allowlist 패턴 검증 (alphanumeric + 제한된 특수문자)
- `tail`: `?? 100` (nullish coalescing)
- 테스트: export된 핸들러를 직접 호출, RED-GREEN 순서
- config-builder: `hasServerToolsConfig()` + `mcp__server-tools` 테스트
- `config.example.json`: server-tools 예제 포함

## 3. Acceptance Criteria

- [ ] MySQL executable comments (`/*!...*/`) 포함 쿼리 차단
- [ ] `INTO/**/OUTFILE` 등 comment token glue 차단
- [ ] `SLEEP`, `LOAD_FILE`, `FOR UPDATE`, `GET_LOCK`, `INTO @var` 차단
- [ ] SSH args (`service`, `since`, `until`) allowlist 검증
- [ ] `tail=0` 정확히 0 전달
- [ ] 핸들러 함수 export + 실제 핸들러 호출 테스트
- [ ] tautological 테스트 삭제/교체
- [ ] `hasServerToolsConfig()` 테스트
- [ ] `buildAllowedTools`에 `mcp__server-tools` 포함 테스트
- [ ] `config.example.json`에 server-tools 섹션 추가
- [ ] 기존 테스트 회귀 없음

## 4. Scope

### In-Scope
- `mcp-servers/server-tools/server-tools-mcp-server.ts` — 보안 패치
- `mcp-servers/server-tools/server-tools-mcp-server.test.ts` — 테스트 재작성
- `src/mcp-config-builder.test.ts` — 통합 테스트 추가
- `config.example.json` — server-tools 섹션

### Out-of-Scope
- 다른 MCP 서버 수정
- 새로운 tool 추가
- DB 종류 확장

## 5. Architecture Decisions

### AD-1: SQL Validation 전략
**결정**: Allowlist-first + blocklist 보강
- 1차: 코멘트 strip 전 executable comment 패턴 감지 → 즉시 거부
- 2차: 원본 쿼리(strip 전)에서도 INTO OUTFILE/DUMPFILE 검사
- 3차: 위험 함수 blocklist (SLEEP, LOAD_FILE, BENCHMARK, GET_LOCK)
- 4차: FOR UPDATE / LOCK IN SHARE MODE 차단

### AD-2: SSH Arg Sanitization 전략
**결정**: Allowlist 패턴
- `service`: `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$` (Docker container name spec)
- `since`/`until`: ISO 8601 또는 Docker duration format (`^\d+[smhd]?$` or ISO pattern)
- 불합격 시 throw

### AD-3: 핸들러 테스트 전략
**결정**: 핸들러 함수 export + mock 의존성으로 직접 호출
- `handleList`, `handleListService`, `handleLogs`, `handleDbQuery` export
- `child_process.execFileSync` mock으로 SSH 호출 검증
- tautological 테스트 전면 교체
