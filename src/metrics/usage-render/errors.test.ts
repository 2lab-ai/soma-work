import { describe, expect, it } from 'vitest';
import {
  EchartsInitError,
  FontLoadError,
  isSafeOperational,
  ResvgNativeError,
  SafeOperationalError,
  SlackPostError,
  SlackUploadError,
} from './errors';

// Trace: docs/usage-card/trace.md, Scenario 7
describe('usage-render errors', () => {
  it('all 5 subclasses are instanceof SafeOperationalError', () => {
    expect(new FontLoadError('a')).toBeInstanceOf(SafeOperationalError);
    expect(new EchartsInitError('a')).toBeInstanceOf(SafeOperationalError);
    expect(new ResvgNativeError('a')).toBeInstanceOf(SafeOperationalError);
    expect(new SlackUploadError('a')).toBeInstanceOf(SafeOperationalError);
    expect(new SlackPostError('a')).toBeInstanceOf(SafeOperationalError);
  });

  it('isSafeOperational narrows correctly', () => {
    expect(isSafeOperational(new FontLoadError('a'))).toBe(true);
    expect(isSafeOperational(new Error('a'))).toBe(false);
    expect(isSafeOperational(new RangeError('a'))).toBe(false);
    expect(isSafeOperational('string error')).toBe(false);
    expect(isSafeOperational(null)).toBe(false);
  });

  it('preserves name and cause', () => {
    const cause = new Error('root');
    const err = new FontLoadError('load failed', cause);
    expect(err.name).toBe('FontLoadError');
    expect(err.message).toBe('load failed');
    expect(err.cause).toBe(cause);
  });
});
