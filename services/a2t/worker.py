#!/usr/bin/env python3
"""
A2T Worker — Whisper v3 Turbo transcription service.

Long-running process. Communicates with Node.js host via stdin/stdout JSON.
Model loads once on startup; stays in memory for fast subsequent transcriptions.

Protocol:
  → {"type": "transcribe", "path": "/tmp/audio.wav"}
  ← {"type": "result", "text": "...", "language": "en", "language_probability": 0.98, "duration": 3.5}
  → {"type": "transcribe_pcm", "pcm": "<base64 16 kHz mono s16le>", "language": "ko", "prompt": "..."}
  ← {"type": "result", "text": "...", "language": "ko", "duration": 2.5}      (받아쓰기 — one window of a live stream)
  → {"type": "shutdown"}
  (process exits)

Startup:
  ← {"type": "ready", "model": "large-v3-turbo", "device": "cpu", "backend": "faster-whisper"}

Backend (A2T_BACKEND): "mlx" (mlx-whisper on the Apple GPU), "faster-whisper" (CTranslate2), or "auto" — mlx on
Apple Silicon when mlx-whisper is installed, faster-whisper otherwise.
  OR
  ← {"type": "error", "error": "..."}
"""

import base64
import json
import os
import platform
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


MLX_MODELS = {
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
}


def pick_backend(wanted: str) -> str:
    """The backend to load: the one asked for, or on "auto" mlx on Apple Silicon when it is installed."""
    if wanted in ("mlx", "faster-whisper"):
        return wanted
    if sys.platform == "darwin" and platform.machine() == "arm64":
        try:
            import mlx_whisper  # noqa: F401
            return "mlx"
        except ImportError:
            pass
    return "faster-whisper"


class MlxModel:
    """mlx-whisper behind the same two calls as faster-whisper's WhisperModel use here."""

    def __init__(self, model_name: str):
        import mlx_whisper
        import numpy as np

        self.mlx_whisper = mlx_whisper
        self.np = np
        self.repo = model_name if "/" in model_name else MLX_MODELS.get(model_name, model_name)
        # Load (and compile) once now, so the first dictation does not wait for it.
        self.mlx_whisper.transcribe(np.zeros(16000, dtype=np.float32), path_or_hf_repo=self.repo, language="en")

    def file(self, path: str) -> dict:
        r = self.mlx_whisper.transcribe(path, path_or_hf_repo=self.repo)
        return {"text": str(r.get("text", "")).strip(), "language": r.get("language", "unknown"), "language_probability": 1.0, "duration": 0}

    def pcm(self, audio, language, prompt) -> str:
        r = self.mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=self.repo,
            language=language or None,
            initial_prompt=prompt or None,
            condition_on_previous_text=False,
            temperature=0.0,
        )
        return " ".join(
            str(seg.get("text", "")).strip()
            for seg in r.get("segments", [])
            if not (seg.get("no_speech_prob", 0) > 0.6 and seg.get("avg_logprob", 0) < -1.0)
        ).strip()


def pcm_audio(b64: str):
    """16 kHz mono s16le, base64 → float32 in [-1, 1]."""
    import numpy as np

    raw = base64.b64decode(b64)
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


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

    backend = pick_backend(os.environ.get("A2T_BACKEND", "auto"))

    # ── Load model ──
    if backend == "mlx":
        try:
            sys.stderr.write(f"Loading Whisper model '{model_name}' with mlx-whisper...\n")
            sys.stderr.flush()
            model = MlxModel(model_name)
            send({"type": "ready", "model": model_name, "device": "mps", "backend": "mlx"})
        except ImportError as e:
            send_error(f"mlx-whisper not installed: {e}")
            sys.exit(1)
        except Exception as e:
            send_error(f"Failed to load model: {e}")
            sys.exit(1)
        serve(model, backend)
        return

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

        send({"type": "ready", "model": model_name, "device": actual_device, "backend": "faster-whisper"})

    except ImportError as e:
        send_error(f"faster-whisper not installed: {e}")
        sys.exit(1)
    except Exception as e:
        send_error(f"Failed to load model: {e}")
        sys.exit(1)

    serve(model, backend)


def serve(model, backend: str) -> None:
    """The request loop: one request at a time, one answer per request."""
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

                if backend == "mlx":
                    send({"type": "result", **model.file(audio_path)})
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

            elif req_type == "transcribe_pcm":
                audio = pcm_audio(request.get("pcm", ""))
                language = request.get("language") or None
                prompt = request.get("prompt") or None
                if backend == "mlx":
                    text = model.pcm(audio, language, prompt)
                else:
                    segments, _info = model.transcribe(
                        audio,
                        language=language,
                        beam_size=1,
                        temperature=0.0,
                        initial_prompt=prompt,
                        condition_on_previous_text=False,
                        vad_filter=False,
                    )
                    text = " ".join(
                        seg.text.strip()
                        for seg in segments
                        if not (seg.no_speech_prob > 0.6 and seg.avg_logprob < -1.0)
                    ).strip()
                send({"type": "result", "text": text, "language": language or "", "duration": round(len(audio) / 16000, 2)})

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
