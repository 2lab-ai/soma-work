# 27 — 작업 세션의 변경점: 아키텍처

Status: in-progress · Date: 2026-11-16 · 기준 main `ab7597d9` · 스펙 = [`26`](26-session-code-changes-spec.md)

요약: 턴이 끝나면 데몬이 세션 폴더의 git 체크아웃과 세션이 만든 PR을 읽어 스냅샷 하나를 만든다. 패치는 대화별 파일에, 요약은 세션에 둔다. 대시보드 탭 · 뷰어 · 통계 · 모델은 모두 이 스냅샷만 읽는다.

## 0. 미니맵

```
27 아키텍처
├─ 1. 흐름           ─ 턴 끝 → 수집기 → 저장 → (탭 · 통계 · 모델)
├─ 2. 모듈 배치
├─ 3. 데이터          ─ 저장 문서 · 세션 요약
├─ 4. 수집            ─ 체크아웃 찾기 · 네 층 계산 · PR · 예산
├─ 5. 안전            ─ 세션 폴더의 git을 데몬이 돌린다 — 무엇을 막는가
├─ 6. API · 화면
├─ 7. 통계 · 모델 배선
└─ 8. 작업 단위 (WU) · 게이트
```

## 1. 흐름

```
stream-executor 턴 끝 (finally)
  ├─ reconcileSessionPrs        (#833, 그대로)
  └─ snapshotCodeChanges ──► CodeChangesCollector (세션당 하나씩, 최소 간격 15 s, 3 s 늦춰 PR 기록을 기다림)
                               ├─ 체크아웃 스캔 (세션 폴더 · 자식 · worktree)
                               ├─ git: 커밋 안 함 · 커밋함 · 새 커밋(reflog)
                               ├─ GitHub: 세션 PR의 상세 · 파일
                               ▼
                         CodeChangesStore  DATA_DIR/code-changes/<conversationId>.json  (atomicWriteJson + .bak)
                               ├─► session.codeChanges (요약, 영속) ─► GET_SESSION · 턴 컨텍스트 한 줄
                               ├─► metrics: merge_lines_added · commit_created · code_lines_added (결정적 id)
                               └─► 카드 푸시 (KanbanSession.codeChangesAt) ─► 열린 탭이 다시 읽음
대시보드  GET /api/dashboard/session/:cid/changes[?refresh=1]      ─► 목록 (패치 없음)
          GET /api/dashboard/session/:cid/changes/file?repo=&path=  ─► 그 파일의 층별 패치
주기     PR sweeper (10분) — 14일 안의 저장 문서 중 열린 PR만 GitHub 상세로 다시 확인
```

## 2. 모듈 배치

| 파일 | 역할 |
|---|---|
| `src/code-changes/types.ts` | 저장 문서 · 요약 타입 |
| `src/code-changes/git-diff-parse.ts` | `git diff` 출력 → 파일별 패치, `--numstat -z` 파싱, 새 파일 합성 패치 (순수) |
| `src/code-changes/git-runner.ts` | 굳힌 git 실행기(§5) + 설정 게이트 |
| `src/code-changes/checkout-changes.ts` | 체크아웃 하나의 커밋 안 함 · 커밋함 · 새 커밋 |
| `src/code-changes/pr-changes.ts` | GitHub PR 상세 · 파일 (토큰은 `link-metadata-fetcher`의 `getGitHubToken`) |
| `src/code-changes/collector.ts` | 세션 하나 수집 · 요약 · 지표 · 스케줄(세션당 직렬, 최소 간격) · sweeper |
| `src/code-changes/store.ts` | 대화별 문서 읽기/쓰기 |
| `src/conversation/code-changes-routes.ts` | 두 라우트, 권한 = 작업 로그 |
| `src/conversation/code-changes-client.ts` | 탭 · 트리 · 뷰어 클라이언트 JS(`String.raw`) + CSS |
| `src/session-pr-reconciler.ts` | 체크아웃 후보 찾기(`listCheckoutDirs`)를 꺼내 두 소비자가 공유 |

## 3. 데이터

```ts
type ChangeLayer = 'uncommitted' | 'committed' | 'pr' | 'merged';
interface ChangedFile { path; oldPath?; status: 'added'|'modified'|'deleted'|'renamed'; additions; deletions; binary?: true;
                        patch?: string; patchTruncated?: true }   // 목록 응답에는 patch 없음
interface LayerFiles { files: ChangedFile[]; additions; deletions; truncated?: true }
interface CheckoutChanges { id; repo /* owner/name | local:<폴더> */; dir /* 세션 폴더 기준 */; branch?; head?;
                            uncommitted: LayerFiles & { skipped?: string }; committed: LayerFiles & { base?; commits: CommitRef[] } }
interface PrChanges { id /* owner/name#n */; url; repo; number; title?; state: 'open'|'draft'|'merged'|'closed';
                      additions; deletions; changedFiles; headRef?; headSha?; createdAt?; mergedAt?; files: ChangedFile[];
                      filesTruncated?: true; fetchedAt }
interface CodeChangesDoc { version: 1; conversationId; owner: { id; name }; sessionStartedAt?; updatedAt;
                           checkouts: CheckoutChanges[]; prs: PrChanges[]; counted: { commits: string[] } }
interface CodeChangesSummary { updatedAt; layers: Record<ChangeLayer, { files; additions; deletions }>;
                               repos: Array<{ repo; dir?; uncommitted; committed; paths: string[] /* ≤ 8 */ }>;
                               prs: Array<{ url; number; repo; state; additions; deletions; changedFiles }> }
```

예산: 체크아웃 ≤ 20, 층마다 파일 ≤ 1,000(넘으면 `truncated`), 파일 패치 ≤ 256 KiB(넘으면 자르고 `patchTruncated`),
문서의 패치 합 ≤ 6 MiB(넘으면 뒤 파일부터 패치를 뺀다), 새 파일 내용 ≤ 256 KiB 읽기, PR ≤ 20, PR 파일 ≤ 300(3쪽).

## 4. 수집

체크아웃 — `listCheckoutDirs(sessionDirs(session))`: 세션 폴더와 그 바로 아래, 그들이 `git worktree list`로 내놓는 세션 폴더 안
worktree. 브랜치 · 원격 조건 없이 전부(재조정기는 여기에 자기 조건을 그대로 얹는다).

커밋 안 함 — git은 작업 트리 파일의 내용을 읽지 않는다(§5, #1299 리뷰의 검사/사용 경쟁):
1. `git ls-tree -r -z -l HEAD`(객체 읽기)로 추적 파일의 blob id · 크기.
2. 파일마다 이 프로세스가 lstat → 크기가 다르면 바뀜, 같으면 바이트의 git blob id(sha1 · sha256)를 계산해 비교. 같다고 확인한 파일은 stat(크기 · mtime · inode)로 기억해 다음엔 읽지 않는다. 없으면 삭제, 심볼릭 링크는 따라가지 않고 링크 대상 문자열을 비교, 실경로가 체크아웃 밖(부모 폴더가 링크)이면 읽지 않는다.
3. 바뀐 파일의 패치 = `git cat-file blob`(객체 읽기)과 파일 바이트의 줄 diff(`lineDiff`, Myers, 문맥 3줄). 줄 끝만 다르면 바뀌지 않은 것으로 본다.
4. 새 파일 = 인덱스에만 있는 것(`ls-files --cached` − HEAD) + 추적 안 하는 것(`ls-files --others --exclude-standard`, 이름만). lstat 일반 파일 + 실경로가 체크아웃 안일 때만 읽고, 앞 8 KiB에 NUL이면 바이너리, 내용으로 `@@ -0,0 +1,N @@` 패치(패치도 256 KiB로 자름).
5. 이름 바꾸기는 찾지 않는다(삭제 + 추가로 보인다).

커밋함:
1. base 후보 — 이 체크아웃 브랜치를 head로 하는 세션 PR의 head sha가 HEAD의 조상이면 그것(여럿이면 가장 최근).
2. 아니면 `refs/remotes/origin/HEAD` → `origin/main` → `origin/master` 중 처음 있는 것과의 `merge-base`.
3. 원격 참조가 없으면 `rev-list --since=<세션 시작> HEAD`의 가장 오래된 커밋의 부모(루트면 빈 트리).
4. 기준점이 세션 PR head가 아니면, base..HEAD의 첫 부모 줄에서 세션 시작 전에 만든 가장 최근 커밋(base의 자손)으로 base를 올린다 — 세션 전 브랜치 작업은 세지 않고, 옆 줄에서 merge로 들어온 옛 커밋이 기준점이 되지 않는다.
5. `git log base..HEAD -n 50`(커밋 목록) + `git diff base HEAD -M`(numstat · 패치).

새 커밋(통계) — `git log -g --date=unix --format=%H%x1f%gs%x1f%gd HEAD -n 300`에서 reflog 시각이 세션 시작 이후이고 제목이
`commit`(`commit:`, `commit (amend):`, `commit (initial):`, `commit (merge):`)으로 시작하는 것. 아직 `counted.commits`에 없는 것만
`git show --numstat --format= <sha>`로 줄 수를 세 지표로 보낸다.

PR — 세션의 PR 링크(현재 + 기록) 중 GitHub URL만, 최대 20. 저장본에 같은 head sha의 머지 · 닫힘 기록이 있으면 다시 묻지 않는다(바뀌지 않는다).
그 밖에는 `GET pulls/{n}`(상태 · 크기 · head · 생성/머지 시각) → 생성 시각이 세션 시작 − 2분 이후일 때만 `GET pulls/{n}/files`.
실패한 PR은 저장본의 이전 기록을 그대로 둔다.

스케줄 — 세션 키마다 한 번에 하나, 같은 세션은 15초 안에 다시 돌지 않고(뒤 요청은 한 번으로 합쳐 늦게), 전체 동시 실행 ≤ 2.
`refresh=1`은 같은 큐를 탄다. 실패는 로그만 남기고 이전 저장본을 지우지 않는다.

## 5. 안전 — 데몬이 세션 폴더의 git을 돌린다

세션 폴더의 저장소 설정은 모델이 쓸 수 있다. 데몬이 거기서 git을 돌리면 설정이 부르는 명령이 샌드박스 밖에서 돌고, 설정 · 포인터가 가리키는 다른 곳(다른 유저의 폴더)을 읽게 된다(23 ESC 계열과 같은 종류). 막는 것:

- env: 재조정기의 `GIT_ENV`(전역 · 시스템 설정 없음, 토큰 없음) + `GIT_OPTIONAL_LOCKS=0`(status가 인덱스를 쓰지 않음) + `GIT_PAGER=cat`.
- **검사에 기대지 않는 것(모든 호출, 그때 설정이 무엇이든)**: git은 작업 트리 파일 내용을 읽지 않는다(커밋 안 함 층은 이 프로세스가 비교 — §4)
  → clean filter · textconv가 돌 자리가 없다. 명령줄 `-c`가 저장소 설정을 이긴다: `core.fsmonitor=false core.hooksPath=/dev/null diff.external=
  core.untrackedCache=false log.showSignature=false protocol.allow=never gc.auto=0 maintenance.auto=false` + `--no-pager`, env `GIT_NO_LAZY_FETCH=1`
  (부분 클론의 lazy fetch가 원격 전송 명령을 부르지 않게). diff는 두 커밋 사이만, `--no-ext-diff --no-textconv`, log · show는 `--no-show-signature`.
  게이트가 확인한 git dir · 작업 트리는 이후 모든 호출에 `--git-dir` · `--work-tree`로 고정한다(`.git` 파일을 나중에 바꿔도 따라가지 않음).
- **체크아웃 게이트**(`checkoutSafety`, 체크아웃마다 맨 먼저 — 통과 전에는 rev-parse 하나만 돈다):
  1. 작업 트리 · git dir · common dir의 실경로가 세션 폴더(`sessionDirs`) 안 — 아니면 이 세션의 체크아웃이 아니다(목록에도 없음). `.git` 파일이 다른 저장소를 가리키거나 `core.worktree`가 밖을 가리키는 경우.
  2. `objects/info/alternates`가 없거나 빈 일반 파일이고(lstat만 — FIFO도 읽지 않는다), git dir · common dir 안에 심볼릭 링크가 하나도 없음(objects · refs · index · logs를 다른 저장소로 돌리는 길, 10만 항목까지 lstat). 아니면 `skipped: 'repo-alternates'` · `'repo-links-outside'`.
  3. `git config --list --name-only --show-scope`(우리 `-c`의 command 범위 제외 = 저장소 · worktree · include)에 `filter.*`, `*.textconv`,
     `*.command`, `*.process`, `gpg.*`, `log.showSignature`, `core.worktree`, `pager.*`, `core.fsmonitor`, `core.sshCommand`,
     `core.pager`, `core.askPass`, `diff.external`가 없음 — 아니면 `skipped: 'repo-config-runs-commands'`.
  2 · 3에 걸리면 두 층도 새 커밋(지표)도 읽지 않는다 — 체크아웃은 사유와 함께 목록에만 남는다.
- 새 파일 · 추적 파일: `O_NOFOLLOW | O_NONBLOCK`으로 열고 연 핸들에서 일반 파일 · 크기를 확인한 뒤에만 읽는다(lstat 뒤 FIFO로 바꿔도 멈추지 않음), 실경로가 체크아웃 안일 때만. diff 접두사는 `--src-prefix=a/ --dst-prefix=b/`로 고정(`diff.noprefix` 저장소에서도 패치가 맞음).
- 남는 위험: 경로 구성 요소를 심볼릭 링크로 바꿔치는 경쟁(검사 뒤 · git 호출 전)은 막지 못한다 — 실경로 확인과 고정 경로로 창을 좁힐 뿐이다. 세션 샌드박스가 다른 유저 폴더 읽기를 OS 수준에서 막지 않는 기존 공백(#732)과 같은 종류다.
- 시간 · 크기: 호출마다 10 s, 출력 16 MiB.

## 6. API · 화면

- `GET /api/dashboard/session/:cid/changes` → `{ doc: CodeChangesDoc(패치 없음) | null, live: boolean }`. `refresh=1`이고 살아 있는 세션이면
  수집을 기다린 뒤(최대 20 s) 답한다. `GET …/changes/file?repo=<repo>&path=<path>` → `{ repo, path, sources: [{ layer, label, prUrl?, file }] }`.
  둘 다 작업 로그의 권한(`getConversation(cid).ownerId` = 로그인 사용자, 또는 어드민), 401 · 403 · 404, `Cache-Control: no-store`.
- 클라이언트(`code-changes-client.ts`): `PSEC_ORDER = ['conv','log','changes','tree']`, 박스 `#psec-changes` 안 `#panel-changes`,
  상태 `_chg = { cid, doc, scope, open, files }`. `chgTree(doc, scope)`(순수) → 레포 → 디렉터리 → 파일, 한 자식 사슬 접기.
  뷰어는 `<dialog id="chg-viewer">`(`showModal`, Esc 닫기, 포커스 되돌림). `chgHunkRows(patch)`(순수)가 줄 번호를 매긴다.
  모든 글자는 `chgEsc`로 이스케이프한다. 카드 푸시의 `codeChangesAt`가 저장본의 `updatedAt`보다 새로우면 탭이 다시 읽는다.
- 한국어 문구는 `en-page.json`에 짝을 둔다(#771).

## 7. 통계 · 모델 배선

- `emitGitHubEvent(type, …, metadata, { id, timestamp })` — 선택 인자로 결정적 id · 시각. id: `merge_lines:<PR URL>`, `commit:<sha>`, `commit_lines:<sha>`.
- `interceptToolResults`의 `git commit` · `gh pr view` 파싱 제거. `pr_created` · `pr_merged`(GitHub 효과)는 그대로.
- 세션 요약 `session.codeChanges` — 영속 필드(세션 저장 · 복원 · 아카이브), `buildSessionResourceSnapshot` → `SessionResourceSnapshot.codeChanges`
  (somalib · process-shared 타입, host-receipt 파서가 보존).
- 턴 컨텍스트: `getContextInfo`에 `<uncommitted-changes>`(커밋 안 함 · PR 없는 커밋) 한 줄, 레포 ≤ 3, 경로 ≤ 5.

## 8. 작업 단위 · 게이트

| WU | 범위 | 끝 확인 |
|---|---|---|
| WU1 | §2–§5 서버: 수집 · 저장 · 라우트 · 턴 끝 배선 · 요약 영속 | 임시 git 저장소 테스트(A1 · A10), PR 가짜 fetch(A2), 라우트 권한(A6) |
| WU2 | §6 화면: 탭 · 트리 · 뷰어 · i18n | 클라이언트 순수 함수 테스트, 실서버 하네스 스크린샷(A3–A5) |
| WU3 | §7 통계 · 모델 | A7 · A8 · A9 테스트, dev 지표 DB 실측 |

게이트(레포 공통): `npx tsc --noEmit` · `npx vitest run`(변경 영역) · `npx biome check src/ somalib/ scripts/ packages/ --diagnostic-level=error` ·
i18n 추출 diff 0. dev 배포 후 실측: 이 작업 세션 자신의 변경점 탭.
