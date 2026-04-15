/**
 * A2T (Audio-to-Text) service types.
 * Whisper v3 Turbo based transcription service — plugin pattern.
 */

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
