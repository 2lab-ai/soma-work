import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from './logger';

const logger = new Logger('ClaudeUsage');

const API_TIMEOUT_MS = 1500;
const DEFAULT_CACHE_TTL_MS = 30_000;

interface ClaudeUsageWindowRaw {
  utilization?: unknown;
}

interface ClaudeUsageResponse {
  five_hour?: ClaudeUsageWindowRaw | null;
  seven_day?: ClaudeUsageWindowRaw | null;
}

interface UsageCacheEntry {
  data: ClaudeUsageSnapshot;
  timestamp: number;
}

export interface ClaudeUsageSnapshot {
  fiveHour?: number;
  sevenDay?: number;
}

const usageCache = new Map<string, UsageCacheEntry>();
const pendingRequests = new Map<string, Promise<ClaudeUsageSnapshot | null>>();

function readTokenFromKeychain(): string | null {
  if (process.platform !== 'darwin') {
    return null;
  }

  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: {
        accessToken?: string;
      };
    };
    return parsed.claudeAiOauth?.accessToken || null;
  } catch {
    return null;
  }
}

function readTokenFromCredentialsFile(): string | null {
  try {
    const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
    if (!fs.existsSync(credentialsPath)) {
      return null;
    }

    const raw = fs.readFileSync(credentialsPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: {
        accessToken?: string;
      };
    };
    return parsed.claudeAiOauth?.accessToken || null;
  } catch {
    return null;
  }
}

function getClaudeOauthToken(): string | null {
  return readTokenFromKeychain() || readTokenFromCredentialsFile();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeUtilizationPercent(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return undefined;
  }

  const percent = raw <= 1.5 ? raw * 100 : raw;
  const clamped = Math.max(0, Math.min(100, percent));
  return Math.round(clamped * 10) / 10;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

export async function fetchClaudeUsageSnapshot(
  cacheTtlMs: number = DEFAULT_CACHE_TTL_MS
): Promise<ClaudeUsageSnapshot | null> {
  const token = getClaudeOauthToken();
  if (!token) {
    return null;
  }

  const key = tokenHash(token);
  const cached = usageCache.get(key);
  if (cached && cacheTtlMs > 0 && Date.now() - cached.timestamp < cacheTtlMs) {
    return cached.data;
  }

  const pending = pendingRequests.get(key);
  if (pending) {
    return pending;
  }

  const request = (async (): Promise<ClaudeUsageSnapshot | null> => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

      const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);
      if (!response.ok) {
        return null;
      }

      const payload = asRecord(await response.json());
      if (!payload) {
        return null;
      }

      const usage = payload as ClaudeUsageResponse;
      const fiveHour = normalizeUtilizationPercent(usage.five_hour?.utilization);
      const sevenDay = normalizeUtilizationPercent(usage.seven_day?.utilization);

      if (fiveHour === undefined && sevenDay === undefined) {
        return null;
      }

      const snapshot: ClaudeUsageSnapshot = {};
      if (fiveHour !== undefined) {
        snapshot.fiveHour = fiveHour;
      }
      if (sevenDay !== undefined) {
        snapshot.sevenDay = sevenDay;
      }

      usageCache.set(key, { data: snapshot, timestamp: Date.now() });
      return snapshot;
    } catch (error) {
      logger.debug('Failed to fetch Claude usage snapshot', {
        error: (error as Error).message,
      });
      return null;
    }
  })();

  pendingRequests.set(key, request);
  try {
    return await request;
  } finally {
    pendingRequests.delete(key);
  }
}
