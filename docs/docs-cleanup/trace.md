# Docs Cleanup & Update — Vertical Trace

> STV Trace | Created: 2026-03-06
> Spec: docs/docs-cleanup/spec.md

## 목차
1. [Scenario 1 — Archive Historical Docs](#scenario-1--archive-historical-docs)
2. [Scenario 2 — Fix Global Outdated Paths](#scenario-2--fix-global-outdated-paths)
3. [Scenario 3 — Update Stale Spec References](#scenario-3--update-stale-spec-references)
4. [Scenario 4 — Update Commands Reference](#scenario-4--update-commands-reference)
5. [Scenario 5 — Update Architecture Doc](#scenario-5--update-architecture-doc)

---

## Scenario 1 — Archive Historical Docs

**Size**: small (~20 lines)

### 1.1 변경 내용

```
mkdir docs/archive/
git mv docs/srp-refactoring-plan.md → docs/archive/srp-refactoring-plan.md
git mv docs/github-auth-report.md  → docs/archive/github-auth-report.md
git mv REFACTORING_PLAN.md         → docs/archive/REFACTORING_PLAN.md
```

### 1.2 대상 파일

| Source | Destination | Reason |
|--------|-------------|--------|
| `docs/srp-refactoring-plan.md` | `docs/archive/` | 리팩토링 완료됨. LOC 수치 전부 stale (action-handlers 674→14 등) |
| `REFACTORING_PLAN.md` | `docs/archive/` | 동일 내용의 earlier version. 2024-12 작성 |
| `docs/github-auth-report.md` | `docs/archive/` | 옛 경로 `/Users/dd/dev.claude-code-slack-bot` 참조. 일회성 리포트 |

### 1.3 Invariants
- Archive 이동 후 다른 문서에서 이 파일들을 참조하는 링크 없음 (확인 완료)
- git history를 통해 언제든 접근 가능

---

## Scenario 2 — Fix Global Outdated Paths

**Size**: small (~15 lines)

### 2.1 변경 대상

| File | Old | New |
|------|-----|-----|
| `docs/spec/07-permission-system.md:248,253-254` | `claude-code-slack-bot-store` | `soma-work-store` |
| `docs/spec/09-configuration.md:365` | `com.dd.claude-slack-bot` | `ai.2lab.soma-work.{main,dev}` |
| `docs/spec/09-configuration.md:375` | `com.dd.claude-slack-bot` | `ai.2lab.soma-work.{main,dev}` |
| `docs/spec/09-configuration.md:379` | `/Users/dd/claude-code-slack-bot/dist/index.js` | `/opt/soma-work/{main,dev}/dist/index.js` |
| `docs/spec/09-configuration.md:382` | `/Users/dd/claude-code-slack-bot` | `/opt/soma-work/{main,dev}` |
| `docs/spec/09-configuration.md:389-390` | `/Users/dd/claude-code-slack-bot/logs/` | `/opt/soma-work/{main,dev}/logs/` |
| `docs/spec/09-configuration.md:476` | `claude-code-slack-bot/` | `soma-work/` |

### 2.2 검색 패턴
```
grep -r "claude-code-slack-bot" docs/  → 위 대상 확인
grep -r "/Users/dd/" docs/             → 09-configuration.md, github-auth-report.md (archived)
```

### 2.3 Invariants
- 코드(src/)에서는 이미 `soma-work-store` 사용 중 (`src/shared-store.ts:35`)
- deploy.md에 현행 경로 `/opt/soma-work/{main,dev}/` 이미 기재됨

---

## Scenario 3 — Update Stale Spec References

**Size**: medium (~50 lines)

### 3.1 docs/spec/03-session-management.md

| Line | Old | New |
|------|-----|-----|
| 5 | `Source File: src/claude-handler.ts` | `Source File: src/session-registry.ts` |
| 6 | `Last Updated: 2025-12-13` | `Last Updated: 2026-03-06` |

세션 관리 로직은 `session-registry.ts`로 추출 완료.

### 3.2 docs/spec/07-permission-system.md

| Line | Old | New |
|------|-----|-----|
| 248 | `'claude-code-slack-bot-store'` | `'soma-work-store'` |
| 253-254 | `/tmp/claude-code-slack-bot-store/` | `/tmp/soma-work-store/` |
| 6 | `Last Updated: 2025-12-13` | `Last Updated: 2026-03-06` |

### 3.3 docs/spec/08-user-settings.md

UserSettings 인터페이스에 누락된 필드 추가:

```typescript
// 현재 코드 (src/user-settings-store.ts:32-47)
export interface UserSettings {
  userId: string;
  defaultDirectory: string;
  bypassPermission: boolean;
  persona: string;
  defaultModel: ModelId;           // ← 누락
  defaultLogVerbosity?: LogVerbosity; // ← 누락
  lastUpdated: string;
  jiraAccountId?: string;
  jiraName?: string;
  slackName?: string;
  accepted: boolean;               // ← 누락 (admin-commands 기능)
  acceptedBy?: string;             // ← 누락
  acceptedAt?: string;             // ← 누락
}
```

### 3.4 docs/spec/13-slack-ui-action-panel.md

| Line | Old | New |
|------|-----|-----|
| 17 | `New: src/slack/action-panel-manager.ts` | 삭제 (존재하지 않는 파일) |

`action-panel-builder.ts`는 이미 Source Files 목록에 없으므로 추가 불필요 (thread-header-builder.ts, action-panel-builder.ts는 line 15-16에 New로 표시되어 있으나 이미 구현됨 → `New:` prefix 제거).

### 3.5 Invariants
- 모든 참조가 실제 코드의 현재 상태와 일치
- 버전 날짜가 수정일 기준으로 갱신

---

## Scenario 4 — Update Commands Reference

**Size**: medium (~50 lines)

### 4.1 현행 커맨드 목록 (command-router.ts 기준, 20개 핸들러)

```
Current (docs/spec/10-commands.md):        Missing:
─────────────────────────────               ──────────
cwd, bypass, mcp, persona,                 admin (accept/deny/users/config)
sessions, all_sessions, help,              cct / set_cct (token management)
cancel/stop/취소                            marketplace (plugin marketplace)
                                            plugins (plugin management)
                                            model (model switching)
                                            verbosity (output level)
                                            new (session reset)
                                            renew (session renew)
                                            close (session close)
                                            context (context window)
                                            link (session link)
                                            onboarding (onboarding workflow)
                                            restore (session restore)
                                            $ / $model / $verbosity (session-scoped)
```

### 4.2 변경 전략

Command Summary Table (Section 10)을 CLAUDE.md의 커맨드 테이블과 동기화.
각 신규 커맨드에 대해 간략한 설명 추가 (상세 사용법은 생략, 이미 CLAUDE.md에 기재).

### 4.3 Invariants
- command-router.ts에 등록된 모든 핸들러가 문서에 반영
- CLAUDE.md의 Slack Commands 테이블과 일치

---

## Scenario 5 — Update Architecture Doc

**Size**: medium (~50 lines)

### 5.1 LOC 갱신

| Component | Old (docs) | Current (actual) |
|-----------|-----------|-------------------|
| SlackHandler | 567 | 598 |
| ClaudeHandler | 498 | 611 |
| McpManager | 76 | 96 |

### 5.2 누락 모듈 추가

architecture.md Directory Structure에 누락된 항목:

```
src/
├── admin-utils.ts              # ← 누락 (admin command utilities)
├── credentials-manager.ts      # ← 누락 (credential management)
├── dangerous-command-filter.ts  # ← 누락 (bypass danger filter)
├── env-paths.ts                # ← 누락 (environment path resolution)
├── file-handler.ts             # ← 누락 (file handling)
├── git-cli-auth.ts             # ← 누락 (git CLI auth helper)
├── github-auth.ts              # ← 누락 (GitHub auth facade)
├── image-handler.ts            # ← 누락 (image handling)
├── mcp-call-tracker.ts         # ← 누락 (MCP call stats)
├── mcp-client.ts               # ← 누락 (MCP client)
├── permission-mcp-server.ts    # ← 누락 (permission MCP server)
├── stderr-logger.ts            # ← 누락 (stderr logging)
├── token-manager.ts            # ← 누락 (CCT token management)
├── unified-config-loader.ts    # ← 누락 (unified config loader)
├── working-directory-manager.ts # ← 누락 (working dir management)
│
├── slack/
│   ├── commands/
│   │   ├── admin-handler.ts     # ← 누락
│   │   ├── cct-handler.ts       # ← 누락
│   │   ├── marketplace-handler.ts # ← 누락
│   │   └── plugins-handler.ts   # ← 누락
│   ├── actions/
│   │   └── user-acceptance-action-handler.ts # ← 누락
│   └── formatters/
│       └── markdown-to-blocks.ts # ← 누락
│
├── plugin/                      # ← 전체 모듈 누락
│   ├── config-parser.ts
│   ├── marketplace-fetcher.ts
│   ├── plugin-cache.ts
│   ├── plugin-manager.ts
│   └── types.ts
```

### 5.3 Actions 개수 갱신

| Component | Old | Current |
|-----------|-----|---------|
| Actions/* | 8개 | 9개 (user-acceptance-action-handler 추가) |
| Commands/* | 16개 | 20개 (admin, cct, marketplace, plugins 추가) |

### 5.4 Invariants
- LOC 수치가 실제 `wc -l` 결과와 ±5 이내
- 모든 src/ 하위 모듈이 Directory Structure에 반영

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| spec 파일 버전을 2.0으로 올리지 않고 날짜만 갱신 | tiny | 버전 bumping은 컨벤션이 없음, 날짜로 충분 |
| 10-commands.md를 전면 재작성 대신 테이블 업데이트만 | small | 기존 상세 설명은 유효, 누락분만 추가 |
| architecture.md에 LOC를 정확한 값 대신 근사치 사용 | tiny | LOC는 지속 변동, 근사치로 충분 |
| docs/spec/00-overview.md ~ 06, 11, 12는 수정 불필요 | small | 탐색 결과 major stale 없음 |

## Implementation Status

| Scenario | Trace | Tests | Status |
|----------|-------|-------|--------|
| 1. Archive Historical Docs | done | N/A (docs-only) | GREEN |
| 2. Fix Global Outdated Paths | done | N/A (docs-only) | GREEN |
| 3. Update Stale Spec References | done | N/A (docs-only) | GREEN |
| 4. Update Commands Reference | done | N/A (docs-only) | GREEN |
| 5. Update Architecture Doc | done | N/A (docs-only) | GREEN |

## Next Step
→ `stv:do-work`로 시나리오별 구현 시작
→ 문서-only 변경이므로 contract test 해당 없음
