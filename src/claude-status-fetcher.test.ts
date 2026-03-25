/**
 * Contract Tests (RED) for claude-status-fetcher
 * Trace: docs/api-error-status/trace.md
 *
 * All tests must FAIL (RED) until implementation exists.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// These imports will fail until the module is created — that's the RED state
import {
  fetchClaudeStatus,
  formatStatusForSlack,
  invalidateStatusCache,
  isApiLikeError,
  type ClaudeStatusInfo,
} from './claude-status-fetcher';

// === Sample HTML fixtures ===

const SAMPLE_HTML_MIXED_STATUS = `
<div class="component-container status-red">
  <div class="component-inner-container status-red">
    <div class="name">Claude API (api.anthropic.com)</div>
    <div class="component-status">Partial Outage</div>
  </div>
</div>
<div class="component-container status-yellow">
  <div class="component-inner-container status-yellow">
    <div class="name">Claude Code</div>
    <div class="component-status">Degraded Performance</div>
  </div>
</div>
<div class="component-container status-green">
  <div class="component-inner-container status-green">
    <div class="name">Claude for Government</div>
    <div class="component-status">Operational</div>
  </div>
</div>
<div class="incident-container impact-major">
  <div class="incident-title impact-major">
    <a>Elevated errors on Claude Opus 4.6</a>
  </div>
  <div class="updates">
    <div>Investigating</div>
  </div>
</div>
`;

const SAMPLE_HTML_ALL_OPERATIONAL = `
<div class="component-container status-green">
  <div class="component-inner-container status-green">
    <div class="name">claude.ai</div>
    <div class="component-status">Operational</div>
  </div>
</div>
<div class="component-container status-green">
  <div class="component-inner-container status-green">
    <div class="name">Claude API (api.anthropic.com)</div>
    <div class="component-status">Operational</div>
  </div>
</div>
<div class="component-container status-green">
  <div class="component-inner-container status-green">
    <div class="name">Claude Code</div>
    <div class="component-status">Operational</div>
  </div>
</div>
`;

// ============================================================
// Scenario 1 — Fetch and display status on API error
// ============================================================

describe('Scenario 1 — Fetch and display status on API error', () => {
  beforeEach(() => {
    invalidateStatusCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Trace: S1, Section 3b — component parsing
  it('fetchClaudeStatus_parsesComponentStatuses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(SAMPLE_HTML_MIXED_STATUS),
    }));

    const status = await fetchClaudeStatus();

    expect(status).not.toBeNull();
    expect(status!.components).toContainEqual(
      expect.objectContaining({ name: expect.stringContaining('Claude API'), status: 'outage' })
    );
    expect(status!.components).toContainEqual(
      expect.objectContaining({ name: expect.stringContaining('Claude Code'), status: 'degraded' })
    );
    expect(status!.components).toContainEqual(
      expect.objectContaining({ name: expect.stringContaining('Government'), status: 'operational' })
    );
  });

  // Trace: S1, Section 3b — incident parsing
  it('fetchClaudeStatus_parsesIncidents', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(SAMPLE_HTML_MIXED_STATUS),
    }));

    const status = await fetchClaudeStatus();

    expect(status).not.toBeNull();
    expect(status!.incidents.length).toBeGreaterThan(0);
    expect(status!.incidents[0].title).toContain('Elevated errors');
  });

  // Trace: S1, Section 3b — overall derivation
  it('fetchClaudeStatus_derivesOverallStatus', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(SAMPLE_HTML_MIXED_STATUS),
    }));

    const status = await fetchClaudeStatus();

    expect(status).not.toBeNull();
    // Has a red component → overall should be 'outage'
    expect(status!.overall).toBe('outage');
  });

  // Trace: S1, Section 5 — timeout
  it('fetchClaudeStatus_returnsNullOnTimeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError')));

    const status = await fetchClaudeStatus();

    expect(status).toBeNull();
  });

  // Trace: S1, Section 5 — network error
  it('fetchClaudeStatus_returnsNullOnNetworkError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));

    const status = await fetchClaudeStatus();

    expect(status).toBeNull();
  });

  // Trace: S1, Section 5 — parse failure
  it('fetchClaudeStatus_returnsNullOnParseFailure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('<html><body>totally different page</body></html>'),
    }));

    const status = await fetchClaudeStatus();

    // Should return null or an empty-but-valid result, never throw
    // If components is empty, that's acceptable graceful degradation
    expect(status === null || status.components.length === 0).toBe(true);
  });
});

// ============================================================
// Scenario 2 — Cache hit on repeated errors
// ============================================================

describe('Scenario 2 — Cache hit on repeated errors', () => {
  beforeEach(() => {
    invalidateStatusCache();
    vi.restoreAllMocks();
  });

  // Trace: S2, Section 3a — cache hit
  it('fetchClaudeStatus_returnsCachedOnSecondCall', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(SAMPLE_HTML_MIXED_STATUS),
    });
    vi.stubGlobal('fetch', mockFetch);

    const first = await fetchClaudeStatus();
    const second = await fetchClaudeStatus();

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).toEqual(first);
    // fetch should only be called once — second call served from cache
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // Trace: S2, Section 3a — cache expiry
  it('fetchClaudeStatus_refetchesAfterTTLExpiry', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(SAMPLE_HTML_ALL_OPERATIONAL),
    });
    vi.stubGlobal('fetch', mockFetch);

    vi.useFakeTimers();

    await fetchClaudeStatus();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Advance past TTL (2 minutes)
    vi.advanceTimersByTime(2 * 60 * 1000 + 1);

    await fetchClaudeStatus();
    expect(mockFetch).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});

// ============================================================
// Scenario 3 — Graceful degradation when unreachable
// ============================================================

describe('Scenario 3 — Graceful degradation when unreachable', () => {
  beforeEach(() => {
    invalidateStatusCache();
    vi.restoreAllMocks();
  });

  // Trace: S3, Section 3a
  it('fetchClaudeStatus_returnsNullOnFetchError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const status = await fetchClaudeStatus();
    expect(status).toBeNull();
  });

  // Trace: S3, Section 4
  it('fetchClaudeStatus_doesNotCacheNull', async () => {
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(SAMPLE_HTML_ALL_OPERATIONAL),
      });
    vi.stubGlobal('fetch', mockFetch);

    const first = await fetchClaudeStatus();
    expect(first).toBeNull();

    const second = await fetchClaudeStatus();
    expect(second).not.toBeNull();
    // Both calls should have hit the network (null was not cached)
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ============================================================
// Scenario 4 — All systems operational display
// ============================================================

describe('Scenario 4 — Format status for Slack', () => {
  // Trace: S4, Section 3a — single line all operational
  it('formatStatusForSlack_allOperational', () => {
    const status: ClaudeStatusInfo = {
      overall: 'operational',
      components: [
        { name: 'claude.ai', status: 'operational' },
        { name: 'Claude API', status: 'operational' },
        { name: 'Claude Code', status: 'operational' },
      ],
      incidents: [],
      fetchedAt: Date.now(),
    };

    const result = formatStatusForSlack(status);

    expect(result).toContain('All Systems Operational');
    expect(result).toContain(':large_green_circle:');
    // Should be a concise single-line format, not per-component listing
    expect(result.split('\n').filter(l => l.trim()).length).toBeLessThanOrEqual(2);
  });

  // Trace: S4, Section 3b — multi-line mixed statuses
  it('formatStatusForSlack_mixedStatuses', () => {
    const status: ClaudeStatusInfo = {
      overall: 'outage',
      components: [
        { name: 'Claude API', status: 'outage' },
        { name: 'Claude Code', status: 'degraded' },
        { name: 'Claude for Government', status: 'operational' },
      ],
      incidents: [],
      fetchedAt: Date.now(),
    };

    const result = formatStatusForSlack(status);

    expect(result).toContain(':red_circle:');
    expect(result).toContain('Claude API');
    expect(result).toContain(':large_yellow_circle:');
    expect(result).toContain('Claude Code');
    expect(result).toContain(':large_green_circle:');
    expect(result).toContain('Government');
  });

  // Trace: S4, Section 3b — with incidents
  it('formatStatusForSlack_withIncidents', () => {
    const status: ClaudeStatusInfo = {
      overall: 'degraded',
      components: [
        { name: 'Claude API', status: 'degraded' },
      ],
      incidents: [
        { title: 'Elevated errors on Claude Opus 4.6', status: 'Investigating' },
        { title: 'Connection reset errors', status: 'Monitoring' },
      ],
      fetchedAt: Date.now(),
    };

    const result = formatStatusForSlack(status);

    expect(result).toContain('Elevated errors');
    expect(result).toContain('Investigating');
    expect(result).toContain('Connection reset');
    expect(result).toContain('Monitoring');
  });
});

// ============================================================
// Scenario 5 — Integration into stream-executor error flow
// ============================================================

describe('Scenario 5 — isApiError detection', () => {
  // These tests validate the error classification logic that will be added
  // to stream-executor.ts. Since isApiError is a private method, we test
  // the exported helper or the integration behavior.

  // For RED state, we import and test the standalone helper.
  // Trace: S5, Section 3b — HTTP status codes
  it('isApiError_detectsHttpStatusCodes', () => {
    expect(isApiLikeError({ message: 'API Error: 500 Internal server error' })).toBe(true);
    expect(isApiLikeError({ message: 'Error 502 Bad Gateway' })).toBe(true);
    expect(isApiLikeError({ message: 'HTTP 429 Too Many Requests' })).toBe(true);
    expect(isApiLikeError({ message: 'Error 403 Forbidden' })).toBe(true);
  });

  // Trace: S5, Section 3b — API keywords
  it('isApiError_detectsApiKeywords', () => {
    expect(isApiLikeError({ message: 'service unavailable' })).toBe(true);
    expect(isApiLikeError({ message: 'temporarily unavailable' })).toBe(true);
    expect(isApiLikeError({ message: 'overloaded' })).toBe(true);
    expect(isApiLikeError({ message: 'rate limit exceeded' })).toBe(true);
    expect(isApiLikeError({ message: 'connection reset by peer' })).toBe(true);
  });

  // Trace: S5, Section 5 — Slack errors excluded
  it('isApiError_rejectsSlackErrors', () => {
    expect(isApiLikeError({ message: 'invalid_blocks' })).toBe(false);
    expect(isApiLikeError({ message: 'channel_not_found' })).toBe(false);
    expect(isApiLikeError({ message: 'An API error occurred: rate_limited' })).toBe(false);
  });

  // Review fix: no false-positives on incidental numbers
  it('isApiError_noFalsePositiveOnIncidentalNumbers', () => {
    expect(isApiLikeError({ message: 'processed 412 tokens before failure' })).toBe(false);
    expect(isApiLikeError({ message: 'timeout after 450ms' })).toBe(false);
    expect(isApiLikeError({ message: 'connection to port 443 failed' })).toBe(false);
  });
});

describe('Scenario 5 — formatErrorForUser with status', () => {
  // Trace: S5, Section 3c — status block appended
  it('formatErrorForUser_appendsStatusBlock', () => {
    const status: ClaudeStatusInfo = {
      overall: 'outage',
      components: [{ name: 'Claude API', status: 'outage' }],
      incidents: [{ title: 'API errors', status: 'Investigating' }],
      fetchedAt: Date.now(),
    };

    const formatted = formatStatusForSlack(status);

    // The formatted status should be a non-empty string suitable for appending
    expect(formatted.length).toBeGreaterThan(0);
    expect(formatted).toContain('Claude Service Status');
  });

  // Trace: S5, Section 3c — null status omitted
  it('formatErrorForUser_omitsStatusWhenNull', () => {
    // formatStatusForSlack should handle null gracefully or not be called
    // The integration test verifies that null status = no status block
    const result = formatStatusForSlack(null as any);

    // Should return empty string when given null/undefined
    expect(result).toBe('');
  });
});
