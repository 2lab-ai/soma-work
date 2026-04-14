/**
 * A2T Service — Audio-to-Text transcription using Whisper v3 Turbo.
 *
 * Plugin-pattern service: loadable/unloadable, reports status,
 * checks memory before init, degrades gracefully when unavailable.
 *
 * Uses a long-running Python subprocess (faster-whisper) for inference.
 * Model loads once on init; stays in memory until shutdown.
 */

import { type ChildProcess, spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { Logger } from '../logger';
import type { A2tConfig, A2tStatus, TranscriptionResult } from './types';

export type { A2tConfig, A2tStatus, TranscriptionResult } from './types';

const logger = new Logger('A2tService');

// ── Singleton ──────────────────────────────────────────────

let instance: A2tService | null = null;

/** Get the current A2T service instance (null if not initialized). */
export function getA2tService(): A2tService | null {
  return instance;
}

/**
 * Initialize the A2T service singleton. Non-critical — returns null on failure.
 * Safe to call when Python or faster-whisper is not installed.
 */
export async function initA2tService(config: A2tConfig = {}): Promise<A2tService | null> {
  if (instance) {
    logger.warn('A2T service already initialized');
    return instance;
  }

  const service = new A2tService(config);
  try {
    await service.initialize();
    instance = service;
    return instance;
  } catch (error) {
    // Non-critical — bot runs without transcription
    logger.warn('A2T service unavailable', { error: (error as Error).message });
    return null;
  }
}

/** Shutdown the A2T service singleton. */
export async function shutdownA2tService(): Promise<void> {
  if (instance) {
    await instance.shutdown();
    instance = null;
  }
}

// ── Service Class ──────────────────────────────────────────

/** Request timeout for transcription (5 minutes — long audio files) */
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
/** Init timeout (model download + load can be slow on first run) */
const INIT_TIMEOUT_MS = 10 * 60 * 1000;

export class A2tService {
  private process: ChildProcess | null = null;
  private status: A2tStatus = { state: 'not_initialized' };
  private config: Required<A2tConfig>;
  private rl: readline.Interface | null = null;
  private pendingResponse: {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(config: A2tConfig = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      model: config.model ?? 'large-v3-turbo',
      device: config.device ?? 'auto',
      computeType: config.computeType ?? 'auto',
      minMemoryMb: config.minMemoryMb ?? 2000,
      pythonPath: config.pythonPath ?? 'python3',
    };
    if (!this.config.enabled) {
      this.status = { state: 'disabled' };
    }
  }

  // ── Public API ─────────────────────────────────────────

  getStatus(): A2tStatus {
    return this.status;
  }

  isReady(): boolean {
    return this.status.state === 'ready';
  }

  /** Human-readable status message (for prompt injection). */
  getStatusMessage(): string {
    switch (this.status.state) {
      case 'disabled':
        return 'A2T service is disabled in configuration.';
      case 'not_initialized':
        return 'A2T service not initialized.';
      case 'initializing':
        return `A2T service loading model: ${this.status.model}...`;
      case 'ready':
        return `A2T ready (model: ${this.status.model}, device: ${this.status.device})`;
      case 'error':
        return `A2T service error: ${this.status.error}`;
      case 'shutdown':
        return 'A2T service shut down.';
    }
  }

  /**
   * Transcribe an audio file. Returns transcription result or throws.
   * Caller should check isReady() first for graceful UX.
   */
  async transcribe(audioPath: string): Promise<TranscriptionResult> {
    if (!this.isReady()) {
      throw new Error(this.getStatusMessage());
    }

    const response = await this.sendRequest({ type: 'transcribe', path: audioPath });

    if (response.type === 'error') {
      throw new Error(response.error);
    }

    return {
      text: response.text || '',
      language: response.language || 'unknown',
      languageProbability: response.language_probability ?? 0,
      duration: response.duration ?? 0,
    };
  }

  // ── Lifecycle ──────────────────────────────────────────

  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      logger.info('A2T service disabled by configuration');
      return;
    }

    // Memory pre-check (Node.js side)
    const availableMb = os.freemem() / (1024 * 1024);
    if (availableMb < this.config.minMemoryMb) {
      const msg = `Insufficient memory: ${Math.round(availableMb)}MB available, ${this.config.minMemoryMb}MB required`;
      this.status = { state: 'error', error: msg };
      throw new Error(msg);
    }

    this.status = { state: 'initializing', model: this.config.model };
    const workerPath = path.resolve(__dirname, '../../services/a2t/worker.py');

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          clearTimeout(initTimer);
          fn();
        }
      };

      const initTimer = setTimeout(() => {
        settle(() => {
          const msg = 'A2T initialization timed out';
          this.status = { state: 'error', error: msg };
          this.kill();
          reject(new Error(msg));
        });
      }, INIT_TIMEOUT_MS);

      this.process = spawn(this.config.pythonPath, ['-u', workerPath], {
        env: {
          ...process.env,
          A2T_MODEL: this.config.model,
          A2T_DEVICE: this.config.device,
          A2T_COMPUTE_TYPE: this.config.computeType,
          A2T_MIN_MEMORY_MB: String(this.config.minMemoryMb),
          PYTHONUNBUFFERED: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.process.on('error', (err) => {
        settle(() => {
          const msg = err.message.includes('ENOENT')
            ? `Python not found at '${this.config.pythonPath}'. Install Python 3 and faster-whisper to enable A2T.`
            : `Worker spawn error: ${err.message}`;
          this.status = { state: 'error', error: msg };
          reject(new Error(msg));
        });
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        const text = data.toString().trim();
        if (text) logger.debug(`[a2t-worker] ${text}`);
      });

      this.rl = readline.createInterface({ input: this.process.stdout! });

      // First line determines init success/failure
      this.rl.once('line', (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'ready') {
            settle(() => {
              this.status = { state: 'ready', model: msg.model, device: msg.device || this.config.device };
              logger.info('A2T service ready', { model: msg.model, device: msg.device });
              this.rl!.on('line', (l) => this.handleLine(l));
              resolve();
            });
          } else if (msg.type === 'error') {
            settle(() => {
              this.status = { state: 'error', error: msg.error };
              reject(new Error(msg.error));
            });
          } else {
            settle(() => reject(new Error(`Unexpected init message type: ${msg.type}`)));
          }
        } catch {
          settle(() => reject(new Error(`Invalid worker response: ${line}`)));
        }
      });

      this.process.on('exit', (code) => {
        // During init: reject
        settle(() => {
          const msg = `Worker exited during init (code ${code})`;
          this.status = { state: 'error', error: msg };
          reject(new Error(msg));
        });
        // Post-init: mark error and reject pending request
        if (settled && this.status.state !== 'shutdown') {
          this.status = { state: 'error', error: `Worker exited unexpectedly (code ${code})` };
          logger.error('A2T worker exited', { code });
          this.rejectPending(`Worker exited (code ${code})`);
        }
      });
    });
  }

  async shutdown(): Promise<void> {
    this.status = { state: 'shutdown' };
    this.rejectPending('Service shutting down');

    if (this.process?.stdin?.writable) {
      try {
        this.process.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n');
      } catch {
        // stdin may already be closed
      }
    }

    // Give process 3 seconds to exit gracefully
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.kill();
        resolve();
      }, 3000);

      if (this.process) {
        this.process.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      } else {
        clearTimeout(timer);
        resolve();
      }
    });

    this.rl?.close();
    this.rl = null;
    this.process = null;
    logger.info('A2T service shut down');
  }

  // ── Internal ───────────────────────────────────────────

  private sendRequest(request: object): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.pendingResponse) {
        reject(new Error('A2T service is busy with another request'));
        return;
      }

      if (!this.process?.stdin?.writable) {
        reject(new Error('A2T worker process not available'));
        return;
      }

      const timer = setTimeout(() => {
        this.rejectPending('Transcription timed out');
      }, REQUEST_TIMEOUT_MS);

      this.pendingResponse = { resolve, reject, timer };
      this.process.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  private handleLine(line: string): void {
    if (!this.pendingResponse) {
      logger.warn('Received unexpected message from worker', { line });
      return;
    }

    const { resolve, reject, timer } = this.pendingResponse;
    this.pendingResponse = null;
    clearTimeout(timer);

    try {
      const msg = JSON.parse(line);
      if (msg.type === 'error') {
        reject(new Error(msg.error));
      } else {
        resolve(msg);
      }
    } catch {
      reject(new Error(`Invalid worker response: ${line}`));
    }
  }

  private rejectPending(reason: string): void {
    if (this.pendingResponse) {
      clearTimeout(this.pendingResponse.timer);
      this.pendingResponse.reject(new Error(reason));
      this.pendingResponse = null;
    }
  }

  private kill(): void {
    try {
      this.process?.kill('SIGKILL');
    } catch {
      // already dead
    }
  }
}
