/**
 * Transcript sanitizer — repairs Claude Agent SDK session transcripts that
 * contain EMPTY text content blocks.
 *
 * Field incident (dev, 2026-07-07T08:32Z, session ccee16e0): a gpt-5.5 turn
 * emitted an assistant message whose content was a single
 * `{"type":"text","text":""}` block (stop_reason=tool_use). The SDK persisted
 * it verbatim into `<configDir>/projects/<encoded-cwd>/<sessionId>.jsonl`.
 * gpt-5.5 requests tolerated the poison, but the moment ANY Anthropic-model
 * call replayed that history — the auto-fallback `/compact` on `opus[1m]`,
 * every subsequent turn after the model switch, even goal-eval one-shots —
 * the API rejected the whole request with
 * `400 "messages: text content blocks must be non-empty"`. The session was
 * wedged: compaction could never succeed because compaction itself replays
 * the poisoned history.
 *
 * Repair strategy (Codex-reviewed):
 *   - NEVER delete jsonl records — `parentUuid` lineage must stay intact.
 *   - Within a record's `message.content` array: DROP empty text blocks when
 *     other blocks remain (semantically cleanest — no fabricated content);
 *     when the array would become empty, REPLACE the text with a visibly
 *     artificial marker instead so the record keeps a valid non-empty block.
 *   - Atomic write: same-directory temp file + rename.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Marker used when an empty text block cannot be dropped (sole block). */
export const EMPTY_TEXT_REPAIR_MARKER = '[empty text block repaired]';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TranscriptSanitizeResult {
  /** Resolved transcript path, or `null` when the session file was not found. */
  transcriptPath: string | null;
  /** Number of empty text blocks dropped or replaced. `0` = nothing to repair. */
  repairedBlocks: number;
}

/**
 * The SDK's config dir. Honors `CLAUDE_CONFIG_DIR` (soma-work deployments set
 * it per instance, e.g. `/opt/soma-work/dev/.claude`); falls back to
 * `~/.claude`.
 */
export function resolveClaudeConfigDir(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.CLAUDE_CONFIG_DIR;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv;
  return path.join(os.homedir(), '.claude');
}

/**
 * Locate `projects/<encoded-cwd>/<sessionId>.jsonl` for a session. Scans the projects dir
 * instead of re-deriving the SDK's cwd-encoding (which is lossy — `/`, `_`,
 * `.` all map to `-`); the session UUID is unique, so a scan is exact. When
 * multiple project dirs somehow contain the same session id, the most
 * recently modified file wins.
 *
 * `sessionId` is validated as a UUID before touching the filesystem so a
 * malformed value can never traverse paths.
 */
export function findTranscriptPath(sessionId: string, configDir?: string): string | null {
  if (!UUID_RE.test(sessionId)) return null;
  const projectsDir = path.join(configDir ?? resolveClaudeConfigDir(), 'projects');

  let entries: string[];
  try {
    entries = fs.readdirSync(projectsDir);
  } catch {
    return null;
  }

  let best: string | null = null;
  let bestMtime = -1;
  for (const entry of entries) {
    const candidate = path.join(projectsDir, entry, `${sessionId}.jsonl`);
    try {
      const st = fs.lstatSync(candidate);
      if (st.isFile() && st.mtimeMs > bestMtime) {
        best = candidate;
        bestMtime = st.mtimeMs;
      }
    } catch {
      // entry without this session file — skip
    }
  }
  return best;
}

function isEmptyTextBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false;
  const b = block as Record<string, unknown>;
  if (b.type !== 'text') return false;
  return typeof b.text !== 'string' || b.text.trim() === '';
}

/**
 * Repair a session transcript in place: drop/replace empty text content
 * blocks (see module doc for the exact strategy). Returns how many blocks
 * were repaired; `repairedBlocks === 0` means the transcript was already
 * clean (or the file could not be found/parsed).
 *
 * Malformed lines are passed through untouched — this function must never
 * make a transcript worse than it found it.
 */
export function sanitizeTranscriptEmptyTextBlocks(
  sessionId: string,
  opts?: { configDir?: string },
): TranscriptSanitizeResult {
  const transcriptPath = findTranscriptPath(sessionId, opts?.configDir);
  if (!transcriptPath) return { transcriptPath: null, repairedBlocks: 0 };

  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return { transcriptPath, repairedBlocks: 0 };
  }

  const lines = raw.split('\n');
  let repaired = 0;

  const out = lines.map((line) => {
    // Cheap pre-filter: empty text blocks always serialize with `"text"`.
    if (line === '' || !line.includes('"text"')) return line;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return line;
    }

    const message = obj?.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content) || content.length === 0) return line;

    const emptyCount = content.filter(isEmptyTextBlock).length;
    if (emptyCount === 0) return line;

    if (emptyCount < content.length) {
      // Other blocks remain (e.g. text + tool_use) — drop the empty ones.
      message!.content = content.filter((b) => !isEmptyTextBlock(b));
      repaired += emptyCount;
    } else {
      // Every block is an empty text block — replace text with the marker so
      // the record keeps valid, visibly-artificial content.
      for (const b of content as Array<Record<string, unknown>>) {
        b.text = EMPTY_TEXT_REPAIR_MARKER;
        repaired++;
      }
    }
    return JSON.stringify(obj);
  });

  if (repaired === 0) return { transcriptPath, repairedBlocks: 0 };

  // Atomic same-directory write so a crash mid-write cannot truncate the
  // original transcript.
  const tmpPath = `${transcriptPath}.repair-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, out.join('\n'), 'utf8');
    fs.renameSync(tmpPath, transcriptPath);
  } catch {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best-effort tmp cleanup
    }
    return { transcriptPath, repairedBlocks: 0 };
  }

  return { transcriptPath, repairedBlocks: repaired };
}
