/**
 * Parses and validates the `plugin` section of config.json.
 */

import { Logger } from '../logger';
import type { MarketplaceEntry, PluginConfig, PluginRef } from './types';

const logger = new Logger('PluginConfigParser');

/** Only alphanumeric, hyphens, and underscores are allowed in names (no path traversal). */
const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Check if a name is safe for use as a filesystem path component.
 */
export function isSafeName(name: string): boolean {
  return SAFE_NAME_RE.test(name);
}

/**
 * Parse a plugin reference string "pluginName@marketplaceName".
 * Returns null and logs a warning on invalid format.
 */
export function parsePluginRef(raw: string): PluginRef | null {
  const at = raw.indexOf('@');
  if (at <= 0 || at === raw.length - 1) {
    logger.warn('Invalid plugin reference (expected "name@marketplace")', { raw });
    return null;
  }
  const pluginName = raw.slice(0, at);
  const marketplaceName = raw.slice(at + 1);
  if (!isSafeName(pluginName)) {
    logger.warn('Unsafe plugin name (only alphanumeric, hyphens, underscores allowed)', { pluginName });
    return null;
  }
  if (!isSafeName(marketplaceName)) {
    logger.warn('Unsafe marketplace name', { marketplaceName });
    return null;
  }
  return { pluginName, marketplaceName };
}

/**
 * Validate a MarketplaceEntry. Returns true if valid.
 */
export function validateMarketplaceEntry(entry: unknown): entry is MarketplaceEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  if (typeof e.name !== 'string' || !e.name) return false;
  if (typeof e.repo !== 'string' || !e.repo) return false;
  if (e.ref !== undefined && typeof e.ref !== 'string') return false;
  // Validate name is safe for filesystem use
  if (!isSafeName(e.name)) {
    logger.warn('Unsafe marketplace name', { name: e.name });
    return false;
  }
  // Validate repo format: "owner/repo"
  if (!e.repo.includes('/')) {
    logger.warn('Marketplace repo should be "owner/repo" format', { repo: e.repo });
    return false;
  }
  return true;
}

/**
 * Validate and normalise a raw PluginConfig object.
 * Returns a cleaned PluginConfig with invalid entries removed.
 */
export function validatePluginConfig(raw: unknown): PluginConfig {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const obj = raw as Record<string, unknown>;
  const result: PluginConfig = {};

  // marketplace
  if (Array.isArray(obj.marketplace)) {
    const valid: MarketplaceEntry[] = [];
    for (const entry of obj.marketplace) {
      if (validateMarketplaceEntry(entry)) {
        valid.push(entry as MarketplaceEntry);
      } else {
        logger.warn('Skipping invalid marketplace entry', { entry });
      }
    }
    result.marketplace = valid;
  }

  // plugins
  if (Array.isArray(obj.plugins)) {
    const valid: string[] = [];
    for (const p of obj.plugins) {
      if (typeof p === 'string' && parsePluginRef(p)) {
        valid.push(p);
      }
    }
    result.plugins = valid;
  }

  // localOverrides
  if (Array.isArray(obj.localOverrides)) {
    result.localOverrides = obj.localOverrides.filter((p): p is string => typeof p === 'string' && p.length > 0);
  }

  return result;
}
