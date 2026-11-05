/**
 * Anthropic safeguards flag — recognition and the session lock it sets.
 *
 * When Anthropic's safeguards block a request, Claude Code does not throw: it
 * hands the block back as the turn's text with a successful result
 * (`stopReason: end_turn`, `isError: false` — dev log 2026-11-04T00:42Z):
 *
 *   API Error: Opus 5.5 (1M context)'s safeguards flagged this message (…aup).
 *   … Try rephrasing the request in a new session or change your model.
 *   Details: `[reasoning_extraction]`
 *   Request ID: req_…
 *   Message ID: msg_…
 *
 * The session cannot go on with that model, so the host stops the work at
 * once and only an admin may retry it (see `SafeguardHalt`).
 */

/** What the block says about itself. Every field is optional — older wordings carry none. */
export interface SafeguardFlagInfo {
  /** The model display name before `'s safeguards`, e.g. `Opus 5.5 (1M context)`. */
  model?: string;
  /** The `Details:` code, e.g. `reasoning_extraction`. */
  detail?: string;
  requestId?: string;
  messageId?: string;
}

/**
 * The lock a safeguards flag puts on a session (persisted in sessions.json).
 * While it is set no turn runs in the session — not a goal continuation, not an
 * auto-resume, not a message (an admin's included). Only an admin's press of the
 * "관리자 재시도 허용" button on its notice lifts it.
 */
export interface SafeguardHalt extends SafeguardFlagInfo {
  /** When the flag arrived (epoch ms). */
  atMs: number;
}

/**
 * A turn's text is read as the block only up to this length — the bound the
 * compaction-leak guard uses. A longer text is an answer, not the SDK's line.
 */
const TURN_TEXT_MAX_CHARS = 1500;

// The API refusal as the installed Claude Code renders it (`dot()`, 2.1.284 —
// read from its bundled source; review R10, astra P1), every shape:
//   - `API Error: <model>'s safeguards flagged this message …`
//   - `API Error: <model>'s safeguards flagged this session …` (Opus 5.5 cyber /
//     bio / frontier_llm)
//   - `API Error: <model> can't help with this. Start a new session to continue.`
//     (a model the CLI cannot name)
// The older Claude Code "appears to violate our Usage Policy" refusal is NOT
// matched: there is no authentic anchored sample of it (trinity design consult).
const BLOCK_RE =
  /API Error:[ \t]*(?:(.{1,160}?)['\u2019]s safeguards flagged this (?:message|session)|(.{1,160}?) can['\u2019]t help with this\. Start a new session to continue)/i;
const DETAIL_RE = /^[ \t]*Details:[ \t]*`?\[?([A-Za-z0-9_.:-]+)\]?`?/im;
const REQUEST_ID_RE = /^[ \t]*Request ID:[ \t]*`?(req_[A-Za-z0-9]+)/im;
const MESSAGE_ID_RE = /^[ \t]*Message ID:[ \t]*`?(msg_[A-Za-z0-9]+)/im;

/**
 * The block's details when `text` is a safeguards flag, else `null`.
 *
 * - `source: 'turn'` (default) — the turn's text. It must START with the block
 *   (after whitespace) and stay within {@link TURN_TEXT_MAX_CHARS}: an answer
 *   that explains or quotes the error (this very feature's sessions do) is
 *   never read as one.
 * - `source: 'error'` — a thrown error's message or stderr: the block may sit
 *   on any line (`Claude Code process exited with code 1\nAPI Error: …`).
 *
 * Either way the block must carry at least one of its anchor lines
 * (`Details:`, `Request ID:`, `Message ID:`) — the bare sentence is prose.
 */
export function parseSafeguardFlag(text: unknown, opts: { source?: 'turn' | 'error' } = {}): SafeguardFlagInfo | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  if ((opts.source ?? 'turn') === 'turn') {
    if (text.length > TURN_TEXT_MAX_CHARS) return null;
    const tail = text.trimStart();
    return tail.startsWith('API Error:') ? parseBlockAt(tail) : null;
  }
  // An error source may carry several `API Error:` lines (an SDK result's
  // `errors[]` joined, stderr): a generic one first must not hide the block.
  const starts = /(?:^|\n)[ \t]*(?=API Error:)/g;
  for (let m = starts.exec(text); m; m = starts.exec(text)) {
    const found = parseBlockAt(text.slice(m.index + m[0].length));
    if (found) return found;
    if (m[0].length === 0) starts.lastIndex++;
  }
  return null;
}

/** The block when `tail` STARTS with it (and carries an anchor line), else null. */
function parseBlockAt(tail: string): SafeguardFlagInfo | null {
  const block = BLOCK_RE.exec(tail);
  if (!block || block.index !== 0) return null;
  const detail = DETAIL_RE.exec(tail)?.[1];
  const requestId = REQUEST_ID_RE.exec(tail)?.[1];
  const messageId = MESSAGE_ID_RE.exec(tail)?.[1];
  if (!detail && !requestId && !messageId) return null;
  const model = (block[1] ?? block[2])?.trim();
  return {
    ...(model ? { model } : {}),
    ...(detail ? { detail } : {}),
    ...(requestId ? { requestId } : {}),
    ...(messageId ? { messageId } : {}),
  };
}

/** The block a thrown error carries: the content guard's tag, else its message, else its stderr. */
export function safeguardFlagOf(error: unknown): SafeguardFlagInfo | null {
  if (!error || typeof error !== 'object') return null;
  const err = error as { safeguardFlag?: unknown; message?: unknown; stderrContent?: unknown };
  if (err.safeguardFlag && typeof err.safeguardFlag === 'object') return err.safeguardFlag as SafeguardFlagInfo;
  return (
    parseSafeguardFlag(err.message, { source: 'error' }) ?? parseSafeguardFlag(err.stderrContent, { source: 'error' })
  );
}

export function isSafeguardFlagError(error: unknown): boolean {
  return safeguardFlagOf(error) !== null;
}

/** One line naming what the block said: model · Details · Request ID (the parts it carried). */
export function formatSafeguardDetail(info: SafeguardFlagInfo): string {
  const parts: string[] = [];
  if (info.model) parts.push(`모델 \`${info.model}\``);
  if (info.detail) parts.push(`Details \`${info.detail}\``);
  if (info.requestId) parts.push(`Request ID \`${info.requestId}\``);
  return parts.join(' · ');
}

/** A persisted halt back as the session carries it — `undefined` for anything malformed. */
export function restoreSafeguardHalt(raw: unknown): SafeguardHalt | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.atMs !== 'number' || !Number.isFinite(r.atMs)) return undefined;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const model = str(r.model);
  const detail = str(r.detail);
  const requestId = str(r.requestId);
  const messageId = str(r.messageId);
  return {
    atMs: r.atMs,
    ...(model ? { model } : {}),
    ...(detail ? { detail } : {}),
    ...(requestId ? { requestId } : {}),
    ...(messageId ? { messageId } : {}),
  };
}
