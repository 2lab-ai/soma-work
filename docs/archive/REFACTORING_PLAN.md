# Refactoring Plan: SRP 기반 코드 정리

> "Talk is cheap. Show me the code." - Linus Torvalds

## 현황 진단

총 10,692줄, 83개 파일. 대부분 잘 분리되어 있으나 몇몇 파일이 "God Object"로 비대해짐.

### 문제 파일 (난장판)

| 파일 | 줄 수 | 문제 |
|------|-------|------|
| `slack/action-handlers.ts` | 674 | 5가지 일을 한 곳에서 처리. 쓰레기통 |
| `slack-handler.ts` | 536 | `handleMessage()` 294줄짜리 괴물 |
| `slack/user-choice-handler.ts` | 472 | JSON 파싱과 UI 빌딩 혼합 |
| `permission-mcp-server.ts` | 248 | MCP 서버 + 폴링 로직 혼합 |

### 잘 된 부분 (건드리지 마라)

- `claude-handler.ts` - 깔끔한 facade 패턴
- `github-auth.ts` - 잘 분리된 위임 구조
- `mcp-manager.ts` - 좋은 추상화
- `slack/commands/*` - 명령별 분리 완료
- `slack/stream-processor.ts` - 복잡하지만 책임 명확

---

## Phase 1: action-handlers.ts 해체 (우선순위: 긴급)

이 파일은 5가지 다른 일을 한다. 각각 따로 빼라.

### 현재 구조 (망한 구조)
```
ActionHandlers
├── handleApprove()         # 권한 승인
├── handleDeny()            # 권한 거부
├── handleTerminateSession() # 세션 종료
├── handleUserChoice()      # 단일 선택
├── handleCustomInputSingle/Multi() # 커스텀 입력
└── handleCustomInputSubmit()      # 폼 제출
```

### 목표 구조
```
slack/actions/
├── permission-actions.ts    # approve, deny
├── session-actions.ts       # terminate
├── choice-actions.ts        # user choice 처리
├── form-actions.ts          # modal, custom input
└── index.ts                 # 통합 라우터
```

### 작업 내용

1. `slack/actions/` 디렉토리 생성
2. 권한 관련: `PermissionActionHandler`
   - `handleApprove()`, `handleDeny()`
   - 의존성: SharedStore, SlackApiHelper
3. 세션 관련: `SessionActionHandler`
   - `handleTerminateSession()`
   - 의존성: SessionRegistry, SlackApiHelper
4. 선택 관련: `ChoiceActionHandler`
   - `handleUserChoice()`
   - 의존성: UserChoiceHandler, SlackApiHelper
5. 폼 관련: `FormActionHandler`
   - `handleCustomInputSingle/Multi()`, `handleCustomInputSubmit()`
   - 의존성: SlackClient
6. `ActionRouter` - 각 핸들러로 라우팅만 담당

예상 결과: 674줄 → 5개 파일 각 100~150줄

---

## Phase 2: slack-handler.ts::handleMessage() 분해 (우선순위: 높음)

294줄짜리 메서드는 범죄다. 읽을 수 없고, 테스트할 수 없고, 유지보수 불가능하다.

### 현재 handleMessage() 내용
```
1. 메시지 검증 (봇 여부, 중복 체크)
2. 파일 처리 (다운로드, 인코딩)
3. 작업 디렉토리 검증
4. 세션 생성/조회
5. 상태 메시지 생성
6. 스트림 처리 실행
7. 정리 작업
```

### 목표 구조
```
slack-handler.ts (슬림화)
└── handleMessage() → 각 단계 위임만

slack/pipeline/
├── message-validator.ts     # 검증 (이미 존재하면 확장)
├── file-processor.ts        # 파일 처리 조율
├── session-initializer.ts   # 세션 생성/조회
├── stream-orchestrator.ts   # 스트림 처리 조율
└── cleanup-coordinator.ts   # 정리 작업
```

### 작업 내용

1. `MessagePipeline` 클래스 생성
   - 각 단계를 순차 실행
   - 에러 발생 시 적절한 정리

2. 각 단계를 개별 클래스로 추출:
   - `FileProcessingStep` - 파일 다운로드 조율
   - `SessionInitStep` - 세션 생성/조회
   - `StreamExecutionStep` - 스트림 실행
   - `CleanupStep` - 정리

3. `SlackHandler`는 파이프라인 실행만 담당

예상 결과: handleMessage() 294줄 → 50줄 이하

---

## Phase 3: user-choice-handler.ts 분리 (우선순위: 중간)

JSON 파싱과 Slack 블록 빌딩이 섞여있다. 다른 책임이다.

### 현재 구조
```
UserChoiceHandler (static)
├── extractUserChoice()      # JSON 추출
├── extractBalancedJson()    # JSON 파싱
├── parseAndNormalizeChoice() # 정규화
├── buildButtonsMessage()    # Slack UI
├── buildDropdownMessage()   # Slack UI
├── buildCustomInputMessage() # Slack UI
└── buildFormMessage()       # Slack UI
```

### 목표 구조
```
slack/
├── user-choice-extractor.ts  # JSON 추출/파싱 로직
└── choice-message-builder.ts # Slack 블록 빌딩
```

### 작업 내용

1. `UserChoiceExtractor` 생성
   - `extractFromText()` - 텍스트에서 JSON 추출
   - `parse()` - JSON 파싱
   - `normalize()` - 정규화

2. `ChoiceMessageBuilder` 생성
   - `buildButtons()` - 버튼 블록
   - `buildDropdown()` - 드롭다운
   - `buildCustomInput()` - 커스텀 입력
   - `buildForm()` - 폼

3. `UserChoiceHandler` 유지 - 두 클래스 조합하는 facade

---

## Phase 4: permission-mcp-server.ts 정리 (우선순위: 낮음)

MCP 서버 구현과 승인 폴링이 섞여있다.

### 현재 구조
```
PermissionMCPServer
├── setupHandlers()           # MCP 핸들러 등록
├── handlePermissionPrompt()  # 권한 요청 처리
├── waitForApproval()         # 폴링 로직
└── resolveApproval()         # 응답 처리
```

### 목표 구조
```
permission/
├── mcp-server.ts         # MCP 서버 핸들러만
├── approval-poller.ts    # 폴링 로직
└── service.ts            # 기존 유지
```

### 작업 내용

1. `ApprovalPoller` 추출
   - `waitForApproval()` 이동
   - `resolveApproval()` 이동
   - 타임아웃 설정 관리

2. `PermissionMCPServer` 슬림화
   - MCP 핸들러 등록만
   - 권한 요청 시 ApprovalPoller 호출

---

## 실행 순서

```
Phase 1 (action-handlers 해체)
    ↓
Phase 2 (handleMessage 분해)
    ↓
Phase 3 (user-choice-handler 분리)
    ↓
Phase 4 (permission-mcp-server 정리)
```

각 Phase 완료 후:
1. 기존 테스트 통과 확인
2. 새 파일에 대한 테스트 추가
3. 커밋

---

## 하지 말아야 할 것

1. **과도한 추상화 금지**
   - Interface 남발하지 마라
   - 한 번만 쓰이는 헬퍼 클래스 만들지 마라
   - "나중에 필요할지도" 코드 쓰지 마라

2. **잘 돌아가는 코드 건드리지 마라**
   - `stream-processor.ts` - 복잡하지만 책임 명확
   - `mcp-client.ts` - 프로토콜 구현이라 원래 큼
   - `session-registry.ts` - 잘 정리됨

3. **불필요한 패턴 도입 금지**
   - DI 컨테이너 필요없다
   - Event Bus 필요없다
   - 지금 있는 의존성 주입 방식 유지

---

## 예상 결과

| Before | After |
|--------|-------|
| action-handlers.ts: 674줄 | 5개 파일 × ~130줄 |
| handleMessage(): 294줄 | ~50줄 + 파이프라인 컴포넌트 |
| user-choice-handler.ts: 472줄 | 2개 파일 × ~200줄 |
| 가장 큰 메서드: 294줄 | ~80줄 이하 |

---

## 원칙

1. **한 클래스 = 한 가지 이유로만 변경**
   - 권한 로직 바뀌면? → PermissionActionHandler만
   - UI 바뀌면? → ChoiceMessageBuilder만
   - 세션 로직 바뀌면? → SessionActionHandler만

2. **작은 것이 아름답다**
   - 100줄 넘으면 의심하라
   - 200줄 넘으면 분리하라
   - 300줄 넘으면 이미 늦었다

3. **읽기 쉬운 코드가 좋은 코드**
   - 함수 이름만 봐도 뭐하는지 알아야 한다
   - 주석이 필요하면 코드가 나쁜 거다
