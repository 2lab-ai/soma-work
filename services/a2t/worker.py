#!/usr/bin/env python3
"""
A2T Worker — Whisper v3 Turbo transcription service.

Long-running process. Communicates with Node.js host via stdin/stdout JSON.
Model loads once on startup; stays in memory for fast subsequent transcriptions.

Protocol:
  → {"type": "transcribe", "path": "/tmp/audio.wav"}
  ← {"type": "result", "text": "...", "language": "en", "language_probability": 0.98, "duration": 3.5}
  → {"type": "shutdown"}
  (process exits)

Startup:
  ← {"type": "ready", "model": "large-v3-turbo", "device": "cpu"}
  OR
  ← {"type": "error", "error": "..."}
"""

import json
import os
import sys


def send(msg: dict) -> None:
    """Send JSON message to stdout (Node.js host)."""
    print(json.dumps(msg, ensure_ascii=False), flush=True)


def send_error(error: str) -> None:
    send({"type": "error", "error": error})


def check_memory(required_mb: int) -> tuple[bool, float]:
    """Check available (free) system memory before loading the model."""
    try:
        import psutil
        mem = psutil.virtual_memory()
        available_mb = mem.available / (1024 * 1024)
        return available_mb >= required_mb, available_mb
    except ImportError:
        # psutil not available — skip memory check, let OS handle it
        return True, -1


def main() -> None:
    model_name = os.environ.get("A2T_MODEL", "large-v3-turbo")
    device = os.environ.get("A2T_DEVICE", "auto")
    compute_type = os.environ.get("A2T_COMPUTE_TYPE", "auto")
    min_memory_mb = int(os.environ.get("A2T_MIN_MEMORY_MB", "16000"))

    # ── Memory check ──
    has_memory, available_mb = check_memory(min_memory_mb)
    if not has_memory:
        send_error(
            f"Insufficient free memory: {available_mb:.0f}MB available, "
            f"{min_memory_mb}MB required"
        )
        sys.exit(1)

    # ── Load model ──
    try:
        from faster_whisper import WhisperModel

        # Resolve device
        actual_device = device
        if device == "auto":
            try:
                import torch
                actual_device = "cuda" if torch.cuda.is_available() else "cpu"
            except ImportError:
                actual_device = "cpu"

        # Resolve compute type
        actual_compute = compute_type
        if compute_type == "auto":
            actual_compute = "float16" if actual_device == "cuda" else "int8"

        sys.stderr.write(
            f"Loading Whisper model '{model_name}' on {actual_device} "
            f"({actual_compute})...\n"
        )
        sys.stderr.flush()

        model = WhisperModel(model_name, device=actual_device, compute_type=actual_compute)

        send({"type": "ready", "model": model_name, "device": actual_device})

    except ImportError as e:
        send_error(f"faster-whisper not installed: {e}")
        sys.exit(1)
    except Exception as e:
        send_error(f"Failed to load model: {e}")
        sys.exit(1)

    # ── Request loop ──
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
            req_type = request.get("type")

            if req_type == "transcribe":
                audio_path = request.get("path", "")
                if not audio_path or not os.path.isfile(audio_path):
                    send_error(f"Audio file not found: {audio_path}")
                    continue

                segments, info = model.transcribe(
                    audio_path,
                    beam_size=5,
                    vad_filter=True,
                )
                text_parts = [segment.text for segment in segments]
                text = " ".join(text_parts).strip()

                send({
                    "type": "result",
                    "text": text,
                    "language": info.language,
                    "language_probability": round(info.language_probability, 4),
                    "duration": round(info.duration, 2),
                })

            elif req_type == "shutdown":
                break

            else:
                send_error(f"Unknown request type: {req_type}")

        except json.JSONDecodeError as e:
            send_error(f"Invalid JSON: {e}")
        except Exception as e:
            send_error(f"Transcription failed: {e}")

    sys.stderr.write("A2T worker shutting down.\n")
    sys.stderr.flush()


if __name__ == "__main__":
    main()
