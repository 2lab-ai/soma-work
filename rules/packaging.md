# 패키지 규칙 — 추출은 "이동", 복사 아님

소스의 상당 부분만 `@soma/*` 워크스페이스로 옮겨졌고, 나머지는 `src/`에 사본으로 남아 **이중 출처**를 만들었다(증거: `docs/current/spec/architecture-map.md` §B — `src`가 여전히 다수, env-paths/store/classifier 다수가 src↔packages↔somalib 중복). 이 규칙은 마이그레이션을 **완결**시키기 위한 것이다.

## 타깃 아키텍처

```
soma-work/
├─ src/            ← 얇은 호스트만: 부트스트랩 · Slack 와이어링 · 에이전트 런타임 seam · DI 조립
├─ packages/
│  ├─ common/          ← env-paths · 순수 유틸 · 타입 (다른 패키지가 의존하는 바닥)
│  ├─ process-shared/  ← 프로세스 공유 로직 (permission core · store base · mcp config)
│  ├─ slack/           ← Slack 도메인 (commands · actions · pipeline · blocks)
│  ├─ test-utils/      ← mock 팩토리 (단일)
│  └─ mcp-servers/*    ← 독립 실행 MCP 서버
└─ (somalib/ 는 packages/ 안으로 흡수 — 아래 권고)
```

> **권고이자 확인 요청:** `somalib/`(packages 밖 top-level 변칙)는 `@soma/process-shared`로 흡수하는 것을 기본 타깃으로 삼는다. somalib를 독립 배포 단위로 유지할 이유가 있으면 알려달라 — 그러면 `packages/somalib`로 이동하되 별 패키지로 둔다.

## 절대 규칙

1. **추출은 이동이다. 복사가 아니다.** 코드를 `@soma/*`로 옮기면 `src/`의 원본은 **삭제**하고, 남길 자리에는 `export … from '@soma/…'` **재export 한 줄**만 둔다(현재 `src/env-paths.ts`가 바른 예). 두 군데에 본문이 살아 있으면 위반.
2. **본문은 한 패키지에만.** 같은 모듈의 실제 구현이 `src`·`packages`·`somalib` 중 둘 이상에 있으면 안 된다. 분기된 사본(로직이 다른 복제)은 **버그**로 취급(현재 `process-shared/env-paths.ts`).
3. **패키지 경계 import 는 패키지 이름으로.** `@soma/common`을 `../../../config` 같은 깊은 상대경로로 끌어오지 않는다. 같은 패키지 내부만 상대경로.
4. **의존 방향은 단방향:** `common ← process-shared ← slack ← src`. 역참조(common이 slack을 import) 금지. `src`만 모두를 조립한다.
5. **죽은 패키지는 디렉터리째 제거.** 소스가 사라졌으면 `dist/`·디렉터리도 지운다(현재 `packages/extensions/`는 dist만 잔존 — 제거 대상).

## 새 코드 추가 시

- 둘 이상의 패키지(또는 src + MCP 서버)가 쓸 로직이면 → 처음부터 적합한 `@soma/*`에 두고 이름으로 import. `src`에 먼저 쓰고 나중에 복사 금지.
- 한 곳에서만 쓰면 → 그 자리에 둔다(과추출 금지). 두 번째 소비자가 생길 때 패키지로 **이동**(복사 아님).

## 마이그레이션 순서 (이중 출처 해소)

같은 class의 위반은 인스턴스 패치가 아니라 한 번에:

1. **분기 사본 우선** — `process-shared/env-paths.ts`를 `@soma/common/env-paths` 재export로(로직 차이 = 활성 버그).
2. **store 삼중복** — `memory-file-store`·`skill-file-store`·`shared-store`·`pending-*-store`·`mcp-tool-grant-store`를 정본 패키지로 모으고 나머지는 재export. (이때 `config.md`의 `atomicWriteJson`도 함께 적용.)
3. **test-utils 삼중복** — `src/test-utils/*`를 `@soma/test-utils` 재export로(이미 `2abefe5a`가 양쪽을 손봐야 했던 증거). CLAUDE.md의 mock 경로도 갱신.
4. **click-classifier 등 잔여 src↔slack 중복** → @soma/slack로.
5. **somalib 흡수** (위 권고 확정 후).
6. **extensions 디렉터리 제거.**

## 현재 위반 (실측 2026-06-27)

- **내용 100% 동일한 src↔packages 사본**(재export로 교체 대상):
  `src/test-utils/mock-{slack-api,session,claude-handler}.ts` ≈ `@soma/test-utils`,
  `src/{mcp-tool-permission-config,mcp-tool-grant-store,admin-utils}.ts` ≈ `@soma/process-shared`.
- **분기된 사본**(더 위험 — 로직이 달라 활성 버그): `@soma/process-shared/src/env-paths.ts` vs `@soma/common/src/env-paths.ts`.
- **somalib↔process-shared 삼중복**: `memory-file-store`·`skill-file-store`·`shared-store`(src 기준 스캔엔 안 잡히는 별도 축).
- `somalib/` packages 밖 · `packages/extensions/` dist-only 잔존 · CLAUDE.md "Module Layout"이 `packages/` 누락.
- (basename만 매칭하면 각 패키지의 정당한 `types.ts`/`index.ts`까지 잡히니 — 아래 #1은 **내용 유사도**로 거른다.)

## 검증

```bash
# 1) 내용 ≥80% 동일한 src↔packages 사본 (재export 아닌 것) = 진짜 이중 출처
for f in $(cd src && find . -name '*.ts' ! -name '*.test.ts'); do
  b=$(basename "$f"); head -3 "src/$f" | rg -q "export .* from '@soma/" && continue
  while read -r tw; do [ -z "$tw" ] && continue
    common=$(comm -12 <(sort "src/$f") <(sort "$tw") | wc -l); a=$(wc -l < "src/$f")
    [ "$a" -gt 0 ] && [ $((common*100/a)) -ge 80 ] && echo "DUAL ${tw}"
  done < <(find packages somalib -name "$b" ! -name '*.test.ts' 2>/dev/null)
done

# 2) 깊은 상대경로로 패키지 코드 끌어오기 (패키지명으로 바꿀 대상)
rg -n "from '(\.\./){2,}" src --type ts -g '!*.test.ts' | wc -l

# 3) 죽은 패키지 디렉터리 (소스 없는 dist-only)
for d in packages/*/; do [ -d "$d/dist" ] && [ -z "$(find "$d/src" "$d" -maxdepth 1 -name '*.ts' 2>/dev/null)" ] && echo "DEAD: $d"; done
```

계약 테스트로 고정: `no-dual-source.contract.test.ts` — src의 모든 `.ts`가 packages에 동명 본문을 가지면 src 쪽은 재export여야 한다(이미 있는 `no-somalib-duplication.contract.test.ts`의 일반화). 통과 = 마이그레이션 완료의 기계적 정의.
