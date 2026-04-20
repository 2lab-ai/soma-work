/**
 * Error taxonomy for `/usage card` pipeline.
 * Only these 5 subclasses are whitelisted for text fallback; all other errors re-throw.
 * Trace: docs/usage-card-dark/trace.md, Scenario 13 (SafeOperationalError whitelist)
 */

export class SafeOperationalError extends Error {
  public readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.cause = cause;
  }
}

export class FontLoadError extends SafeOperationalError {}
export class EchartsInitError extends SafeOperationalError {}
export class ResvgNativeError extends SafeOperationalError {}
export class SlackUploadError extends SafeOperationalError {}
export class SlackPostError extends SafeOperationalError {}

export function isSafeOperational(err: unknown): err is SafeOperationalError {
  return err instanceof SafeOperationalError;
}
