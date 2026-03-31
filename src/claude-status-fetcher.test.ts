/**
 * Contract Tests (RED) for claude-status-fetcher
 * Trace: docs/api-error-status/trace.md
 *
 * All tests must FAIL (RED) until implementation exists.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// These imports will fail until the module is created — that's the RED state
import {
  type ClaudeStatusInfo,
  fetchClaudeStatus,
  formatStatusForSlack,
  invalidateStatusCache,
  isApiLikeError,
  shouldShowStatusBlock,
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
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // Trace: S1, Section 3b — component parsing
  it('fetchClaudeStatus_parsesComponentStatuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(SAMPLE_HTML_MIXED_STATUS),
      }),
    );

    const status = await fetchClaudeStatus();

    expect(status).not.toBeNull();
    expect(status!.components).toContainEqual(
      expect.objectContaining({ name: expect.stringContaining('Claude API'), status: 'outage' }),
    );
    expect(status!.components).toContainEqual(
      expect.objectContaining({ name: expect.stringContaining('Claude Code'), status: 'degraded' }),
    );
    expect(status!.components).toContainEqual(
      expect.objectContaining({ name: expect.stringContaining('Government'), status: 'operational' }),
    );
  });

  // Trace: S1, Section 3b — incident parsing
  it('fetchClaudeStatus_parsesIncidents', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(SAMPLE_HTML_MIXED_STATUS),
      }),
    );

    const status = await fetchClaudeStatus();

    expect(status).not.toBeNull();
    expect(status!.incidents.length).toBeGreaterThan(0);
    expect(status!.incidents[0].title).toContain('Elevated errors');
  });

  // Trace: S1, Section 3b — overall derivation
  it('fetchClaudeStatus_derivesOverallStatus', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(SAMPLE_HTML_MIXED_STATUS),
      }),
    );

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
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<html><body>totally different page</body></html>'),
      }),
    );

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

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
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

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // Trace: S3, Section 3a
  it('fetchClaudeStatus_returnsNullOnFetchError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const status = await fetchClaudeStatus();
    expect(status).toBeNull();
  });

  // Trace: S3, Section 4
  it('fetchClaudeStatus_doesNotCacheNull', async () => {
    vi.useFakeTimers();

    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(SAMPLE_HTML_ALL_OPERATIONAL),
      });
    vi.stubGlobal('fetch', mockFetch);

    const first = await fetchClaudeStatus();
    expect(first).toBeNull();

    // Advance past negative cache backoff (30s)
    vi.advanceTimersByTime(31 * 1000);

    const second = await fetchClaudeStatus();
    expect(second).not.toBeNull();
    // Both calls should have hit the network (null was not cached permanently)
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
    expect(result.split('\n').filter((l) => l.trim()).length).toBeLessThanOrEqual(2);
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
      components: [{ name: 'Claude API', status: 'degraded' }],
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

// ============================================================
// S1 — Fix unknown status overall derivation (Bug 4)
// ============================================================

describe('S1 — unknown status overall derivation', () => {
  beforeEach(() => {
    invalidateStatusCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('overall_unknown_when_all_components_unknown', async () => {
    const html = `
<div class="component-container status-purple">
  <div class="component-inner-container status-purple">
    <div class="name">Claude API</div>
    <div class="component-status">Unknown</div>
  </div>
</div>
<div class="component-container status-blue">
  <div class="component-inner-container status-blue">
    <div class="name">Claude Code</div>
    <div class="component-status">Unknown</div>
  </div>
</div>`;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(html),
      }),
    );

    const status = await fetchClaudeStatus();

    expect(status).not.toBeNull();
    // Bug 4: should be 'unknown', not 'operational'
    expect(status!.overall).toBe('unknown');
  });

  it('overall_unknown_when_mix_of_operational_and_unknown', async () => {
    const html = `
<div class="component-container status-green">
  <div class="component-inner-container status-green">
    <div class="name">Claude API</div>
    <div class="component-status">Operational</div>
  </div>
</div>
<div class="component-container status-purple">
  <div class="component-inner-container status-purple">
    <div class="name">Claude Code</div>
    <div class="component-status">Unknown</div>
  </div>
</div>`;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(html),
      }),
    );

    const status = await fetchClaudeStatus();

    expect(status).not.toBeNull();
    expect(status!.overall).toBe('unknown');
  });
});

// ============================================================
// S2 — Fix operational+incidents guard (Bug 5)
// ============================================================

describe('S2 — operational with incidents visibility', () => {
  it('formatStatusForSlack_operational_with_incidents_shows_full_block', () => {
    const status: ClaudeStatusInfo = {
      overall: 'operational',
      components: [
        { name: 'Claude API', status: 'operational' },
        { name: 'Claude Code', status: 'operational' },
      ],
      incidents: [{ title: 'Investigating elevated latency', status: 'Investigating' }],
      fetchedAt: Date.now(),
    };

    const result = formatStatusForSlack(status);

    // Should show incidents even when overall is operational
    expect(result).toContain('Investigating elevated latency');
    expect(result).toContain('Active Incidents');
  });
});

// ============================================================
// S3 — Inflight coalescing test
// ============================================================

describe('S3 — Inflight coalescing', () => {
  beforeEach(() => {
    invalidateStatusCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('concurrent_calls_share_single_fetch', async () => {
    let resolveFirst: (value: any) => void;
    const fetchPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });

    const mockFetch = vi.fn().mockReturnValue(fetchPromise);
    vi.stubGlobal('fetch', mockFetch);

    // Fire 3 concurrent calls
    const p1 = fetchClaudeStatus();
    const p2 = fetchClaudeStatus();
    const p3 = fetchClaudeStatus();

    // Resolve the single fetch
    resolveFirst!({
      ok: true,
      text: () => Promise.resolve(SAMPLE_HTML_MIXED_STATUS),
    });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    // All should get same result
    expect(r1).not.toBeNull();
    expect(r2).toEqual(r1);
    expect(r3).toEqual(r1);

    // Only ONE fetch call
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('failed_inflight_allows_retry', async () => {
    vi.useFakeTimers();

    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(SAMPLE_HTML_ALL_OPERATIONAL),
      });
    vi.stubGlobal('fetch', mockFetch);

    const first = await fetchClaudeStatus();
    expect(first).toBeNull();

    // Advance past negative cache backoff (30s)
    vi.advanceTimersByTime(31 * 1000);

    // After failure + backoff, inflight should be cleared, allowing retry
    const second = await fetchClaudeStatus();
    expect(second).not.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ============================================================
// S4 — Regex robustness tests
// ============================================================

describe('S4 — Regex robustness', () => {
  beforeEach(() => {
    invalidateStatusCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('parser_handles_extra_css_classes', async () => {
    const html = `
<div class="component-container border-color status-red" data-component-id="abc123">
  <div class="component-inner-container border-color status-red">
    <div class="name">Claude API</div>
    <div class="component-status">Partial Outage</div>
  </div>
</div>`;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(html),
      }),
    );

    const status = await fetchClaudeStatus();

    expect(status).not.toBeNull();
    expect(status!.components.length).toBe(1);
    expect(status!.components[0].name).toBe('Claude API');
    expect(status!.components[0].status).toBe('outage');
  });

  it('parser_strips_html_from_component_names', async () => {
    const html = `
<div class="component-container status-green">
  <div class="component-inner-container status-green">
    <div class="name"><span>Claude API</span></div>
    <div class="component-status">Operational</div>
  </div>
</div>`;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(html),
      }),
    );

    const status = await fetchClaudeStatus();

    expect(status).not.toBeNull();
    expect(status!.components.length).toBe(1);
    // Should be clean text, not "<span>Claude API</span>"
    expect(status!.components[0].name).toBe('Claude API');
    expect(status!.components[0].name).not.toContain('<');
  });
});

// ============================================================
// S1 — Negative cache / backoff (Issue #120)
// ============================================================

describe('S1 — Negative cache / backoff', () => {
  beforeEach(() => {
    invalidateStatusCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('negative_cache_skips_fetch_within_backoff', async () => {
    vi.useFakeTimers();

    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(SAMPLE_HTML_ALL_OPERATIONAL),
      });
    vi.stubGlobal('fetch', mockFetch);

    // First call fails
    const first = await fetchClaudeStatus();
    expect(first).toBeNull();

    // Second call within 30s backoff — should NOT hit fetch again
    vi.advanceTimersByTime(10 * 1000); // 10 seconds
    const second = await fetchClaudeStatus();
    expect(second).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1); // No second fetch
  });

  it('negative_cache_allows_retry_after_backoff', async () => {
    vi.useFakeTimers();

    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(SAMPLE_HTML_ALL_OPERATIONAL),
      });
    vi.stubGlobal('fetch', mockFetch);

    // First call fails
    await fetchClaudeStatus();

    // Advance past 30s backoff
    vi.advanceTimersByTime(31 * 1000);
    const retry = await fetchClaudeStatus();
    expect(retry).not.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ============================================================
// S2 — Incident status scoping (Issue #120)
// ============================================================

describe('S2 — Incident status scoping', () => {
  beforeEach(() => {
    invalidateStatusCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('incident_status_scoped_to_correct_incident', async () => {
    // Two incidents: first has its own updates, second has different updates
    const html = `
<div class="component-container status-red">
  <div class="component-inner-container status-red">
    <div class="name">Claude API</div>
    <div class="component-status">Partial Outage</div>
  </div>
</div>
<div class="incident-container impact-major">
  <div class="incident-title impact-major">
    <a>First Incident</a>
  </div>
  <div class="updates">
    <div>Investigating</div>
  </div>
</div>
<div class="incident-container impact-minor">
  <div class="incident-title impact-minor">
    <a>Second Incident</a>
  </div>
  <div class="updates">
    <div>Resolved</div>
  </div>
</div>`;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(html),
      }),
    );

    const status = await fetchClaudeStatus();
    expect(status).not.toBeNull();
    expect(status!.incidents.length).toBe(2);
    expect(status!.incidents[0].title).toBe('First Incident');
    expect(status!.incidents[0].status).toBe('Investigating');
    expect(status!.incidents[1].title).toBe('Second Incident');
    expect(status!.incidents[1].status).toBe('Resolved');
  });

  it('incident_without_updates_gets_unknown_status', async () => {
    const html = `
<div class="component-container status-yellow">
  <div class="component-inner-container status-yellow">
    <div class="name">Claude API</div>
    <div class="component-status">Degraded</div>
  </div>
</div>
<div class="incident-container impact-major">
  <div class="incident-title impact-major">
    <a>Incident With No Updates</a>
  </div>
</div>
<div class="incident-container impact-minor">
  <div class="incident-title impact-minor">
    <a>Second Incident</a>
  </div>
  <div class="updates">
    <div>Monitoring</div>
  </div>
</div>`;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(html),
      }),
    );

    const status = await fetchClaudeStatus();
    expect(status).not.toBeNull();
    expect(status!.incidents.length).toBe(2);
    // First incident has no updates div — should get 'Unknown', NOT 'Monitoring' from second
    expect(status!.incidents[0].status).toBe('Unknown');
    expect(status!.incidents[1].status).toBe('Monitoring');
  });
});

// ============================================================
// S3 — Guard condition (shouldShowStatusBlock) (Issue #120)
// ============================================================

describe('S3 — shouldShowStatusBlock guard', () => {
  it('returns_true_on_degraded', () => {
    const status: ClaudeStatusInfo = {
      overall: 'degraded',
      components: [{ name: 'API', status: 'degraded' }],
      incidents: [],
      fetchedAt: Date.now(),
    };
    expect(shouldShowStatusBlock(status)).toBe(true);
  });

  it('returns_true_on_operational_with_incidents', () => {
    const status: ClaudeStatusInfo = {
      overall: 'operational',
      components: [{ name: 'API', status: 'operational' }],
      incidents: [{ title: 'Issue', status: 'Investigating' }],
      fetchedAt: Date.now(),
    };
    expect(shouldShowStatusBlock(status)).toBe(true);
  });

  it('returns_false_on_fully_operational_no_incidents', () => {
    const status: ClaudeStatusInfo = {
      overall: 'operational',
      components: [{ name: 'API', status: 'operational' }],
      incidents: [],
      fetchedAt: Date.now(),
    };
    expect(shouldShowStatusBlock(status)).toBe(false);
  });

  it('returns_false_on_null', () => {
    expect(shouldShowStatusBlock(null)).toBe(false);
  });
});

// ============================================================
// S4 — non-OK HTTP response test (Issue #120)
// ============================================================

describe('S4 — non-OK HTTP response', () => {
  beforeEach(() => {
    invalidateStatusCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('fetchClaudeStatus_returnsNullOnNonOkResponse', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve('Service Unavailable'),
      }),
    );

    const status = await fetchClaudeStatus();
    expect(status).toBeNull();
  });
});

// ============================================================
// S5 — Incident status value test (Issue #120)
// ============================================================

describe('S5 — Incident status value extraction', () => {
  beforeEach(() => {
    invalidateStatusCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('incident_status_extracted_from_updates_div', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(SAMPLE_HTML_MIXED_STATUS),
      }),
    );

    const status = await fetchClaudeStatus();
    expect(status).not.toBeNull();
    expect(status!.incidents.length).toBeGreaterThan(0);
    // The SAMPLE_HTML_MIXED_STATUS has "Investigating" in the updates div
    expect(status!.incidents[0].status).toBe('Investigating');
  });
});
