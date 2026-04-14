# A2T (Audio-to-Text) Service — Spec

> STV Spec | Created: 2026-04-14

## 1. Overview

### Proposal
- **Why**: Slack 유저가 보내는 음성 메시지가 현재 메타데이터만 전달되어 AI가 음성 내용을 이해할 수 없음
- **What Changes**: soma-work 내부 플러그인 패턴의 A2T 서비스 모듈 + file-handler 통합
- **Capabilities**: Slack 음성 메시지 → Whisper v3 Turbo 자동 transcription → 텍스트로 AI에 전달
- **Impact**: `src/a2t/`, `src/file-handler.ts`, `src/index.ts`, `src/unified-config-loader.ts`

Slack에서 수신되는 음성/오디오 파일을 Whisper v3 Turbo 모델로 자동 transcription하여
Claude에게 텍스트로 전달하는 내부 서비스 모듈.

## 2. User Stories
- As a Slack user, I want my voice messages to be automatically transcribed so that the AI assistant can understand and respond to my voice input.
- As an operator, I want A2T to gracefully degrade (metadata-only) when Python/Whisper is not installed, so the bot doesn't crash.
- As an operator, I want memory checks before model loading to prevent OOM on resource-constrained servers.

## 3. Acceptance Criteria
- [x] Audio files from Slack are downloaded and transcribed when A2T is available
- [x] Transcription text, language, and duration are included in the AI prompt
- [x] When A2T is not loaded, a clear status message is shown instead of transcription
- [x] Memory check prevents model loading when system memory is insufficient
- [x] Service reports status: disabled / not_initialized / initializing / ready / error / shutdown
- [x] Service initializes and shuts down cleanly with the app lifecycle
- [x] Config section in config.json controls model, device, memory threshold
- [x] Python/faster-whisper not installed → graceful degradation (bot runs without A2T)

## 4. Scope
### In-Scope
- Whisper v3 Turbo transcription via Python subprocess (faster-whisper)
- Plugin-pattern service (loadable/unloadable, status reporting)
- Memory guard before model loading
- Integration with FileHandler for automatic audio transcription
- Configuration via config.json `a2t` section

### Out-of-Scope
- Real-time audio streaming
- Video transcription
- Speaker diarization
- Custom model fine-tuning
- Automatic Python/faster-whisper installation

## 5. Architecture

### 5.1 Layer Structure
```
config.json (a2t section)
    ↓
index.ts → initA2tService()
    ↓
A2tService (singleton) ← manages → worker.py (Python subprocess)
    ↓
FileHandler.formatFilePrompt() → getA2tService()?.transcribe()
    ↓
Claude prompt includes transcription text
```

### 5.2 Components

| Component | Path | Role |
|-----------|------|------|
| A2tService | `src/a2t/a2t-service.ts` | Singleton wrapper, lifecycle, status |
| Types | `src/a2t/types.ts` | A2tConfig, TranscriptionResult, A2tStatus |
| Worker | `services/a2t/worker.py` | Python process, Whisper model, transcription |
| Requirements | `services/a2t/requirements.txt` | Python dependencies |

### 5.3 Communication Protocol (stdin/stdout JSON)

```
Host → Worker:  {"type": "transcribe", "path": "/tmp/audio.wav"}
Worker → Host:  {"type": "result", "text": "...", "language": "en", ...}

Host → Worker:  {"type": "shutdown"}
(Worker exits)

Startup:
Worker → Host:  {"type": "ready", "model": "large-v3-turbo", "device": "cpu"}
  OR
Worker → Host:  {"type": "error", "error": "..."}
```

### 5.4 Integration Points
- `src/index.ts`: Service lifecycle (init on startup, shutdown on exit)
- `src/unified-config-loader.ts`: Config parsing (a2t section)
- `src/file-handler.ts`: Audio file download + transcription
- `config.json`: Configuration

## 6. Non-Functional Requirements
- Performance: Model loads once, stays in memory. Transcription is sequential.
- Security: Audio files processed locally (no external API calls)
- Scalability: One request at a time per service instance (sufficient for Slack bot use case)
- Reliability: Non-critical service — failure doesn't affect bot operation

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Python + faster-whisper backend | small | Whisper is Python-native; faster-whisper is 4x faster than original |
| Singleton pattern (not DI) | tiny | Matches existing patterns (tokenManager) |
| stdin/stdout protocol | small | Same pattern as MCP servers, no port management |
| Sequential transcription | tiny | Slack bot processes one message at a time |
| `## Audio:` header (was `## Media:`) | tiny | Clearer distinction between video and audio in prompts |

## 8. Open Questions
None.

## 9. Spec Changelog
- 2026-04-14: Initial creation

## 10. Setup Requirements

```bash
# Install Python dependencies (on the host or in Docker)
pip install -r services/a2t/requirements.txt

# First run downloads the model automatically (~1.5GB for large-v3-turbo)
```

### Config example (config.json)
```json
{
  "a2t": {
    "enabled": true,
    "model": "large-v3-turbo",
    "device": "auto",
    "computeType": "auto",
    "minMemoryMb": 2000,
    "pythonPath": "python3"
  }
}
```
