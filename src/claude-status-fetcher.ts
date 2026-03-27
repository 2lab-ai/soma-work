/**
 * Claude Status Page Fetcher
 * Trace: docs/api-error-status/trace.md
 *
 * Fetches and parses https://status.claude.com to provide service status
 * context when API errors occur. Follows link-metadata-fetcher.ts pattern:
 * - Module-level Map cache with TTL
 * - Native fetch() with timeout
 * - Graceful degradation (returns null on any failure)
 */

import { Logger } from './logger';

const logger = new Logger('claude-status-fetcher');

// ============================================================
// Types
// ============================================================

export interface ClaudeStatusInfo {
  overall: 'operational' | 'degraded' | 'outage' | 'unknown';
  components: Array<{
    name: string;
    status: 'operational' | 'degraded' | 'outage' | 'unknown';
  }>;
  incidents: Array<{
    title: string;
    status: string;
  }>;
  fetchedAt: number;
}

type ComponentStatus = ClaudeStatusInfo['components'][number]['status'];

// ============================================================
// Cache
// ============================================================

const STATUS_URL = 'https://status.claude.com';
const CACHE_TTL = 2 * 60 * 1000; // 2 minutes
const FETCH_TIMEOUT = 3000; // 3 seconds

const statusCache = new Map<string, ClaudeStatusInfo>();

// In-flight promise to coalesce concurrent requests during outages
// Fix: Review feedback — prevent fetch stampede when multiple errors fire simultaneously
let inflight: Promise<ClaudeStatusInfo | null> | null = null;

export function invalidateStatusCache(): void {
  statusCache.clear();
  inflight = null;
}

// ============================================================
// Fetcher — Scenario 1, 2, 3
// ============================================================

async function doFetch(): Promise<ClaudeStatusInfo | null> {
  try {
    const response = await fetch(STATUS_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

    if (!response.ok) {
      logger.warn('Status page returned non-OK', { status: response.status });
      return null;
    }

    const html = await response.text();
    const info = parseStatusPage(html);

    if (!info) {
      return null;
    }

    // Scenario 3: Don't cache null
    statusCache.set('status', info);

    logger.debug('Claude status fetched', {
      overall: info.overall,
      componentCount: info.components.length,
      incidentCount: info.incidents.length,
    });

    return info;
  } catch (error) {
    logger.warn('Failed to fetch Claude status', { error: (error as Error).message });
    return null;
  }
}

export async function fetchClaudeStatus(): Promise<ClaudeStatusInfo | null> {
  // Scenario 2: Cache check
  const cached = statusCache.get('status');
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached;
  }

  // Coalesce concurrent requests — during an outage many errors fire at once
  if (inflight) return inflight;
  inflight = doFetch().finally(() => { inflight = null; });
  return inflight;
}

// ============================================================
// Parser — Scenario 1 Section 3b
// ============================================================

function parseStatusColor(colorClass: string): ComponentStatus {
  if (colorClass.includes('status-red')) return 'outage';
  if (colorClass.includes('status-yellow') || colorClass.includes('status-orange')) return 'degraded';
  if (colorClass.includes('status-green')) return 'operational';
  return 'unknown';
}

function parseStatusPage(html: string): ClaudeStatusInfo | null {
  try {
    // Extract components: match component-container blocks with status color and name
    // Fix: support extra CSS classes before status-* (e.g., "component-container border-color status-red")
    const componentRegex = /<div\s+class="component-container[^"]*?(status-\w+)"[^>]*>[\s\S]*?<div\s+class="name">([\s\S]*?)<\/div>[\s\S]*?<\/div>\s*<\/div>/g;

    const components: ClaudeStatusInfo['components'] = [];
    let match: RegExpExecArray | null;

    while ((match = componentRegex.exec(html)) !== null) {
      const statusColor = match[1];
      // Fix: strip HTML tags from name (e.g., <span>Claude API</span> → Claude API)
      const rawName = match[2].replace(/<[^>]*>/g, '').trim();
      if (rawName) {
        components.push({
          name: rawName,
          status: parseStatusColor(statusColor),
        });
      }
    }

    // Extract incidents: match incident-title blocks
    const incidentRegex = /<div\s+class="incident-title[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/div>/g;
    const incidents: ClaudeStatusInfo['incidents'] = [];

    while ((match = incidentRegex.exec(html)) !== null) {
      const title = match[1].trim();
      if (title) {
        // Try to find the status from the updates section following this incident
        const afterMatch = html.slice(match.index + match[0].length);
        const updatesMatch = afterMatch.match(/<div\s+class="updates"[^>]*>[\s\S]*?<div[^>]*>([\s\S]*?)<\/div>/);
        const status = updatesMatch ? updatesMatch[1].trim() : 'Unknown';

        incidents.push({ title, status });
      }
    }

    // If no components found at all, page structure may have changed
    if (components.length === 0) {
      logger.warn('No components parsed from status page');
      return null;
    }

    // Derive overall status
    // Fix: Bug 4 — unknown components should not default to 'operational'
    let overall: ClaudeStatusInfo['overall'] = 'operational';
    if (components.some(c => c.status === 'outage')) {
      overall = 'outage';
    } else if (components.some(c => c.status === 'degraded')) {
      overall = 'degraded';
    } else if (components.some(c => c.status === 'unknown')) {
      overall = 'unknown';
    }

    return {
      overall,
      components,
      incidents,
      fetchedAt: Date.now(),
    };
  } catch (error) {
    logger.warn('Failed to parse status page', { error: (error as Error).message });
    return null;
  }
}

// ============================================================
// Formatter — Scenario 4
// ============================================================

const STATUS_EMOJI: Record<ComponentStatus, string> = {
  operational: ':large_green_circle:',
  degraded: ':large_yellow_circle:',
  outage: ':red_circle:',
  unknown: ':white_circle:',
};

export function formatStatusForSlack(status: ClaudeStatusInfo | null): string {
  if (!status) return '';

  const lines: string[] = [];

  if (status.overall === 'operational' && status.incidents.length === 0) {
    // Scenario 4a: All operational — single line
    lines.push(':bar_chart: *Claude Service Status* — :large_green_circle: All Systems Operational');
  } else {
    // Scenario 4b: Mixed statuses — per-component listing
    lines.push(':bar_chart: *Claude Service Status* (status.claude.com)');

    for (const component of status.components) {
      const emoji = STATUS_EMOJI[component.status] || ':white_circle:';
      lines.push(`> ${emoji} *${component.name}* — ${capitalize(component.status)}`);
    }

    if (status.incidents.length > 0) {
      lines.push(`>`);
      lines.push(`> :warning: *Active Incidents:*`);
      for (const incident of status.incidents) {
        lines.push(`> • ${incident.title} (${incident.status})`);
      }
    }
  }

  return lines.join('\n');
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ============================================================
// Error Classification — Scenario 5 Section 3b
// ============================================================

const SLACK_ERROR_PATTERNS = [
  'invalid_attachments',
  'invalid_blocks',
  'rate_limited',
  'channel_not_found',
  'no_permission',
  'not_in_channel',
  'msg_too_long',
  'invalid_arguments',
  'missing_scope',
  'token_revoked',
  'no more than 50 items allowed',
  'an api error occurred:',  // Slack-specific format (trailing colon distinguishes from generic API errors)
];

const API_ERROR_KEYWORDS = [
  'internal server error',
  'service unavailable',
  'overloaded',
  'rate limit',
  'too many requests',
  'temporarily unavailable',
  'connection reset',
  'api_error',
  'api error',
];

export function isApiLikeError(error: { message?: string }): boolean {
  const message = (error.message || '').toLowerCase();

  // Exclude Slack API errors first — they contain patterns like "rate_limited"
  // that could false-positive on API keyword matching
  if (SLACK_ERROR_PATTERNS.some(p => message.includes(p))) {
    return false;
  }

  // Check for HTTP status codes (4xx/5xx) in error-related context
  // Fix: Review feedback — avoid false-positives on incidental numbers (port 443, "450ms", etc.)
  if (/(?:error|status|http|code)[:\s]*[45]\d{2}\b/i.test(message) ||
      /\b[45]\d{2}\s+(?:error|bad|not|service|internal|gateway|timeout|unavailable|forbidden|unauthorized)/i.test(message)) {
    return true;
  }

  // Check for API error keywords
  return API_ERROR_KEYWORDS.some(keyword => message.includes(keyword));
}
