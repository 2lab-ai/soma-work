/**
 * Plugin Marketplace type definitions.
 *
 * Covers: config.json plugin section, marketplace.json schema,
 * resolved plugin references, and SDK-ready plugin paths.
 */

// ---------------------------------------------------------------------------
// config.json → plugin section
// ---------------------------------------------------------------------------

/** A single marketplace source (GitHub repo). */
export interface MarketplaceEntry {
  /** Identifier used in plugin refs, e.g. "soma-work" */
  name: string;
  /** GitHub owner/repo, e.g. "2lab-ai/soma-work" */
  repo: string;
  /** Git ref — branch, tag, or SHA (default: "main") */
  ref?: string;
}

/** The `plugin` key inside config.json. */
export interface PluginConfig {
  /** Marketplace source repositories */
  marketplace?: MarketplaceEntry[];
  /** Plugin references: "pluginName@marketplaceName" */
  plugins?: string[];
  /** Local directories loaded directly (dev mode) */
  localOverrides?: string[];
}

// ---------------------------------------------------------------------------
// marketplace.json (lives in each marketplace repo root)
// ---------------------------------------------------------------------------

export interface MarketplacePluginEntry {
  /** Relative path inside the repo where the plugin lives */
  path: string;
  /** Human-readable description */
  description?: string;
}

/** Schema of `marketplace.json` at the root of a marketplace repo. */
export interface MarketplaceManifest {
  name: string;
  version: string;
  plugins: Record<string, MarketplacePluginEntry>;
}

// ---------------------------------------------------------------------------
// Parsed plugin reference
// ---------------------------------------------------------------------------

/** Result of parsing "pluginName@marketplaceName". */
export interface PluginRef {
  pluginName: string;
  marketplaceName: string;
}

// ---------------------------------------------------------------------------
// Resolved plugin (ready for SDK)
// ---------------------------------------------------------------------------

export interface ResolvedPlugin {
  /** Display name, e.g. "omc@soma-work" */
  name: string;
  /** Absolute local path to the plugin directory */
  localPath: string;
  /** How the plugin was resolved */
  source: 'marketplace' | 'local-override';
}

// ---------------------------------------------------------------------------
// Cache metadata
// ---------------------------------------------------------------------------

export interface CacheMeta {
  /** Commit SHA the cached content corresponds to */
  sha: string;
  /** HTTP ETag for conditional requests */
  etag?: string;
  /** ISO timestamp of last fetch */
  fetchedAt: string;
  /** Marketplace name */
  marketplace: string;
  /** Git ref that was requested */
  ref: string;
}

// ---------------------------------------------------------------------------
// SDK plugin format
// ---------------------------------------------------------------------------

export interface SdkPluginPath {
  type: 'local';
  path: string;
}
