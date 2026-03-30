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

/** Sentinel path value indicating the plugin lives in an external git repo. */
export const EXTERNAL_PLUGIN_PATH = '__external__' as const;

export interface MarketplacePluginEntry {
  /** Relative path inside the repo where the plugin lives */
  path: string;
  /** Human-readable description */
  description?: string;
  /** External git URL when plugin lives in a separate repo (path will be "__external__") */
  externalUrl?: string;
  /** Subdirectory within external repo (for git-subdir sources) */
  externalSubdir?: string;
  /** Git ref for external repo */
  externalRef?: string;
  /** Pinned commit SHA for external repo (takes precedence over externalRef for downloads) */
  externalSha?: string;
}

/** Schema of `marketplace.json` at the root of a marketplace repo (soma-work internal format). */
export interface MarketplaceManifest {
  name: string;
  version?: string;
  plugins: Record<string, MarketplacePluginEntry>;
}

// ---------------------------------------------------------------------------
// Official marketplace format (.claude-plugin/marketplace.json)
// Used by anthropics/claude-plugins-official, 2lab-ai/oh-my-claude, etc.
// ---------------------------------------------------------------------------

/** Source pointing to an external git URL. */
export interface OfficialSourceUrl {
  source: 'url';
  url: string;
  sha?: string;
}

/** Source pointing to a subdirectory in another git repo. */
export interface OfficialSourceGitSubdir {
  source: 'git-subdir';
  url: string;
  path: string;
  ref?: string;
  sha?: string;
}

/** Source can be a string (local path) or an object (url / git-subdir). */
export type OfficialPluginSource = string | OfficialSourceUrl | OfficialSourceGitSubdir;

/** A single plugin entry in the official marketplace format. */
export interface OfficialPluginEntry {
  name: string;
  description?: string;
  category?: string;
  source: OfficialPluginSource;
  homepage?: string;
  author?: { name: string; email?: string };
}

/** Schema of `.claude-plugin/marketplace.json` (official format). */
export interface OfficialMarketplaceManifest {
  name: string;
  description?: string;
  owner?: { name: string; email?: string };
  metadata?: { description?: string; version?: string };
  plugins: OfficialPluginEntry[];
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
  source: 'marketplace' | 'local-override' | 'default';
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
