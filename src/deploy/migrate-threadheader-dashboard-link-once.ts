/**
 * 2026-10-16 one-time ADDITIVE config.json rewrite: put the thread header's
 * `dashboardLink` field (`📋 작업 로그`, the session's dashboard deep link) into
 * an operator's `ui.threadheader` that predates it.
 *
 * Why a migration: config-loader seeds DEFAULT_UI_SURFACES into config.json
 * once (when `ui` is absent), and an operator `ui.threadheader` overrides the
 * built-in presets. Every host that booted before the field existed holds its
 * own copy — seeded, then often edited (the fable dev header moved `status`
 * into the identity line and dropped the link-history line) — so a new built-in
 * default never reaches it. Matching against known seeds would miss the edited
 * copies, which is exactly where the user asked for the link; so the rule is
 * additive, per lines array:
 *
 *   - an array that mentions `dashboardLink` anywhere (`show: false` included)
 *     is the operator's decision and is never touched;
 *   - otherwise the field goes right before the first `links`/`linkhistory`
 *     field of the first line holding one (the defaults' placement: base before
 *     `linkhistory`, compact/minimal before `links`);
 *   - otherwise a `{ block: 'context', fields: [dashboardLink] }` line goes
 *     right after the first `header`/`section` line, or first if there is none.
 *
 * Scope: `ui.threadheader.lines` and every `ui.threadheader.themes.<name>.lines`.
 * An array with no field the thread header knows (empty, or only unknown /
 * typo'd names) is skipped: surface-config drops it and falls back (theme →
 * base lines → built-in default), and adding a lone line would replace that
 * whole fallback with just the link. No `ui` key: nothing to do, the loader
 * seeds the current default.
 *
 * Runs once per DATA_DIR: the marker is written after a successful rewrite (or
 * when every array already mentions the field), never parsed. Afterwards there
 * is no rule at all, so an operator who removes the link keeps it removed. The
 * rewrite is idempotent — a changed array mentions the field — so a marker lost
 * after the config write cannot add the field twice.
 *
 * The raw file is parsed, never the env-substituted config, so `${VAR}`
 * placeholders survive verbatim (the hazard config-loader's ui seeding
 * describes); other keys keep their values and order, re-serialized by
 * config-loader's own writer (atomic tmp+rename, 2-space indent, 0600).
 *
 * Other config.json writers (CLI `somawork setup`, plugin-manager `saveConfig`)
 * take no lock — there is none to share — and the DATA_DIR PID lock only
 * excludes a second daemon boot. So the write is compare-and-swap: the bytes
 * the rule was applied to are re-read right before the atomic write; if another
 * writer changed the file in between, its bytes are re-parsed and the rule is
 * re-applied (up to MAX_ATTEMPTS). Still contended after that: nothing is
 * written, no marker, retried next boot. What remains is the window between
 * that re-read and the rename itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '@soma/common/atomic-write';

import { writeConfigFileAtomically } from '../config-loader';
import { resolveSurfaceField } from '../slack/surface-config';

/** Presence of this file in DATA_DIR = migration done (never parsed). */
export const THREADHEADER_DASHBOARD_LINK_ONCE_MARKER = '.threadheader-dashboard-link-once-2026-10-16.json';

/** Compare-and-swap rounds before giving up on a config.json another writer keeps changing. */
const MAX_ATTEMPTS = 3;

export type ThreadHeaderDashboardLinkOutcome =
  | 'migrated'
  | 'already-present'
  | 'no-ui'
  | 'marker-present'
  /** Another writer changed config.json on every attempt; nothing written, retried next boot. */
  | 'contended';

export interface MigrateThreadHeaderDashboardLinkOnceParams {
  /** The live config.json (CONFIG_FILE). */
  configFile: string;
  /** Directory the marker is written to (DATA_DIR). */
  dataDir: string;
  /** Injected clock for deterministic marker timestamps in tests. */
  now?: () => Date;
}

export interface MigrateThreadHeaderDashboardLinkOnceResult {
  outcome: ThreadHeaderDashboardLinkOutcome;
  /** Lines arrays (base + themes) that received the field. */
  arraysChanged: number;
  markerFile: string;
}

const FIELD = 'dashboardLink';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A line's field list — `{ fields: [...] }` or a bare array (both accepted by surface-config). */
function fieldsOf(line: unknown): unknown[] | undefined {
  if (Array.isArray(line)) return line;
  if (isPlainObject(line) && Array.isArray(line.fields)) return line.fields;
  return undefined;
}

/** The thread-header registry field an entry renders as, or undefined when surface-config would drop it. */
function headerField(entry: unknown): string | undefined {
  if (!isPlainObject(entry) || typeof entry.field !== 'string') return undefined;
  return resolveSurfaceField('threadheader', entry.field)?.field;
}

/** Apply the additive rule to one lines array in place. Returns whether it changed. */
function addDashboardLink(lines: unknown[]): boolean {
  const fieldLists = lines.map(fieldsOf);
  const known = fieldLists.flatMap((fields) => (fields ?? []).map(headerField)).filter((f) => f !== undefined);
  if (known.length === 0 || known.includes(FIELD)) return false;

  const entry = { field: FIELD, show: true };
  for (const fields of fieldLists) {
    const at = fields?.findIndex((f) => headerField(f) === 'links' || headerField(f) === 'linkhistory') ?? -1;
    if (fields && at >= 0) {
      fields.splice(at, 0, entry);
      return true;
    }
  }
  const titleLine = lines.findIndex(
    (line) => isPlainObject(line) && (line.block === 'header' || line.block === 'section'),
  );
  lines.splice(titleLine + 1, 0, { block: 'context', fields: [entry] });
  return true;
}

/** Parse config.json bytes and apply the rule. `null` = no usable `ui` key. Throws on non-object JSON. */
function applyRule(
  configFile: string,
  bytes: string,
): { parsed: Record<string, unknown>; arraysChanged: number } | null {
  const parsed: unknown = JSON.parse(bytes);
  if (!isPlainObject(parsed)) throw new Error(`config.json root is not an object: ${configFile}`);
  if (!isPlainObject(parsed.ui)) return null;

  const header = parsed.ui.threadheader;
  const arrays: unknown[][] = [];
  if (isPlainObject(header)) {
    if (Array.isArray(header.lines)) arrays.push(header.lines);
    if (isPlainObject(header.themes)) {
      for (const theme of Object.values(header.themes)) {
        if (isPlainObject(theme) && Array.isArray(theme.lines)) arrays.push(theme.lines);
      }
    }
  }
  return { parsed, arraysChanged: arrays.filter((lines) => addDashboardLink(lines)).length };
}

export function migrateThreadHeaderDashboardLinkOnce(
  params: MigrateThreadHeaderDashboardLinkOnceParams,
): MigrateThreadHeaderDashboardLinkOnceResult {
  const now = params.now ?? (() => new Date());
  const markerFile = path.join(params.dataDir, THREADHEADER_DASHBOARD_LINK_ONCE_MARKER);
  const writeMarker = (arraysChanged: number) => {
    fs.mkdirSync(params.dataDir, { recursive: true });
    atomicWriteJson(markerFile, { migratedAt: now().toISOString(), arraysChanged });
  };

  if (fs.existsSync(markerFile)) return { outcome: 'marker-present', arraysChanged: 0, markerFile };
  // No config / no `ui`: no marker, so a config.json that turns up later
  // (restored backup) is still checked; a fresh seed already has the field.
  if (!params.configFile || !fs.existsSync(params.configFile)) {
    return { outcome: 'no-ui', arraysChanged: 0, markerFile };
  }

  // Throws on unreadable / non-object JSON before anything is written.
  let bytes = fs.readFileSync(params.configFile, 'utf8');
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const applied = applyRule(params.configFile, bytes);
    if (!applied) return { outcome: 'no-ui', arraysChanged: 0, markerFile };
    if (applied.arraysChanged === 0) {
      writeMarker(0);
      return { outcome: 'already-present', arraysChanged: 0, markerFile };
    }

    // Compare-and-swap: only replace the exact bytes the rule was applied to.
    const current = fs.readFileSync(params.configFile, 'utf8');
    if (current !== bytes) {
      bytes = current;
      continue;
    }
    writeConfigFileAtomically(params.configFile, `${JSON.stringify(applied.parsed, null, 2)}\n`);
    writeMarker(applied.arraysChanged);
    return { outcome: 'migrated', arraysChanged: applied.arraysChanged, markerFile };
  }
  return { outcome: 'contended', arraysChanged: 0, markerFile };
}
