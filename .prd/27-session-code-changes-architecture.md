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
2. 파일마다 이 프로세스가 lstat → 크기가 다르면 바뀜, 같으면 바이트의 git blob id(sha1 · sha256)를 계산해 비교. 같다고 확인한 파일은 stat(크기 · mtime · inode)로 기억해 다음엔 읽지 않는다. 없으면 삭제. 심볼릭 링크는 따라가지 않고 링크 대상 문자열을 blob과 비교만 한다 — 바뀌었다는 사실만 남기고 대상 문자열은 싣지 않는다. 파일 읽기는 전부 `readInside`(§5).
3. 바뀐 파일의 패치 = `git cat-file blob`(객체 읽기)과 파일 바이트의 줄 diff(`lineDiff`, Myers, 문맥 3줄). 줄 끝만 다르면 바뀌지 않은 것으로 본다. 패치를 남기지 않는 파일(1 MiB 초과, 패치 300개 소진, diff 한도 초과)도 줄 수는 센다 — 1 MiB까지는 `lineDiff`, 8 MiB까지는 줄 다중집합 차(옮긴 줄은 안 바뀐 것으로), 층당 읽기 64 MiB까지. 추적 파일이 1,000개에서 멈추면 `truncated`.
4. 새 파일 = 인덱스에만 있는 것(`ls-files --cached` − HEAD) + 추적 안 하는 것(`ls-files --others --exclude-standard`, 이름만). lstat 일반 파일만 `readInside`로 읽고, 앞 8 KiB에 NUL이면 바이너리, 내용으로 `@@ -0,0 +1,N @@` 패치(패치도 256 KiB로 자름). `ls-tree` · `ls-files`가 실패하면 층은 `skipped: 'git-diff-failed'`.
5. 이름 바꾸기는 찾지 않는다(삭제 + 추가로 보인다).

커밋함:
1. base 후보 — 이 체크아웃 브랜치를 head로 하는 세션 PR의 head sha가 HEAD의 조상이면 그것(여럿이면 가장 최근).
2. 아니면 `refs/remotes/origin/HEAD` → `origin/main` → `origin/master` 중 처음 있는 것과의 `merge-base`.
3. 원격 참조가 없으면 `rev-list --since=<세션 시작> HEAD`의 가장 오래된 커밋의 부모(루트면 빈 트리).
4. 기준점이 세션 PR head가 아니면, base..HEAD의 첫 부모 줄에서 세션 시작 전에 만든 가장 최근 커밋(base의 자손)으로 base를 올린다 — 세션 전 브랜치 작업은 세지 않고, 옆 줄에서 merge로 들어온 옛 커밋이 기준점이 되지 않는다.
5. `git log base..HEAD -n 50`(커밋 목록) + `git diff base HEAD -M`(numstat · name-status · 패치). 파일 목록(numstat · name-status)을 못 읽으면 `skipped: 'git-diff-failed'` — "커밋 없음"이 아니다. 상태(추가 · 삭제 · 이름 바꿈)는 name-status에서 오므로, 패치를 안 남긴 파일(1,000개 초과, 패치 명령 실패 · 출력 상한 초과)도 상태를 지키고 `patchTruncated`로 표시된다.
6. 세션 PR head는 PR 저장소 또는 head 저장소(포크의 브랜치, `headRepo`)가 이 체크아웃의 원격과 같을 때 후보가 된다.

읽기에 실패한 층(`git-diff-failed`, `repo-changed-during-read`, `git-failed`)은 저장본의 마지막 읽기를 사유와 함께 그대로 둔다(`keepLastRead`).
`repo-changed-during-read` · `git-failed`(`.git`이 있는 폴더에서 git이 답하지 않음 — 시간 초과 · 잠금; 체크아웃이 없는 것과 다르다)면
그 체크아웃의 이번 읽기는 이름(원격)까지 전부 버린다. 추적 파일의 실행 권한이 바뀌면(`core.filemode`가 false가 아닐 때) 내용이
같아도 바뀐 것이다(`modeChange: '100644 → 100755'`).

새 커밋(통계) — `git log -g --date=unix --format=%H%x1f%gs%x1f%gd HEAD -n 300`에서 reflog 시각이 세션 시작 이후이고 제목이
`commit`(`commit:`, `commit (amend):`, `commit (initial):`, `commit (merge):`)으로 시작하는 것. 아직 `counted.commits`에 없는 것만
`git show --numstat -z --format= <sha>`로 줄 수를 세 지표로 보낸다 — 같은 고정 git dir로, 같은 증인 확인 안에서. `counted`는 지표가
받은 뒤에만 늘어난다(`markCounted`, 서비스가 `onResult` 성공 뒤) — 넘기기에 실패하면 다음 수집이 다시 넘긴다(지표 행은 먼저 쓴 쪽이 이긴다).
`onResult`가 없으면(받을 쪽 없음) 아무것도 표시하지 않는다. 머지도 같다: `newMerges` = 머지됨 중 `counted.merges`에 없는 PR(저장본의
이전 상태가 아니라) — 넘기기에 실패한 머지는 다음 수집이 다시 넘긴다. 목록마다 최근 2,000개.

PR — 세션의 PR 링크(현재 + 기록) 중 GitHub URL만, 최대 20. 저장본에 머지 기록이 있고 파일이 온전하면(`filesStale` · `patchesDropped` 없음) 다시 묻지 않는다(바뀌지 않는다). 닫힌 PR은 다시 열리고 나중에 머지될 수 있으니 매번 묻는다.
그 밖에는 `GET pulls/{n}`(상태 · 크기 · head · head 저장소 · base sha · 생성/머지 시각) → 생성 시각이 세션 시작 − 2분 이후일 때만 `GET pulls/{n}/files`.
저장된 파일은 head sha와 base sha가 같고 온전할 때만 다시 쓴다. 문서 예산이 패치를 덜어낸 PR은 `patchesDropped`로 다음에 다시 읽는다.
실패한 PR은 저장본의 이전 기록을 그대로 둔다.

턴 끝 순서 — 수집은 그 턴의 PR 재조정이 끝난 뒤(`reconcileSessionPrs.settled`, 최대 45 s): 재조정이 찾은 PR은 커밋 층이 아니라 PR 층에 들어간다.

스케줄 — 세션 키마다 한 번에 하나, 같은 세션은 15초 안에 다시 돌지 않고(뒤 요청은 한 번으로 합쳐 늦게), 전체 동시 실행 ≤ 2.
`refresh=1`은 같은 큐를 탄다. 실패는 로그만 남기고 이전 저장본을 지우지 않는다.

## 5. 안전 — 데몬이 세션 폴더의 git을 돌린다

세션 폴더의 저장소 설정은 모델이 쓸 수 있다. 데몬이 거기서 git을 돌리면 설정이 부르는 명령이 샌드박스 밖에서 돌고, 설정 · 포인터가 가리키는 다른 곳(다른 유저의 폴더)을 읽게 된다(23 ESC 계열과 같은 종류). 막는 것:

- env: 재조정기의 `GIT_ENV`(전역 · 시스템 설정 없음, 토큰 없음) + `GIT_OPTIONAL_LOCKS=0`(status가 인덱스를 쓰지 않음) + `GIT_PAGER=cat`.
- **검사에 기대지 않는 것(모든 호출, 그때 설정이 무엇이든)**: git은 작업 트리 파일 내용을 읽지 않는다(커밋 안 함 층은 이 프로세스가 비교 — §4)
  → clean filter · textconv가 돌 자리가 없다. 명령줄 `-c`가 저장소 설정을 이긴다: `core.fsmonitor=false core.hooksPath=/dev/null diff.external=
  core.untrackedCache=false log.showSignature=false protocol.allow=never gc.auto=0 maintenance.auto=false diff.submodule=short submodule.recurse=false`
  + 전송마다 `protocol.<ext|file|git|ssh|http|https>.allow=never`(저장소의 `protocol.<이름>.allow=always`가 일반 키를 이긴다) + `--no-pager`,
  env `GIT_NO_LAZY_FETCH=1`(부분 클론의 lazy fetch가 원격 전송 명령을 부르지 않게). diff는 두 커밋 사이만, `--no-ext-diff --no-textconv
  --ignore-submodules=all`, log · show는 `--no-show-signature`. 게이트가 확인한 git dir · 작업 트리는 이후 모든 호출에 `-C <작업 트리>
  --git-dir --work-tree`로 고정한다(`.git` 파일을 나중에 바꿔도 따라가지 않음).
- **체크아웃 게이트**(`checkoutSafety`, 체크아웃마다 맨 먼저 — 통과 전에는 rev-parse 하나만 돈다):
  1. 작업 트리 · git dir · common dir의 실경로가 세션 폴더(`sessionDirs`) 안 — 아니면 이 세션의 체크아웃이 아니다(목록에도 없음). `.git` 파일이 다른 저장소를 가리키거나 `core.worktree`가 밖을 가리키는 경우.
     세션 폴더는 가장 바깥 것만 루트다(`trustedRoots`): 다른 루트 안의 폴더(세션 폴더 안의 턴 폴더)는 담는 범위에 보태는 것이 없고,
     모델이 그 자리를 다른 세션 체크아웃으로 가는 링크로 바꾸면 그 체크아웃이 루트가 되어 버리므로 뺀다. 가장 바깥 폴더가 링크면 루트가 아니다.
  2. `objects/info/alternates`가 없거나 빈 일반 파일이고(lstat만 — FIFO도 읽지 않는다), git dir · common dir 안에 심볼릭 링크가 하나도 없음(objects · refs · index · logs를 다른 저장소로 돌리는 길, 10만 항목까지 lstat). 아니면 `skipped: 'repo-alternates'` · `'repo-links-outside'`.
  3. `git config --list --name-only --show-scope`(우리 `-c`의 command 범위 제외 = 저장소 · worktree · include)에 `filter.*`, `*.textconv`,
     `*.command`, `*.process`, `gpg.*`, `log.showSignature`, `core.worktree`, `pager.*`, `core.fsmonitor`, `core.sshCommand`,
     `core.pager`, `core.askPass`, `diff.external`, `protocol.*`, `remote.*.promisor` · `uploadpack` · `receivepack` · `vcs`,
     `extensions.partialClone`, `core.alternateRefsCommand`, `uploadpack.*`가 없음 — 아니면 `skipped: 'repo-config-runs-commands'`.
  2 · 3에 걸리면 두 층도 새 커밋(지표)도 읽지 않는다 — 체크아웃은 사유와 함께 목록에만 남는다.
- **바꿔치기 경쟁(검사 뒤 경로 구성 요소를 링크로)** — 검사 하나로는 못 막으니 읽는 순간에 막거나, 읽은 뒤 증명한다(#1299 4차 리뷰):
  - 작업 트리 파일(`readInside`): 연 경로 전체에 링크가 없어야 한다. macOS는 `O_NOFOLLOW_ANY`(커널이 경로를 걸으며 구성 요소마다 링크를
    거부 — 실측: 링크 조상 경유 시 ELOOP), Linux는 연 핸들의 실제 경로(`/proc/self/fd/N`)가 작업 트리 안. 그 밖의 OS는 읽지 않는다.
    연 핸들에서 일반 파일 · 이름 하나(`nlink == 1`, 밖 파일의 하드 링크 거부) · 크기를 확인하고 `O_NONBLOCK`(FIFO로 바꿔도 멈추지 않음).
  - git dir(`PathWitness`): git이 경로를 직접 여니 막을 수 없다 — 대신 게이트가 세션 폴더부터 작업 트리 · git dir까지의 폴더(따로 놓인
    linked worktree의 작업 트리 경로 포함 — 파일은 게이트가 확인한 그 실경로 아래에서만 읽는다), git dir · common dir
    안의 모든 폴더, 포인터 파일(`commondir` · `config` · `config.worktree` · `objects/info/alternates`)의 (장치, inode, 종류, ctime)을 적고,
    체크아웃의 모든 git 호출(새 커밋 포함)이 끝난 뒤 다시 본다. 항목을 바꾸면(이름 바꾸기 · 교체 · 생성 · 삭제) 그 폴더의 ctime이, 옮긴
    항목은 제 ctime이 바뀌고 어떤 프로세스도 ctime을 되돌리지 못한다(`utimes`는 지금으로 만든다) — 하나라도 다르면 그 읽기를 버리고
    `skipped: 'repo-changed-during-read'`(지표로 넘기는 새 커밋도 없음). 시험: 읽는 동안 `.git`을 다른 저장소로 바꿨다 되돌리면, 증인
    확인을 빼면 그 저장소의 비공개 파일이 패치로 새고, 넣으면 아무것도 남지 않는다.
  - 경계: 세션 폴더 위(유저 폴더 등)는 샌드박스가 쓰지 못한다는 전제다 — 세션 폴더 자신을 옮겼다 되돌리면 제 ctime으로 잡힌다.
- diff 접두사는 `--src-prefix=a/ --dst-prefix=b/`로 고정(`diff.noprefix` 저장소에서도 패치가 맞음).
- 저장본 검증: 읽는 쪽이 검사 없이 쓰는 필드(경로 · 상태 · 줄 수 · 패치 문자열 · PR 번호 · 상태)가 틀리면 `.bak`으로 넘어간다.
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
