import { promises as fs } from 'fs';
import path from 'path';
import type { CctStoreSnapshot, SlotState } from './types';

/**
 * Legacy `token-cooldowns.json` entry as recognised by the migrator.
 *
 * Historically the repo shipped two shapes for the same file:
 *  - The task-spec shape with a top-level `entries: [{name, cooldownUntil}]`.
 *  - An earlier shape used by `TokenManager` with a `cooldowns: { [name]: { until } }` map.
 *
 * We accept either and normalise to a `{ name, cooldownUntil }` list
 * before matching against slot names. This keeps the migrator useful
 * for any deployment, regardless of which shape happens to exist on disk.
 */
interface LegacyEntry {
  name: string;
  cooldownUntil: string;
}

interface LegacyEntriesShape {
  entries?: Array<{ name?: unknown; cooldownUntil?: unknown }>;
}

interface LegacyMapShape {
  cooldowns?: Record<string, { until?: unknown } | undefined>;
}

type LegacyFile = LegacyEntriesShape & LegacyMapShape;

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseLegacyEntries(raw: string): LegacyEntry[] {
  let parsed: LegacyFile;
  try {
    parsed = JSON.parse(raw) as LegacyFile;
  } catch (err) {
    console.warn('cct-store: failed to parse legacy token-cooldowns.json', err);
    return [];
  }
  const out: LegacyEntry[] = [];
  if (Array.isArray(parsed.entries)) {
    for (const entry of parsed.entries) {
      if (entry && isString(entry.name) && isString(entry.cooldownUntil)) {
        out.push({ name: entry.name, cooldownUntil: entry.cooldownUntil });
      }
    }
  }
  if (parsed.cooldowns && typeof parsed.cooldowns === 'object') {
    for (const [name, value] of Object.entries(parsed.cooldowns)) {
      if (value && isString(value.until)) {
        out.push({ name, cooldownUntil: value.until });
      }
    }
  }
  return out;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fold a legacy `token-cooldowns.json` (if present under `dataDir`) into
 * the given snapshot. Matched entries attach their `cooldownUntil` to the
 * corresponding slot's `SlotState`; unmatched (orphan) entries emit a
 * warning. On success the legacy file is renamed to
 * `token-cooldowns.json.migrated.<ISO>` so the migration is idempotent.
 *
 * The returned snapshot is a NEW object — the input is not mutated.
 */
export async function migrateLegacyCooldowns(snapshot: CctStoreSnapshot, dataDir: string): Promise<CctStoreSnapshot> {
  const legacyPath = path.join(dataDir, 'token-cooldowns.json');
  if (!(await pathExists(legacyPath))) {
    return snapshot;
  }

  let raw: string;
  try {
    raw = await fs.readFile(legacyPath, 'utf8');
  } catch (err) {
    console.warn('cct-store: failed to read legacy token-cooldowns.json', err);
    return snapshot;
  }

  const entries = parseLegacyEntries(raw);

  const nextState: Record<string, SlotState> = { ...snapshot.state };
  const byName = new Map(snapshot.registry.slots.map((slot) => [slot.name, slot]));

  for (const entry of entries) {
    const slot = byName.get(entry.name);
    if (!slot) {
      console.warn(`cct-store: orphan legacy cooldown '${entry.name}' — no matching slot`);
      continue;
    }
    const prev = nextState[slot.slotId] ?? { authState: 'healthy' as const, activeLeases: [] };
    nextState[slot.slotId] = { ...prev, cooldownUntil: entry.cooldownUntil };
  }

  const renamedPath = `${legacyPath}.migrated.${new Date().toISOString()}`;
  try {
    await fs.rename(legacyPath, renamedPath);
  } catch (err) {
    console.warn('cct-store: failed to rename migrated legacy file', err);
  }

  return {
    ...snapshot,
    state: nextState,
  };
}
