/**
 * Dashboard Echo — Tests for the echo-to-Slack behavior when messages
 * are sent from the dashboard (src/index.ts setDashboardCommandHandler).
 *
 * Covers: mrkdwn escape, ownerName fallback, echoResult.ts capture, error handling.
 */
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers — mirror the inline logic from src/index.ts so we can unit-test it
// without importing the entire start() closure.
// ---------------------------------------------------------------------------

/** Slack mrkdwn escape — same 3-char replacement used in the handler */
function escapeSlackMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Build the echo text exactly as the handler does */
function buildEchoText(ownerName: string | undefined, message: string): string {
  const senderName = ownerName || 'Dashboard';
  const escapedName = escapeSlackMrkdwn(senderName);
  const escapedMessage = escapeSlackMrkdwn(message);
  return `${escapedName}: ${escapedMessage}`;
}

/** Derive synthetic event ts from echoResult, matching the handler logic */
function deriveSyntheticTs(echoResultTs: string | undefined): string {
  return echoResultTs || String(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Dashboard Echo: mrkdwn escape', () => {
  it('escapes ampersand, less-than, greater-than', () => {
    expect(escapeSlackMrkdwn('A & B')).toBe('A &amp; B');
    expect(escapeSlackMrkdwn('<script>')).toBe('&lt;script&gt;');
    expect(escapeSlackMrkdwn('a > b & c < d')).toBe('a &gt; b &amp; c &lt; d');
  });

  it('leaves normal text unchanged', () => {
    expect(escapeSlackMrkdwn('Hello world')).toBe('Hello world');
  });

  it('escapes Slack special mentions', () => {
    expect(escapeSlackMrkdwn('<!here> alert')).toBe('&lt;!here&gt; alert');
    expect(escapeSlackMrkdwn('<@U1234>')).toBe('&lt;@U1234&gt;');
    expect(escapeSlackMrkdwn('<https://evil.com|legit>')).toBe('&lt;https://evil.com|legit&gt;');
  });
});

describe('Dashboard Echo: ownerName fallback', () => {
  it('uses ownerName when present', () => {
    expect(buildEchoText('Alice', 'hi')).toBe('Alice: hi');
  });

  it('falls back to Dashboard when ownerName is undefined', () => {
    expect(buildEchoText(undefined, 'hi')).toBe('Dashboard: hi');
  });

  it('falls back to Dashboard when ownerName is empty', () => {
    expect(buildEchoText('', 'hi')).toBe('Dashboard: hi');
  });

  it('escapes senderName that contains mrkdwn chars', () => {
    expect(buildEchoText('A & B <admin>', 'msg')).toBe('A &amp; B &lt;admin&gt;: msg');
  });
});

describe('Dashboard Echo: echoResult.ts capture', () => {
  it('uses echoResult.ts when postMessage succeeds', () => {
    const ts = deriveSyntheticTs('1712700000.000100');
    expect(ts).toBe('1712700000.000100');
  });

  it('falls back to generated ts when echoResult is undefined', () => {
    const before = Date.now() / 1000;
    const ts = deriveSyntheticTs(undefined);
    const after = Date.now() / 1000;
    const numeric = parseFloat(ts);
    expect(numeric).toBeGreaterThanOrEqual(before);
    expect(numeric).toBeLessThanOrEqual(after);
  });
});

describe('Dashboard Echo: error handling', () => {
  it('catch returns undefined so echoResult is safely optional', async () => {
    const mockPostMessage = vi.fn().mockRejectedValue(new Error('channel_not_found'));
    const echoResult = await mockPostMessage().catch(() => undefined);
    expect(echoResult).toBeUndefined();
    const ts = deriveSyntheticTs(echoResult?.ts);
    expect(parseFloat(ts)).toBeGreaterThan(0);
  });
});
