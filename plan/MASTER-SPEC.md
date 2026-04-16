# [Spec] 유저 커맨드 `/z` 통합 리팩토링

**상태**: codex 96/100 리뷰 통과 + 유저 승인. **단일 PR**로 배포.

## 1. 배경

현재 soma-work Slack 봇:
- 33개 네이키드 커맨드 + 3개 slash(`/soma`, `/session`, `/new`) + 30+ 버튼
- 18가지 일관성 불일치
- 설정 변경 대부분 plain text (Block Kit은 close/plugins update 실패/report/`/session`만)
- `SlackHandler:249`가 DM 대부분 drop

## 2. 목표

1. `/z` 단일 진입점 통합 (DM/채널 멘션/slash 공통 `normalizeZInvocation()`)
2. 33개 커맨드를 `/z <topic> [verb] [args]` 문법으로 통일
3. 네이키드 즉시 절단 + 멀티워드 legacy는 tombstone 1회 힌트 (per-user)
4. `/soma` → `/z` rename. `/session`, `/new` → `/z` 흡수. **2-release cutover** (이번 PR은 Release N)
5. Block Kit 표준 UI (`buildSettingCard`) + 진입점별 응답 전략
6. 롤백 3-tier (manifest rollback 1급)

## 3. 정책 (확정)

- Q1 네이키드: **즉시 절단 + 화이트리스트 예외 + tombstone 1회**
- Q2 `/soma`: **`/z` rename**. `/session`, `/new`는 **Release N에서 병존 + tombstone**, Release N+1에서 manifest 제거
- Q3 범위: **DM + 채널 멘션 + slash 모두**
- Q4 UI 피드백: **진입점별 응답 전략** (slash/channel ephemeral → response_url, DM → chat.update)

## 4. 네이키드 화이트리스트 (유저 수정 반영)

다음은 **네이키드로도 계속 동작** + `/z` 경로도 지원:

- `session`, `sessions`, `sessions public`, `sessions terminate <key>`, `theme`, `theme set X`
- `new [prompt]`
- `renew [prompt]`
- `$`, `$model <n>`, `$verbosity <l>`, `$effort <l>`, `$thinking <l>`, `$thinking_summary <l>`

화이트리스트는 tombstone 대상에서 **제외**. 나머지 네이키드는 tombstone 표시 + Claude로 전달 안 함.

## 5. 아키텍처

### 5-1. 3-Layer 정규화

```
Entry Points
  app.message (DM)      ─┐
  app.event(app_mention)─┤ 
  app.command('/z')      ─┴── normalizeZInvocation()
                                       │
                                       ▼
                               ZInvocation { source, remainder, rawText,
                                             userId, channelId, threadTs, teamId,
                                             respond: ZRespond }
                                       │
                                       ▼
                                  ZRouter.dispatch()
                                       │
                     ┌─────────────────┼─────────────────┐
                     ▼                 ▼                 ▼
             empty remainder    legacy naked    /z <topic> parsed
                  → help       → tombstone(1회)  → topic handler
```

### 5-2. `normalizeZInvocation` 규약

```ts
type ZSource = 'dm' | 'channel_mention' | 'slash';

interface ZInvocation {
  source: ZSource;
  remainder: string;
  rawText: string;
  isLegacyNaked: boolean; // 네이키드 tombstone 대상
  whitelistedNaked: boolean; // 화이트리스트 네이키드 (session/new/renew/$)
  userId: string;
  channelId: string;
  threadTs?: string;
  teamId: string;
  respond: ZRespond;
  botMessageTs?: string;
}

// 분기 규칙
// slash: /z만 등록. text는 이미 /z 제거된 상태
// app_mention: <@BOT> strip → /z로 시작 → /z 제거
//              OR 화이트리스트 패턴 매칭 (session|new|renew|^\$) → 그대로 CommandRouter
//              OR 그 외 멀티워드 커맨드 의심 → tombstone
// DM: text.startsWith('/z ') → /z 제거, 화이트리스트 → 그대로, 그 외 → 기존 drop 경로
```

### 5-3. `ZRespond` 인터페이스

```ts
interface ZRespond {
  send(opts: { text?: string; blocks?: Block[]; ephemeral?: boolean }): Promise<{ ts?: string }>;
  replace(opts: { text?: string; blocks?: Block[] }): Promise<void>;
  dismiss(): Promise<void>;
}
```

구현체 3종:
- `SlashZRespond` — `ack()` + `respond({response_type:'ephemeral'})` / replace: `response_url + replace_original:true`
- `ChannelEphemeralZRespond` — `client.chat.postEphemeral` / replace via button action's `body.response_url + replace_original:true`
- `DmZRespond` — `client.chat.postMessage` (bot message, ts 저장) / replace: `client.chat.update({ts: botMessageTs})`

**불변식**:
- ephemeral은 절대 `chat.update`로 교체 시도 금지
- DM `chat.update`는 저장된 `botMessageTs`만 target (타입 수준 차단)
- forbidden capability 판정은 정규화된 key 비교
- `response_url` 부재/만료 시 **명시적 "UI 만료, 다시 `/z <topic>` 실행" 안내**

### 5-4. Slash Forbidden Capability

Slack slash command는 thread 실행 불가. 다음 topic×verb는 slash에서만 거부 (DM/channel은 허용):

```ts
const SLASH_FORBIDDEN = new Set<string>([
  'new', 'close', 'renew', 'context', 'restore', 'link', 'compact',
  'session:set:model',
  'session:set:verbosity',
  'session:set:effort',
  'session:set:thinking',
  'session:set:thinking_summary',
]);
```

거부 메시지: "이 명령은 스레드 컨텍스트가 필요해서 slash `/z`로 실행할 수 없습니다. 스레드에서 `@bot /z <topic>` 형식으로 실행해주세요."

## 6. DM 정책 변경 (극소 범위)

`src/slack-handler.ts:249` 현재:
```ts
if (isDm && !isCleanup) { return; } // drop
```

변경:
```ts
if (isDm && !isCleanup) {
  const trimmed = event.text?.trim() ?? '';
  // /z 시작 또는 화이트리스트 네이키드만 drop 예외
  if (trimmed.startsWith('/z') || isWhitelistedNaked(trimmed)) {
    return routeViaZ(event, 'dm');
  }
  return; // drop
}
```

그 외 DM 경로는 건드리지 않음.

## 7. 커맨드 문법 표준

- `/z <topic> [verb] [args]`
- 명사-동사 순서
- 동사 표준: `show | set | list | clear | add | remove | next`
- 디폴트 verb: 인자 없으면 `show`
- 언더스코어 금지 (공백만)
- 영어만 (한국어 별칭 제거)
- 단수 통일 (`session`, `skill`, `plugin`)

### 7-1. AS-IS → TO-BE 완전 매핑 (33개 + `$`계열)

| AS-IS | TO-BE | 네이키드 |
|---|---|---|
| `help`, `commands`, `command`, `?` | `/z help` / `/z` | ❌ 절단 |
| `show prompt` | `/z prompt` | ❌ 절단 |
| `show instructions` | `/z instructions` | ❌ 절단 |
| `show email` / `set email <x>` | `/z email` / `/z email set <x>` | ❌ 절단 |
| `persona` / `persona set <n>` / `persona list` | `/z persona` / `/z persona set <n>` / `/z persona list` | ❌ 절단 |
| `model` / `model list` / `model set <n>` / `model <n>` | `/z model` / `/z model list` / `/z model set <n>` | ❌ 절단 |
| `verbosity` / `verbosity <l>` | `/z verbosity` / `/z verbosity set <l>` | ❌ 절단 |
| `memory` / `memory clear [N]` / `memory save user <t>` | `/z memory` / `/z memory clear [N]` / `/z memory save user <t>` | ❌ 절단 |
| `bypass on/off/status` | `/z bypass` / `/z bypass set on\|off` | ❌ 절단 |
| `sandbox on/off/status` | `/z sandbox` / `/z sandbox set on\|off` | ❌ 절단 |
| `notify` / `notify on/off/telegram ...` | `/z notify` / `/z notify set on\|off` / `/z notify telegram set <token>` | ❌ 절단 |
| `webhook register <url>` | `/z webhook add <url>` / `/z webhook remove <id>` / `/z webhook test <id>` | ❌ 절단 |
| `mcp` / `mcp list` / `mcp reload` / `servers` | `/z mcp` / `/z mcp list` / `/z mcp reload` (servers 제거) | ❌ 절단 |
| `plugins add/update/...` / `플러그인 업데이트` | `/z plugin [add\|update\|...]` (한국어 제거, 단수 통일) | ❌ 절단 |
| `marketplace add/remove` | `/z marketplace` / `/z marketplace add <x>` | ❌ 절단 |
| `skills list/download` | `/z skill` / `/z skill list` / `/z skill download` | ❌ 절단 |
| `cwd` / `set directory <p>` | `/z cwd` / `/z cwd set <p>` | ❌ 절단 |
| `cct` / `set_cct <n>` / `nextcct` | `/z cct` / `/z cct set <n>` / `/z cct next` | ❌ 절단 |
| `accept @U` / `deny @U` / `users` | `/z admin accept <@U>` / `/z admin deny <@U>` / `/z admin users` | ❌ 절단 |
| `config show` / `config KEY=VAL` | `/z admin config` / `/z admin config set <KEY> <VAL>` | ❌ 절단 |
| `show llm_chat` / `set llm_chat <p> <k> <v>` / `reset llm_chat` | `/z admin llmchat` / `/z admin llmchat set <p> <k> <v>` / `/z admin llmchat reset` | ❌ 절단 |
| `onboarding [prompt]` | `/z onboarding [prompt]` | ❌ 절단 |
| `context` | `/z context` | ❌ 절단 |
| `compact` | `/z compact` | ❌ 절단 |
| `link issue\|pr\|doc <url>` | `/z link issue\|pr\|doc <url>` | ❌ 절단 |
| `close` | `/z close` | ❌ 절단 |
| `report [today\|daily\|weekly]` | `/z report` / `/z report today\|daily\|weekly` | ❌ 절단 |
| `report help` | **제거** | ❌ |
| `restore` / `credentials` | `/z restore` (credentials 제거) | ❌ 절단 |
| `all_sessions` | `/z admin session list` | ❌ 절단 |
| **`new [prompt]`** | `/z new [prompt]` | ✅ **유지** |
| **`renew [prompt]`** | `/z renew [prompt]` | ✅ **유지** |
| **`session`, `sessions`, `sessions public`, `theme [set X]`** | `/z session`, `/z session public`, `/z session theme [set X]` | ✅ **유지** |
| **`terminate\|kill\|end <key>`** | `/z session terminate <key>` (네이키드는 `sessions terminate <key>`만) | ✅ `sessions terminate`만 |
| **`$` / `$model/$verbosity/$effort/$thinking/$thinking_summary <v>`** | `/z session set <attr> <v>` (양쪽 지원) | ✅ **유지** |
| `es` | **제거** (placeholder) | ❌ |

## 8. Block Kit 표준 UI

### 8-1. 신설 파일

- `src/slack/z/normalize.ts` — `normalizeZInvocation()`
- `src/slack/z/respond.ts` — `ZRespond` 3 구현체
- `src/slack/z/router.ts` — `ZRouter`
- `src/slack/z/capability.ts` — `SLASH_FORBIDDEN` 판정
- `src/slack/z/tombstone.ts` — legacy 탐지 + hint
- `src/slack/z/whitelist.ts` — 네이키드 화이트리스트 (`session|new|renew|^\$`)
- `src/slack/z/ui-builder.ts` — `buildSettingCard`, `buildHelpCard`, `buildTombstoneCard`
- `src/slack/actions/z-settings-actions.ts` — 액션 핸들러

### 8-2. `buildSettingCard` 인터페이스

```ts
interface SettingCardOptions {
  topic: string;
  icon: string;
  title: string;
  currentLabel: string;
  currentDescription?: string;
  options: Array<{ id: string; label: string; description?: string }>;
  additionalCommands?: string[];
  showCancel?: boolean;
  issuedAt: number; // response_url TTL 관리용
}
```

Block: header + context(current) + actions(options) + divider + context(additional) + actions(cancel).

Action ID: `z_setting_<topic>_set_<value>`, `z_setting_<topic>_cancel`, `z_help_nav_<topic>`.

### 8-3. `buildTombstoneCard`

```
ℹ️ 이 명령은 더 이상 사용되지 않습니다
  이전: `persona set linus`
  신규: `/z persona set linus`
  [📋 복사] [❌ 무시]
  💡 `/z` 또는 `/z help`로 전체 명령 확인
```

`migrationHintShown` per-user 플래그 (user-settings-store, CAS/트랜잭션 보호).

### 8-4. Block Kit 이관 대상

**Phase A (이번 PR 필수)**: persona, model, verbosity, bypass, sandbox, theme (6개)
**Phase B (이번 PR 포함)**: notify, memory, cct, cwd(모달), email(모달) (5개)
**Phase C (텍스트 유지)**: context, compact, restore, close(이미 block), new, onboarding, renew, link, report, plugin, marketplace, mcp, skill, webhook, admin

## 9. 18가지 불일치 처리 (전부 명시)

| # | 불일치 | 처리 |
|---|---|---|
| 1 | 동사-명사 순서 | 명사-동사 통일 |
| 2 | `set` 필수/생략 | 변경은 항상 `set` 필수 |
| 3 | `$` prefix | **유지** (유저 수정) + `/z` 경로 병행 추가 |
| 4 | slash prefix 일관성 | `/z`만 허용 |
| 5 | 언더스코어/공백 | 공백만 |
| 6 | 복수/단수 | 단수 통일 (session/skill/plugin) |
| 7 | 한영 혼재 | 영어만 (`플러그인 업데이트` 제거) |
| 8 | terminate/kill/end | `terminate`만 (네이키드는 `sessions terminate`) |
| 9 | default subcommand | 모든 topic default = show |
| 10 | help 동의어 | `/z help`만 |
| 11 | `/session` slash 우회 | Release N: tombstone / N+1: manifest 제거 |
| 12 | session-dependent slash 차단 | SLASH_FORBIDDEN 테이블로 일관 처리 |
| 13 | 피드백 방식 혼재 | ZRespond 인터페이스 일원화 |
| 14 | model alias 모호 | `/z model set <n>`만 |
| 15 | `new`/`restore` 인자 | 각자 문법 명시 |
| 16 | COMMAND_KEYWORDS 오염 | 재작성 (실제 핸들러만 등록) |
| 17 | 파일 prefix 스타일 | 공백만 |
| 18 | `$` vs non-`$` | **병행** (유저 수정) |

## 10. 응답 전략표

| 상황 | slash `/z` | channel `@bot /z` | DM `/z` 또는 화이트리스트 |
|---|---|---|---|
| 빈 `/z` → help | `respond({ephemeral, blocks:[help]})` | `postEphemeral({blocks:[help]})` | `chat.postMessage({blocks:[help]})` |
| `/z persona` → setting card | `respond({ephemeral, blocks:[card]})` | `postEphemeral({blocks:[card]})` | `chat.postMessage({blocks:[card]})` — botMessageTs 저장 |
| 버튼 클릭 → 교체 | `response_url + replace_original:true` | `response_url + replace_original:true` | `chat.update({ts:botMessageTs, blocks:[done]})` |
| 취소 | `response_url + delete_original:true` | `response_url + delete_original:true` | `chat.delete({ts:botMessageTs})` |
| 에러 | `respond({ephemeral, text})` | `postEphemeral({text})` | `chat.postMessage({text})` |
| tombstone | N/A (slash에는 tombstone 불필요) | `postEphemeral({blocks:[tombstone]})` | `chat.postMessage({blocks:[tombstone]})` |

### 10-1. response_url 부재 fallback

```ts
if (!responseUrl) {
  await this.send({
    text: '⚠️ UI가 만료됐습니다. `/z <topic>`으로 다시 열어주세요.',
    ephemeral: true,
  });
  return;
}
```

### 10-2. postEphemeral 에러 분기

```ts
const permissionLike = ['user_not_in_channel', 'channel_not_found', 'user_not_found', 'not_in_channel'];
if (permissionLike.includes(code)) {
  return client.chat.postMessage({ channel: opts.user, ... }); // DM fallback
}
if (code === 'ratelimited' || err.status >= 500) {
  await sleep(retryAfter); return await retry(); // 1회 재시도
}
throw err;
```

## 11. 테스트 (테이블 기반 계약)

### 11-1. normalizeZInvocation
- slash/channel_mention/dm × (빈/`/z persona`/`persona set linus`(non-whitelisted)/`new`(whitelisted)/`$model opus`(whitelisted)) × 예상 remainder/isLegacy/whitelisted

### 11-2. tombstone 탐지
- `persona set linus`, `show prompt`, `help`, `model opus`, `플러그인 업데이트`, `show email` → 힌트 매칭

### 11-3. 화이트리스트 통과
- `session`, `sessions public`, `new hello`, `renew`, `$model opus` → passthrough to CommandRouter

### 11-4. slash forbidden capability
- slash × (new, close, renew, context, restore, link, compact, session set model, session set verbosity, session set effort, session set thinking, session set thinking_summary) → denied

### 11-5. 각 topic handler
- 33개 topic × (default=show, list, set, invalid) × (slash/channel/dm) → 상태 변화 + block 구조

### 11-6. ZRespond fallback
- hasResponseUrl × hasBotTs × source → 경로 분기 검증

### 11-7. 롤백 플래그
- `SOMA_ENABLE_LEGACY_SLASH=true` → legacy 재활성

### 11-8. 액션 e2e
- 버튼 클릭 × (slash/channel/dm) → replace/dismiss 동작

## 12. 롤백 3-tier

### Tier 1 (1급): Manifest Rollback
- `slack-app-manifest.prev.json` 스냅샷 커밋
- `scripts/slack-manifest-rollback.sh` — 이전 manifest 복원 가이드
- Slack app config UI/CLI로 재업로드 (plantform team 사전 공지)

### Tier 2: Runtime Flag
- `SOMA_ENABLE_LEGACY_SLASH=true` → 라우터가 `/soma`/`/session`/`/new`/`$`/naked 전부 부활
- manifest가 이미 교체된 상태에서는 부분 복구만 가능

### Tier 3: 2-Release Cutover
- **이번 PR (Release N)**: `/z` 추가 + `/soma`·`/session`·`/new` **manifest 유지** + 런타임 tombstone 치환
- **다음 Release N+1**: manifest에서 legacy slash 제거
- **Release N+2**: tombstone + flag 제거

### 문서
- `docs/ops/rollback-z-refactor.md`

## 13. 구현 단계 (단일 PR)

유저 요청에 따라 **PR 하나로 합침**. 커밋 단위로 논리 분리:

1. **commit 1: 인프라** — `normalize.ts`, `respond.ts`, `router.ts`, `capability.ts`, `whitelist.ts`, `tombstone.ts` 골격
2. **commit 2: event-router 통합** — `/z` slash 등록, `/soma` tombstone, DM 정책 변경
3. **commit 3: 화이트리스트 네이키드 경로** — session/new/renew/`$` CommandRouter 직결
4. **commit 4: 파서 재작성** — command-parser.ts 정규식 명사-동사 + set 필수, COMMAND_KEYWORDS cleanup
5. **commit 5: Block Kit 빌더** — `ui-builder.ts`, `z-settings-actions.ts`
6. **commit 6: Phase A 이관** — persona, model, verbosity, bypass, sandbox, theme
7. **commit 7: Phase B 이관** — notify, memory, cct, cwd, email
8. **commit 8: `/z help` 카드** + help-handler 교체
9. **commit 9: tombstone 플래그** — user-settings-store에 migrationHintShown + CAS
10. **commit 10: 롤백 인프라** — manifest.prev.json, rollback 스크립트, `SOMA_ENABLE_LEGACY_SLASH` 플래그
11. **commit 11: 테스트** — 테이블 계약 테스트 + e2e
12. **commit 12: 문서** — README, spec, slack-block-kit.md, rollback 문서
13. **commit 13: es 핸들러 제거** + `credentials`/`commands`/`?`/`servers` 별칭 제거

## 14. 성공 기준

- [ ] `npm test` 전체 통과 (기존 + 신규 테이블 계약)
- [ ] `/z` → help 카드 (slash/channel/dm 동일)
- [ ] `/z persona` → setting card (세 경로 모두)
- [ ] `/z persona set linus` → 변경 + ack
- [ ] `persona set linus` (naked) → tombstone 카드 (1회만)
- [ ] `session`, `new`, `renew`, `$model opus` 네이키드 → 정상 동작
- [ ] `/z session set model opus` → 동일 결과
- [ ] `/soma`/`/session`/`/new` slash → Release N에서 tombstone (manifest는 유지)
- [ ] SLASH_FORBIDDEN 12개 → slash 거부 + 안내 메시지
- [ ] `SOMA_ENABLE_LEGACY_SLASH=true` → 롤백 동작
- [ ] 18가지 불일치 전부 해소 (섹션 9 체크리스트)
- [ ] CI 통과
- [ ] codex/gemini review P0/P1 0개

## 15. 구현 가드레일 (codex 지시사항)

- forbidden capability 판정은 정규화된 capability key(`topic:verb:arg` 형태) 기준
- `response_url` 없음은 조용한 fallback 금지, **반드시 "UI 만료" 명시 안내**
- DM `chat.update` 대상은 저장된 `botMessageTs`만 — **타입 수준에서 user message ts 전달 차단**
- migrationHintShown 업데이트는 CAS or 트랜잭션 (동시성 보호)
- `block_id`는 결정론적 생성 (`z_${topic}_${issuedAt}_${index}`)

## 16. Out of Scope (명시)

- `$plugin:skill` 프롬프트 인라인 삽입 문법 변경 (커맨드 prefix `$`만 파싱, 프롬프트 인라인은 유지)
- 새 기능 추가 금지
- 봇 이름/아이덴티티 변경 금지
- Release N+1/N+2 (manifest 정리는 별도 PR)
