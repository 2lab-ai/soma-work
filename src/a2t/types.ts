/**
 * A2T (Audio-to-Text) service types.
 * Whisper v3 Turbo based transcription service — plugin pattern.
 */

/** Configuration for live dictation (`/ws/dictation`) inside config.json "a2t.dictation". */
export interface A2tDictationConfig {
  /** Enable/disable live dictation. Default: true */
  enabled?: boolean;
  /** Minimum free memory in MB required for local dictation worker. Default: 4000 */
  minMemoryMb?: number;
  /** STT provider: 'auto' (local Whisper) | 'local' | 'deepgram' | 'openai' | 'auto-cloud' (deepgram → local → openai). */
  provider?: 'auto' | 'local' | 'deepgram' | 'openai' | 'auto-cloud';
  /** Optional model override (e.g. 'nova-3', 'gpt-4o-transcribe', 'large-v3', 'large-v3-turbo'). */
  model?: string;
  /** Extra domain/project vocabulary terms biased during dictation. */
  keyterms?: string[];
  /** Custom API URL for cloud/OpenAI-compatible providers. */
  apiUrl?: string;
  /** Explicit API key (prefer DEEPGRAM_API_KEY / OPENAI_API_KEY env vars). */
  apiKey?: string;
}

/** Configuration for the A2T service (from config.json "a2t" section) */
export interface A2tConfig {
  /** Enable/disable the service. Default: true */
  enabled?: boolean;
  /** Whisper model name. Default: 'large-v3-turbo' */
  model?: string;
  /** Device: 'auto' | 'cpu' | 'cuda'. Default: 'auto' */
  device?: string;
  /** CTranslate2 compute type: 'auto' | 'int8' | 'float16' | 'float32'. Default: 'auto' */
  computeType?: string;
  /** Minimum FREE memory in MB required to start the service. Default: 16000 (16GB) */
  minMemoryMb?: number;
  /** Path to Python 3 executable. Default: 'python3' */
  pythonPath?: string;
  /** 'auto' (mlx-whisper on Apple Silicon when installed, else faster-whisper) | 'mlx' | 'faster-whisper'. Default: 'auto' */
  backend?: string;
  /** 받아쓰기 (live dictation): worker + optional cloud streaming STT configuration. */
  dictation?: A2tDictationConfig;
}

/** Transcription result from the worker */
export interface TranscriptionResult {
  text: string;
  language: string;
  languageProbability: number;
  duration: number;
}

/** Service lifecycle status */
export type A2tStatus =
  | { state: 'disabled' }
  | { state: 'not_initialized' }
  | { state: 'initializing'; model: string }
  | { state: 'ready'; model: string; device: string }
  | { state: 'error'; error: string }
  | { state: 'shutdown' };
