/**
 * UI Surface Config — generic, config.json-driven composition of user-facing
 * surfaces (thread header, turn-end card, dashboard card header).
 *
 * Operators declare WHAT each surface shows (lines of fields) and HOW each
 * field renders (style / emoji / truncation / bar / decimals / format) in
 * `config.json` under the top-level `ui` key. Built-in defaults mirror the
 * pre-config hardcoded rendering exactly; `config.default.json` at the repo
 * root is a generated, test-locked copy of those defaults for inspection.
 *
 * Resolution order per surface+theme (codex consult D3):
 *   user `ui.<surface>.themes.<theme>.lines`
 *   → user `ui.<surface>.lines`               (applies to ALL themes)
 *   → built-in `themes.<theme>.lines` preset
 *   → built-in `lines`
 *
 * Slack constraints this schema is designed around (researched, see
 * docs/ui-surfaces.md): mrkdwn has NO text color (color applies only where
 * Slack supports it — attachment color bars); header plain_text ≤150 chars;
 * context blocks ≤10 elements; ≤50 blocks per message. Renderers enforce
 * the hard limits regardless of configuration.
 */

import { Logger } from '@soma/common/logger';

const logger = new Logger('SurfaceConfig');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SurfaceName = 'threadheader' | 'turnend' | 'dashboardheader';
export type SurfaceTheme = 'default' | 'compact' | 'minimal';

export interface SurfaceFieldStyle {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
}

export interface SurfaceBarStyle {
  /** Number of bar segments (default varies per field: 5/6/8). */
  width?: number;
  filledChar?: string;
  emptyChar?: string;
}

export interface SurfaceFieldConfig {
  /** Registry key — unknown fields are skipped with a one-time warning. */
  field: string;
  /** Hide the field without deleting the entry. Default true. */
  show?: boolean;
  /** Text label prefix, e.g. "Ctx" / "Dur". Empty string removes the default label. */
  label?: string;
  /** Explicit emoji prefix (shortcode or unicode). Never auto-invented. */
  prefixEmoji?: string;
  /** mrkdwn text style. Slack supports bold/italic/code/strike only. */
  style?: SurfaceFieldStyle;
  /** Max characters for the rendered text value (renderer hard caps still apply). */
  truncate?: number;
  /**
   * Color hint. Applied ONLY where Slack supports color (attachment color
   * bar). Ignored (warn-once) for inline mrkdwn — Slack has no text color.
   */
  color?: string;
  /** Field-specific variant, e.g. owner: 'mention'|'name'|'both'. */
  format?: string;
  /** Max entries for list-ish fields (links per type, tools shown, tasks). */
  max?: number;
  /** Gauge-bar styling for bar-rendering fields (contextwindow, fivehour, sevenday). */
  bar?: SurfaceBarStyle;
  /** Decimal places for percentage values. */
  decimals?: number;
}

export interface SurfaceLineConfig {
  /** Slack block type for the line. Default: 'context'. */
  block?: 'header' | 'section' | 'context' | 'divider';
  /** Joiner between rendered field values within one text line. */
  separator?: string;
  fields: SurfaceFieldConfig[];
}

export interface SurfaceUiConfig {
  /** Base line composition — applies to every theme unless overridden. */
  lines?: SurfaceLineConfig[];
  /** Per-theme overrides. */
  themes?: Partial<Record<SurfaceTheme, { lines: SurfaceLineConfig[] }>>;
}

export interface UiSurfacesConfig {
  threadheader?: SurfaceUiConfig;
  turnend?: SurfaceUiConfig;
  dashboardheader?: SurfaceUiConfig;
}

export interface NormalizeResult {
  config: UiSurfacesConfig;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Field registries — the contract of what each surface can render.
// Unknown config fields warn+skip (never invented); renderers own the
// field → value mapping.
// ---------------------------------------------------------------------------

export const SURFACE_FIELD_REGISTRY: Record<SurfaceName, readonly string[]> = {
  threadheader: ['title', 'owner', 'workflow', 'model', 'contextwindow', 'links', 'linkhistory', 'status', 'separator'],
  turnend: [
    'status',
    'title',
    'threadlink',
    'errorbody',
    'persona',
    'model',
    'effort',
    'startedat',
    'contextwindow',
    'duration',
    'fivehour',
    'sevenday',
    'toolstats',
    'separator',
  ],
  dashboardheader: [
    'title',
    'owner',
    'workflow',
    'model',
    'links',
    'mergestats',
    'tokens',
    'cost',
    'contextwindow',
    'tasks',
    'status',
    'separator',
  ],
} as const;

/** Compatibility aliases (codex consult D2b): `name` ≡ owner rendered as display name. */
const FIELD_ALIASES: Record<string, { field: string; format?: string }> = {
  name: { field: 'owner', format: 'name' },
};

const SURFACE_NAMES: readonly SurfaceName[] = ['threadheader', 'turnend', 'dashboardheader'];
const THEME_NAMES: readonly SurfaceTheme[] = ['default', 'compact', 'minimal'];
const BLOCK_TYPES = new Set(['header', 'section', 'context', 'divider']);

// Numeric option bounds — unbounded values crash renderers (`toFixed(101)`
// throws RangeError, giant `''.repeat` throws, `truncate` past Slack's
// 3000-char `section.text` hard limit gets the message rejected). Clamped
// at normalize time so renderers can trust the normalized config.
/** `truncate` upper bound: Slack `section.text` hard limit. */
const MAX_TRUNCATE = 3000;
/** `max` (list entry cap) upper bound. */
const MAX_LIST_MAX = 100;
/** `bar.width` upper bound: keeps gauge bars inside context-line budgets. */
export const MAX_BAR_WIDTH = 40;
/** `decimals` upper bound: sane display precision, far under toFixed's 100. */
const MAX_DECIMALS = 10;

// String option bounds — hostile-but-valid config strings are otherwise
// unbounded and flow into Slack text objects, blowing the 3000-char limit
// so the API rejects the message AFTER postMessage. Truncated (sliced),
// never rejected, so a long-but-honest value still renders.
/** `label` upper bound. */
const MAX_LABEL_CHARS = 200;
/** `prefixEmoji` upper bound (longest realistic shortcode is far shorter). */
const MAX_PREFIX_EMOJI_CHARS = 100;
/** `format` upper bound (registry formats are short keywords). */
const MAX_FORMAT_CHARS = 50;
/** `color` upper bound (hex / named colors are short). */
const MAX_COLOR_CHARS = 50;
/** `bar.filledChar` / `bar.emptyChar` upper bound (one glyph, maybe multi-codepoint). */
const MAX_BAR_CHAR_CHARS = 8;
/** `line.separator` upper bound. */
const MAX_SEPARATOR_CHARS = 50;

/**
 * Slack hard limit for `section.text` / context mrkdwn element text objects.
 * Renderers must hard-cap every emitted text object at this length —
 * normalization bounds each option, but many bounded values joined on one
 * line can still exceed it.
 */
export const MAX_TEXT_OBJECT_CHARS = 3000;

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

// ---------------------------------------------------------------------------
// Built-in defaults — exact mirror of the pre-config hardcoded rendering.
// config.default.json is generated from this constant (parity test-locked).
// ---------------------------------------------------------------------------

export const DEFAULT_UI_SURFACES: UiSurfacesConfig = {
  threadheader: {
    lines: [
      { block: 'header', fields: [{ field: 'title', show: true, truncate: 150 }] },
      {
        block: 'context',
        fields: [
          { field: 'owner', show: true, format: 'mention' },
          { field: 'workflow', show: true, style: { code: true } },
          { field: 'model', show: true, style: { code: true } },
          { field: 'contextwindow', show: true, bar: { width: 5, filledChar: '▓', emptyChar: '░' } },
        ],
      },
      { block: 'context', fields: [{ field: 'linkhistory', show: true, max: 5 }] },
      { block: 'context', fields: [{ field: 'status', show: true, format: 'closed-marker' }] },
    ],
    themes: {
      compact: {
        lines: [
          { block: 'section', fields: [{ field: 'title', show: true, format: 'headline' }] },
          {
            block: 'context',
            fields: [
              { field: 'workflow', show: true, style: { code: true } },
              { field: 'model', show: true, style: { code: true } },
              { field: 'contextwindow', show: true, bar: { width: 5, filledChar: '▓', emptyChar: '░' } },
              { field: 'links', show: true },
              { field: 'status', show: true, format: 'closed-text' },
            ],
          },
        ],
      },
      minimal: {
        lines: [
          {
            block: 'context',
            fields: [
              { field: 'title', show: true },
              { field: 'model', show: true, style: { code: true } },
              { field: 'contextwindow', show: true, bar: { width: 5, filledChar: '▓', emptyChar: '░' } },
              { field: 'links', show: true },
              { field: 'status', show: true, format: 'closed-text' },
            ],
          },
        ],
      },
    },
  },
  turnend: {
    lines: [
      {
        block: 'section',
        fields: [
          { field: 'status', show: true },
          { field: 'title', show: true },
          { field: 'threadlink', show: true },
        ],
      },
      { block: 'section', fields: [{ field: 'errorbody', show: true, truncate: 2900 }] },
      {
        block: 'context',
        separator: ' | ',
        fields: [
          { field: 'persona', show: true, style: { code: true } },
          { field: 'model', show: true, style: { code: true }, format: 'with-effort' },
          { field: 'startedat', show: true },
        ],
      },
      {
        block: 'context',
        separator: ' | ',
        fields: [
          {
            field: 'contextwindow',
            show: true,
            label: 'Ctx',
            bar: { width: 5, filledChar: '▓', emptyChar: '░' },
            decimals: 1,
          },
          { field: 'duration', show: true, label: 'Dur' },
          {
            field: 'fivehour',
            show: true,
            label: '5h',
            bar: { width: 6, filledChar: '▓', emptyChar: '░' },
            decimals: 0,
          },
          {
            field: 'sevenday',
            show: true,
            label: '7d',
            bar: { width: 8, filledChar: '▓', emptyChar: '░' },
            decimals: 0,
          },
        ],
      },
      { block: 'context', fields: [{ field: 'toolstats', show: true, max: 5, prefixEmoji: ':wrench:' }] },
    ],
    themes: {
      compact: {
        lines: [
          {
            block: 'section',
            fields: [
              { field: 'status', show: true },
              { field: 'title', show: true },
              { field: 'threadlink', show: true },
            ],
          },
          { block: 'section', fields: [{ field: 'errorbody', show: true, truncate: 2900 }] },
          {
            block: 'context',
            separator: ' · ',
            fields: [
              { field: 'model', show: true, style: { code: true }, format: 'with-effort' },
              { field: 'contextwindow', show: true, label: 'Ctx', format: 'percent', decimals: 1 },
              { field: 'duration', show: true },
              { field: 'toolstats', show: true, format: 'summary' },
            ],
          },
        ],
      },
      minimal: {
        lines: [
          {
            block: 'context',
            separator: ' · ',
            fields: [
              { field: 'status', show: true, format: 'plain' },
              { field: 'model', show: true, format: 'with-effort' },
              { field: 'contextwindow', show: true, format: 'percent', decimals: 1 },
              { field: 'duration', show: true },
            ],
          },
          { block: 'section', fields: [{ field: 'errorbody', show: true, truncate: 2900 }] },
        ],
      },
    },
  },
  dashboardheader: {
    lines: [
      {
        fields: [
          { field: 'title', show: true },
          { field: 'links', show: true },
        ],
      },
      {
        // Card meta row — mirrors the fragments renderCard actually emits
        // today (workflow · model · owner name · last-activity status), so
        // the default config equals the current card appearance and every
        // registered field is gateable.
        fields: [
          { field: 'workflow', show: true },
          { field: 'model', show: true },
          { field: 'owner', show: true },
          { field: 'status', show: true },
        ],
      },
      { fields: [{ field: 'mergestats', show: true }] },
      {
        fields: [
          { field: 'tokens', show: true },
          { field: 'cost', show: true },
        ],
      },
      { fields: [{ field: 'contextwindow', show: true }] },
      { fields: [{ field: 'tasks', show: true, max: 5 }] },
    ],
  },
};

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function normalizeField(raw: unknown, surface: SurfaceName, warnings: string[]): SurfaceFieldConfig | undefined {
  if (!isPlainObject(raw) || typeof raw.field !== 'string') {
    warnings.push(`ui.${surface}: field entry is not an object with a "field" key — skipped`);
    return undefined;
  }

  let fieldName = raw.field.toLowerCase();
  let aliasFormat: string | undefined;
  const alias = FIELD_ALIASES[fieldName];
  if (alias) {
    fieldName = alias.field;
    aliasFormat = alias.format;
  }

  if (!SURFACE_FIELD_REGISTRY[surface].includes(fieldName)) {
    warnings.push(
      `ui.${surface}: unknown field "${raw.field}" — skipped (known: ${SURFACE_FIELD_REGISTRY[surface].join(', ')})`,
    );
    return undefined;
  }

  const out: SurfaceFieldConfig = { field: fieldName };
  out.show = raw.show !== false;
  if (typeof raw.label === 'string') out.label = raw.label.slice(0, MAX_LABEL_CHARS);
  if (typeof raw.prefixEmoji === 'string') out.prefixEmoji = raw.prefixEmoji.slice(0, MAX_PREFIX_EMOJI_CHARS);
  if (isPlainObject(raw.style)) {
    const s: SurfaceFieldStyle = {};
    if (typeof raw.style.bold === 'boolean') s.bold = raw.style.bold;
    if (typeof raw.style.italic === 'boolean') s.italic = raw.style.italic;
    if (typeof raw.style.code === 'boolean') s.code = raw.style.code;
    if (typeof raw.style.strike === 'boolean') s.strike = raw.style.strike;
    if (Object.keys(s).length > 0) out.style = s;
  }
  if (typeof raw.truncate === 'number' && raw.truncate > 0) out.truncate = clampInt(raw.truncate, 1, MAX_TRUNCATE);
  if (typeof raw.color === 'string') out.color = raw.color.slice(0, MAX_COLOR_CHARS);
  const format = typeof raw.format === 'string' ? raw.format : aliasFormat;
  if (format) out.format = format.slice(0, MAX_FORMAT_CHARS);
  if (typeof raw.max === 'number' && raw.max >= 0) out.max = clampInt(raw.max, 0, MAX_LIST_MAX);
  if (isPlainObject(raw.bar)) {
    const b: SurfaceBarStyle = {};
    if (typeof raw.bar.width === 'number' && raw.bar.width > 0) b.width = clampInt(raw.bar.width, 1, MAX_BAR_WIDTH);
    if (typeof raw.bar.filledChar === 'string' && raw.bar.filledChar.length > 0) {
      b.filledChar = raw.bar.filledChar.slice(0, MAX_BAR_CHAR_CHARS);
    }
    if (typeof raw.bar.emptyChar === 'string' && raw.bar.emptyChar.length > 0) {
      b.emptyChar = raw.bar.emptyChar.slice(0, MAX_BAR_CHAR_CHARS);
    }
    if (Object.keys(b).length > 0) out.bar = b;
  }
  if (typeof raw.decimals === 'number' && raw.decimals >= 0) out.decimals = clampInt(raw.decimals, 0, MAX_DECIMALS);
  return out;
}

function normalizeLines(raw: unknown, surface: SurfaceName, warnings: string[]): SurfaceLineConfig[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    warnings.push(`ui.${surface}.lines is not an array — ignored, using defaults`);
    return undefined;
  }

  const lines: SurfaceLineConfig[] = [];
  for (const rawLine of raw) {
    // Tolerate both { fields: [...] } objects and bare arrays of fields
    // (the user-facing example writes lines as arrays of field objects).
    let lineObj: Record<string, unknown>;
    if (Array.isArray(rawLine)) {
      lineObj = { fields: rawLine };
    } else if (isPlainObject(rawLine)) {
      lineObj = rawLine;
    } else {
      warnings.push(`ui.${surface}: line entry is neither an array nor an object — skipped`);
      continue;
    }

    const rawFields = Array.isArray(lineObj.fields) ? lineObj.fields : [];
    const fields = rawFields
      .map((f) => normalizeField(f, surface, warnings))
      .filter((f): f is SurfaceFieldConfig => f !== undefined);
    if (fields.length === 0) continue;

    const line: SurfaceLineConfig = { fields };
    if (typeof lineObj.block === 'string' && BLOCK_TYPES.has(lineObj.block)) {
      line.block = lineObj.block as SurfaceLineConfig['block'];
    }
    if (typeof lineObj.separator === 'string') line.separator = lineObj.separator.slice(0, MAX_SEPARATOR_CHARS);
    lines.push(line);
  }
  return lines;
}

function normalizeSurface(raw: unknown, surface: SurfaceName, warnings: string[]): SurfaceUiConfig | undefined {
  if (!isPlainObject(raw)) {
    if (raw !== undefined) warnings.push(`ui.${surface} is not an object — ignored`);
    return undefined;
  }
  const out: SurfaceUiConfig = {};
  const lines = normalizeLines(raw.lines, surface, warnings);
  if (lines && lines.length > 0) out.lines = lines;

  if (isPlainObject(raw.themes)) {
    const themes: SurfaceUiConfig['themes'] = {};
    for (const [themeName, themeRaw] of Object.entries(raw.themes)) {
      if (!THEME_NAMES.includes(themeName as SurfaceTheme)) {
        warnings.push(`ui.${surface}.themes.${themeName}: unknown theme — ignored`);
        continue;
      }
      if (!isPlainObject(themeRaw)) continue;
      const themeLines = normalizeLines(themeRaw.lines, surface, warnings);
      if (themeLines && themeLines.length > 0) {
        themes[themeName as SurfaceTheme] = { lines: themeLines };
      }
    }
    if (Object.keys(themes).length > 0) out.themes = themes;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate + normalize a raw `ui` config value (from config.json).
 * Never throws — structurally broken input degrades to "no override" so a
 * bad config cannot take the surfaces (or the boot) down.
 */
export function normalizeUiSurfacesConfig(raw: unknown): NormalizeResult {
  const warnings: string[] = [];
  const config: UiSurfacesConfig = {};

  if (raw === undefined || raw === null) return { config, warnings };
  if (!isPlainObject(raw)) {
    warnings.push('ui config is not an object — ignored');
    return { config, warnings };
  }

  for (const key of Object.keys(raw)) {
    if (!SURFACE_NAMES.includes(key as SurfaceName)) {
      warnings.push(`ui.${key}: unknown surface — ignored (known: ${SURFACE_NAMES.join(', ')})`);
      continue;
    }
    const surface = key as SurfaceName;
    const normalized = normalizeSurface(raw[key], surface, warnings);
    if (normalized) config[surface] = normalized;
  }

  return { config, warnings };
}

// ---------------------------------------------------------------------------
// Module store — set once at boot (src/index.ts) from config.json `ui`.
// packages/slack cannot import the src config loader (workspace boundary),
// so the host injects the raw value here.
// ---------------------------------------------------------------------------

let activeConfig: UiSurfacesConfig = {};

/** Normalize + install the operator config. Returns warnings for logging. */
export function setUiSurfacesConfig(raw: unknown): NormalizeResult {
  const result = normalizeUiSurfacesConfig(raw);
  activeConfig = result.config;
  for (const w of result.warnings) logger.warn(w);
  return result;
}

/** Test-only / reload: restore built-in defaults. */
export function resetUiSurfacesConfig(): void {
  activeConfig = {};
}

/** The currently active (normalized) operator overrides. */
export function getUiSurfacesConfig(): UiSurfacesConfig {
  return activeConfig;
}

/**
 * Resolve the line composition for a surface + theme.
 * See module JSDoc for the precedence chain.
 */
export function getSurfaceLines(surface: SurfaceName, theme: SurfaceTheme = 'default'): SurfaceLineConfig[] {
  const user = activeConfig[surface];
  const userThemeLines = user?.themes?.[theme]?.lines;
  if (userThemeLines && userThemeLines.length > 0) return userThemeLines;
  if (user?.lines && user.lines.length > 0) return user.lines;

  const builtin = DEFAULT_UI_SURFACES[surface];
  const builtinThemeLines = theme !== 'default' ? builtin?.themes?.[theme]?.lines : undefined;
  if (builtinThemeLines && builtinThemeLines.length > 0) return builtinThemeLines;
  return builtin?.lines ?? [];
}

/**
 * Convenience for renderers: is a field visible in the resolved lines?
 * (Used by the dashboard card renderer where composition is coarser.)
 */
export function isFieldVisible(surface: SurfaceName, field: string, theme: SurfaceTheme = 'default'): boolean {
  const lines = getSurfaceLines(surface, theme);
  for (const line of lines) {
    for (const f of line.fields) {
      if (f.field === field) return f.show !== false;
    }
  }
  return false;
}

/** Find the first config entry for a field in the resolved lines (renderer options lookup). */
export function getFieldConfig(
  surface: SurfaceName,
  field: string,
  theme: SurfaceTheme = 'default',
): SurfaceFieldConfig | undefined {
  const lines = getSurfaceLines(surface, theme);
  for (const line of lines) {
    for (const f of line.fields) {
      if (f.field === field) return f;
    }
  }
  return undefined;
}
