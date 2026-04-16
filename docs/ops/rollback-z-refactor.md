# Rollback: `/z` unified command refactor (#506)

이 문서는 `/z` 통합 명령 리팩터(#506, Phase 1)를 되돌려야 할 때 사용하는 3-tier 롤백 절차를 정의한다. 빠른 순서대로(가장 빠른 → 느린) 나열되어 있으며, 각 tier는 이전 tier만으로 수습이 안 될 때 escalation 한다.

**사전 참고**
- 관련 스펙: `plan/MASTER-SPEC.md` §12 (Rollback)
- 관련 이슈: #506 (/z 리팩터), #505 (tombstone), #507 (Phase 2 UI)
- 스냅샷 파일: `slack-app-manifest.prev.json` (pre-#506 상태)
- 스크립트: `scripts/slack-manifest-rollback.sh`

---

## Tier 1 — 환경 변수 플래그 (즉시, 무중단)

**언제**: `/z` 경로에서 예기치 않은 동작이 보이지만 legacy naked 명령 (`persona`, `model`, `mcp` 등)은 정상 동작해야 하는 경우.

**방법**: 모든 봇 인스턴스에 `SOMA_ENABLE_LEGACY_SLASH=true` 환경 변수 설정 후 재시작.

```bash
# macOS LaunchDaemon (dev/prod)
launchctl setenv SOMA_ENABLE_LEGACY_SLASH true
sudo ./service.sh restart

# Docker
docker-compose down
SOMA_ENABLE_LEGACY_SLASH=true docker-compose up -d

# GitHub Actions 배포 인스턴스
# Repository → Settings → Secrets → set SOMA_ENABLE_LEGACY_SLASH=true
# 다음 배포부터 적용. 즉시 반영이 필요하면 수동으로 서비스에 env 추가.
```

**효과**
- `CommandRouter`가 legacy naked 명령 탐지 시 tombstone 힌트를 건너뛰고 legacy 핸들러로 바로 dispatch.
- `/z` prefix는 **여전히 동작**한다 (플래그는 tombstone만 비활성화).
- 사용자가 기존 `persona linus`, `model sonnet` 등을 사용해도 마이그레이션 안내 없이 바로 실행.

**해제**: `launchctl unsetenv SOMA_ENABLE_LEGACY_SLASH`, 재시작.

---

## Tier 2 — git revert + 재배포

**언제**: `/z` dispatch 자체에 버그가 있어서 `/z persona set linus`가 작동하지 않거나 crash 하는 경우. Tier 1으로는 해결되지 않음.

**방법**: `feat/z-phase1` 브랜치가 병합한 커밋을 revert.

```bash
# 1. Phase 1 merge 커밋을 찾는다
git log --oneline --merges main | grep "z-phase1\|#506"

# 2. 해당 merge 커밋을 revert (merge 커밋은 -m 1 필요)
git revert -m 1 <MERGE_COMMIT>

# 3. CI가 통과하면 deploy 브랜치로 push
git push origin main:deploy/dev
git push origin main:deploy/prod
```

**효과**
- `src/slack/z/` 모듈, `/z` 슬래시 커맨드 등록, tombstone 모두 제거.
- Legacy naked 명령은 refactor 이전 상태로 복귀.
- Slack 앱 manifest의 `/z` 슬래시 커맨드는 **Tier 3을 수행하기 전까지 존재만 하고 무시**된다 (봇이 이벤트를 ignore). 무해하지만 사용자 혼란을 막기 위해 Tier 3 병행 권장.

---

## Tier 3 — Slack 앱 매니페스트 롤백

**언제**: Tier 2로 코드는 복구했지만 Slack 앱의 `/z`, `/soma`, `/session`, `/new` 슬래시 커맨드 정의까지 pre-refactor 상태로 되돌려야 하는 경우.

**방법**: `scripts/slack-manifest-rollback.sh` 실행 후 Slack API 콘솔에 업로드.

```bash
# 1. 드라이런으로 diff 확인
bash scripts/slack-manifest-rollback.sh --dry-run

# 2. 확정 적용 (인터랙티브)
bash scripts/slack-manifest-rollback.sh

# 3. 복원된 slack-app-manifest.json을 Slack API 콘솔에 업로드
#    https://api.slack.com/apps → (앱 선택) → App Manifest → 붙여넣기 → Save
#    Dev 앱과 Prod 앱 양쪽 모두 수행.

# 4. 롤백 결과를 커밋
git add slack-app-manifest.json
git commit -m "rollback(slack): restore pre-/z manifest"
git push
```

**효과**
- `slack-app-manifest.json`이 `slack-app-manifest.prev.json`로 복원 (→ `/soma`, `/session`, `/new`만 존재).
- Slack 앱 설정 UI에서 `/z` 슬래시 커맨드 사라짐.
- `*.rollback-backup-YYYYMMDD-HHMMSS` 파일에 이전 상태 보존.

**주의**
- 매니페스트 업로드는 Slack UI 조작이 필요 — 자동화 불가.
- Dev/Prod 각각 다른 앱이므로 두 번 수행해야 한다.

---

## 확인 체크리스트 (롤백 후)

- [ ] `persona linus`, `model sonnet` 등 legacy naked 명령이 tombstone 없이 바로 실행되는가
- [ ] `/z help`가 404/에러 없이 응답하는가 (Tier 3 미수행 시: 봇이 무시만 하고 Slack UI에는 명령이 남아있을 수 있음 — 정상)
- [ ] `/soma help`, `/session`, `/new`가 동작하는가
- [ ] 운영 로그에 `CommandRouter` 에러가 없는가
- [ ] Dev/Prod 양쪽 모두 확인

---

## 재-rollforward (롤백 해제)

롤백 원인이 수정되어 `/z` 리팩터를 다시 활성화할 때:

1. **Tier 1** 해제: `launchctl unsetenv SOMA_ENABLE_LEGACY_SLASH`, 재시작.
2. **Tier 2** 해제: `git revert <revert-commit>` 로 revert-revert, 재배포.
3. **Tier 3** 해제: `slack-app-manifest.json`을 `feat/z-phase1` 상태로 복구하고 Slack UI 업로드.

각 단계는 독립적이므로 Tier 1만 해제하고 운영하는 것도 가능 (`/z` 경로는 비활성 유지).
