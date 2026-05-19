# Media File Support (Video/Audio) — Spec

> STV Spec | Created: 2026-03-28

## 1. Overview

soma-work의 파일 처리 시스템이 이미지와 텍스트만 인식하고, 영상/오디오 파일을 "binary"로 취급한다.
이로 인해 AI 에이전트가 .mp4 등을 Read 도구로 열려다 실패하고, 유저에게 "Unsupported file type" 에러를 보여준다.

영상/오디오 파일을 별도 카테고리로 인식하여, 이미지와 동일한 방식(메타데이터만 전달, Read 차단)으로 처리해야 한다.

## 2. User Stories

- As a Slack user, I want to upload .mp4/.mov 영상 파일을 봇에게 보내면, 봇이 파일명/크기/타입 메타데이터를 인식하고 적절히 응답하길 원한다.
- As a Slack user, I want to upload .mp3/.wav 오디오 파일도 에러 없이 인식되길 원한다.
- As an AI agent, I want video/audio 파일에 대해 Read를 시도하지 않도록 올바른 안내를 받길 원한다.

## 3. Acceptance Criteria

- [ ] .mp4, .mov, .avi, .mkv, .webm, .wmv, .m4v, .mpg, .mpeg, .3gp → video로 인식
- [ ] .mp3, .wav, .ogg, .flac, .m4a, .aac, .wma → audio로 인식
- [ ] file-handler.ts의 formatFilePrompt에서 video/audio 파일 경로를 노출하지 않음
- [ ] download_thread_file에서 video/audio 파일 다운로드 차단 (이미지와 동일)
- [ ] get_thread_messages의 formatSingleMessage에서 video/audio에 적절한 안내 추가
- [ ] 기존 이미지/텍스트/PDF 처리 깨지지 않음 (regression 없음)
- [ ] send_media는 이미 video/audio 지원 — 변경 불필요

## 4. Scope

### In-Scope
- file-handler.ts: video/audio 카테고리 추가
- slack-mcp-server.ts: download 차단 + 메시지 포맷
- 관련 테스트 파일 업데이트

### Out-of-Scope
- 영상/오디오 파일 내용 분석 (트랜스크립션 등)
- send_media 변경 (이미 지원)
- 새로운 이미지 포맷 magic bytes 추가 (별도 이슈)

## 5. Architecture

### 5.1 Layer Structure

```
Slack Event → EventRouter → InputProcessor → FileHandler (인바운드)
                                                ↓
                                          formatFilePrompt → AI Agent
                                                ↓
AI Agent → slack-mcp-server → download_thread_file (차단)
                            → get_thread_messages → formatSingleMessage (메타데이터)
                            → send_media (아웃바운드, 이미 지원)
```

### 5.2 API Endpoints
해당 없음 — 내부 파일 처리 로직 변경

### 5.3 DB Schema
해당 없음

### 5.4 Integration Points

| 기존 코드 | 변경 내용 |
|-----------|----------|
| `src/file-handler.ts:176-191` | isVideoFile, isAudioFile 추가 |
| `src/file-handler.ts:194-236` | formatFilePrompt video/audio 분기 추가 |
| `mcp-servers/slack-mcp/slack-mcp-server.ts:96-104` | isMediaFile 함수 추가 (image+video+audio) |
| `mcp-servers/slack-mcp/slack-mcp-server.ts:297-299` | download_thread_file description 업데이트 |
| `mcp-servers/slack-mcp/slack-mcp-server.ts:707-720` | handleDownloadFile에 video/audio 차단 추가 |
| `mcp-servers/slack-mcp/slack-mcp-server.ts:671-685` | formatSingleMessage video/audio 노트 추가 |

## 6. Non-Functional Requirements

- Performance: 변경 없음 (Set.has() 조회만 추가)
- Security: 변경 없음 (기존 보안 모델 유지)
- Scalability: 변경 없음

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| video/audio를 이미지와 동일 패턴으로 처리 (메타데이터만, Read 차단) | small ~15줄 | 이미지 처리 패턴이 이미 검증됨. 동일 패턴 적용이 가장 안전 |
| isMediaFile() 통합 함수 추가 | tiny ~5줄 | isImageFile() 패턴 확장. 코드 중복 방지 |
| download_thread_file에서 미디어 파일 전체 차단 | small ~10줄 | Read 도구로 읽을 수 없는 바이너리. 다운로드해봐야 쓸모없음 |
| 기존 IMAGE/VIDEO/AUDIO_EXTENSIONS Set 재사용 | tiny ~3줄 | slack-mcp-server.ts에 이미 정의되어 있음 |
| file-handler.ts에 동일 extension sets 복제 | small ~10줄 | 두 모듈은 독립 실행됨. 공유 모듈 추출은 over-engineering |

## 8. Open Questions

None — 모든 결정 사항이 기존 패턴의 확장이므로 불확실성 없음.

## 9. Next Step

→ `stv:trace`로 시나리오별 수직 추적 진행
