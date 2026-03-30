# PID Lock — Single Instance Guard

## Problem

같은 Slack Bot Token으로 2개 이상의 Node 프로세스가 동시 실행되면:
1. Slack Socket Mode가 이벤트를 라운드로빈 분배 → 50% 확률 에러
2. 두 프로세스가 같은 `data/sessions.json`을 R/W → 세션 데이터 오염
3. 에러 발생 프로세스가 세션 초기화 → 정상 프로세스의 대화 컨텍스트 소멸

## Root Cause

- `index.ts`에 중복 실행 방지 로직 없음
- `service.sh`가 `launchctl list`만 사용하여 LaunchAgent 외 프로세스(수동 `node` 실행) 미감지

## Solution

PID lock file 메커니즘으로 앱 레벨 단일 인스턴스 보장.

### Architecture Decision

| 선택지 | 판단 |
|--------|------|
| flock/advisory lock | Node.js에서 OS 의존적, macOS에서 불안정 |
| PID file + process.kill(pid, 0) | 크로스 플랫폼, 단순, 검증 용이 ✅ |
| Named port binding | 포트 충돌 감지만 가능, 범용성 부족 |

### Spec

1. **Lock file 위치**: `{DATA_DIR}/soma-work.pid`
2. **시작 시 (`acquirePidLock`)**:
   - Lock file 존재 → PID 읽기 → `process.kill(pid, 0)` 으로 생존 확인
   - 생존: 로그 출력 + `process.exit(1)`
   - 미생존 (stale): lock file 삭제 후 새 PID 기록
   - Lock file 부재: 새 PID 기록
3. **종료 시 (`releasePidLock`)**:
   - Lock file 삭제 (자기 PID일 때만)
4. **service.sh 보강**:
   - `cmd_stop()`에서 PID file fallback kill 추가

### Non-Goals

- 다른 호스트 간 중복 감지 (각 호스트가 자체 DATA_DIR 사용)
- 강제 takeover 모드 (향후 필요 시 --force 옵션으로 확장)
