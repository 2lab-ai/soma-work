import { type FollowupItem, type FollowupItemState, FREEZE_PARKED_STATES } from './followup-queue';
import { escapeSlackMrkdwn } from './mrkdwn-escape';

/**
 * Block Kit renderer for the follow-up message queue (U3 of `.prd/slack-agent-ui`).
 *
 * Pure: no Slack client, no network, no clock, no filesystem. It takes a queue
 * view (a `FollowupSessionSnapshot` is assignable as-is) and returns the
 * `{ blocks, text }` pair the host posts/updates. The host owns surfacing and
 * action wiring; every identifier it needs is exported from here.
 *
 * Contract highlights (`.prd/slack-agent-ui/ssot.md`):
 *   - §2  the surface is titled `Queue` and the canonical button label is
 *     `Send now` (`Steering now` in the user's sketch is the same action).
 *   - §3.6 the existing autogoal `Goals` queue is a SEPARATE surface — this
 *     builder renders follow-up items only and never merges the two.
 *   - §3.4/§3.5 a denied dispatch stays `queued` + reason (still actionable);
 *     a freeze is `paused`/`uncertain` and leaves only through an explicit
 *     Resume/Retry. The two are never collapsed into one label (A29), and the
 *     freeze is scoped PER ITEM ({@link FREEZE_PARKED_STATES}): a row that
 *     arrived after it renders like any other live message.
 *   - §3.5/R6 `failed` and `uncertain` never auto-retry. `uncertain` may have
 *     already produced side effects, so its Retry carries a confirm dialog in
 *     the legacy layout; the compact layout, whose single control is an
 *     overflow menu that cannot confirm one option only, states the caution on
 *     the item line instead.
 *
 * Slack constraints honoured (docs/misc/reference/slack-block-kit.md §1.1–1.3,
 * https://docs.slack.dev/reference/block-kit/blocks/section-block.md,
 * https://docs.slack.dev/reference/block-kit/block-elements/button-element.md,
 * https://docs.slack.dev/reference/block-kit/composition-objects/confirmation-dialog-object.md):
 *   - message ≤50 blocks → paging, with the page size clamped (≤20 items =
 *     ≤44 blocks) so a long backlog can never overflow the payload;
 *   - `section.text` ≤3000, `button.text` ≤75, `button.value` ≤2000,
 *     confirm `title` ≤100 / `text` ≤300 / `confirm`+`deny` ≤30;
 *   - `button.disabled` does not exist — an unavailable control is OMITTED;
 *   - `action_id` must be unique inside its containing block, so the two
 *     pagination buttons have their own ids;
 *   - `block_id` is deliberately never set: Slack generates fresh ids and
 *     forbids reusing them across `chat.update`.
 *
 * Layouts: `compact` (the DEFAULT since 2026-09-17) spends exactly ONE block per
 * item — a `section` line carrying `seq · message · state`, with every operation
 * folded into one `overflow` menu — because the live panel's section+context pair
 * per item plus a 3-line meta header made the surface unreadably tall. The
 * pre-compact layout stays reachable with `compact: false`; both render the same
 * item set and neither hides an item.
 *
 * Security: the legacy layout emits `plain_text` only. The compact line has to be
 * `mrkdwn` (it italicises the state), so the untrusted message and its reason are
 * run through `escapeSlackMrkdwn` FIRST — `&`/`<`/`>` become entities, which is
 * exactly what stops `<!channel>`/`<@U…>` mentions and `<url|label>` links from
 * being minted by a queued message. `verbatim: true` additionally disables
 * Slack's auto-linkification. Emphasis characters (`*_~`) address nobody either,
 * but an italic run inside a compact preview reads as a state label, so the
 * preview maps them to look-alikes ({@link COMPACT_EMPHASIS_LOOKALIKES}). What
 * that pair of measures guarantees on a compact row: the true state is always
 * last, and emphasis characters in the preview are neutralised. The fallback `text`
 * (which Slack DOES parse) carries counts only, never message content. Button and
 * menu-option `value`s carry queue coordinates only — a button spells them out
 * (`{sessionKey,itemId,epoch}` + `turnEpoch` on `Send now`), a menu option uses
 * the short form the 150-char option cap forces (`{op,s,n,e,t}`, where `n` is the
 * item's `seq` and the id is rebuilt from it) — and nothing else: no author, no
 * token, no working directory, no message text (A30).
 *
 * Block union typing stays loose (`unknown[]`), matching the existing builders
 * in this repo (`src/slack/commands/usage-carousel-blocks.ts:13`); `@slack/types`
 * is not a declared dependency of `@soma/slack` and adding one is out of scope.
 */

/** Section title of the surface. Kept distinct from the autogoal `Goals` queue. */
export const FOLLOWUP_QUEUE_TITLE = 'Queue';

/** Canonical labels (SSOT §2). */
export const FOLLOWUP_SEND_NOW_LABEL = 'Send now';
export const FOLLOWUP_RESUME_LABEL = 'Resume';
export const FOLLOWUP_RETRY_LABEL = 'Retry';
export const FOLLOWUP_CANCEL_LABEL = 'Cancel';

/**
 * What a `steered` item says on its line (06 §3.5, user wording).
 *
 * `steered` is a queue-internal word for a fact the user has no other way to
 * read: the message has left our queue into the RUNNING turn's SDK input channel,
 * and the model picks it up at its next tool-call boundary — nothing is stuck
 * and nothing was interrupted. The row leaves the live set and stays as history
 * when the SDK's consumption receipt turns it into `resolved · consumed`.
 */
export const FOLLOWUP_STEERED_LABEL = '전달됨 · 모델이 다음 툴 호출에서 읽음';
/** The same state in a counts line, where every state gets exactly one word. */
export const FOLLOWUP_STEERED_COUNT_LABEL = '전달';

/** Stable action ids for host wiring. Versioned; no existing prefix collides. */
export const FOLLOWUP_SEND_NOW_ACTION_ID = 'followup_send_now_v1';
export const FOLLOWUP_RESUME_ACTION_ID = 'followup_resume_v1';
export const FOLLOWUP_RETRY_ACTION_ID = 'followup_retry_v1';
/**
 * Cancel as a BUTTON (A39). It had no button id before, because the panel's
 * compact layout folded every operation into one overflow menu; the in-thread
 * item message asks for the two controls by name, so cancel needs an id of its
 * own. The payload is the ordinary item value — `handleCancel` is reached by a
 * second transport, never by a second policy.
 */
export const FOLLOWUP_CANCEL_ACTION_ID = 'followup_cancel_v1';
export const FOLLOWUP_PAGE_PREV_ACTION_ID = 'followup_page_prev_v1';
export const FOLLOWUP_PAGE_NEXT_ACTION_ID = 'followup_page_next_v1';
/**
 * The compact layout's single per-item control. One `action_id` for every
 * operation: the clicked option's `value` says WHICH one (`op`), so the host
 * registers one handler instead of four. The per-op button ids above stay
 * exported and stay live in the legacy layout.
 */
export const FOLLOWUP_ITEM_MENU_ACTION_ID = 'followup_item_menu_v1';

/**
 * All item-scoped action ids, for a host that registers them in one pass —
 * BOTH layouts. The compact menu id belongs here because compact is the
 * default: a host that registered only the three per-op button ids would wire
 * up every control the legacy layout can emit and none of the ones actually on
 * screen.
 */
export const FOLLOWUP_ITEM_ACTION_IDS = [
  FOLLOWUP_SEND_NOW_ACTION_ID,
  FOLLOWUP_RESUME_ACTION_ID,
  FOLLOWUP_RETRY_ACTION_ID,
  FOLLOWUP_ITEM_MENU_ACTION_ID,
  FOLLOWUP_CANCEL_ACTION_ID,
] as const;

/** Both pagination action ids. */
export const FOLLOWUP_PAGE_ACTION_IDS = [FOLLOWUP_PAGE_PREV_ACTION_ID, FOLLOWUP_PAGE_NEXT_ACTION_ID] as const;

export const FOLLOWUP_QUEUE_DEFAULT_PAGE_SIZE = 10;
/** ≤20 items → 2 + 1 + 40 + 1 = 44 blocks, inside Slack's 50-block message cap. */
export const FOLLOWUP_QUEUE_MAX_PAGE_SIZE = 20;

/** Compact spends exactly one block per item (the section line carrying its menu). */
export const FOLLOWUP_QUEUE_COMPACT_BLOCKS_PER_ITEM = 1;
/**
 * Compact blocks that are NOT item rows, worst case: the one-line header, the
 * freeze line, and the pagination row. Two of the three are conditional, so
 * this is an upper bound — budgeting against it can only leave a block unused,
 * never overflow the caller's allowance.
 */
export const FOLLOWUP_QUEUE_COMPACT_FIXED_BLOCKS = 3;

/**
 * How many items the COMPACT layout can render inside `budget` blocks.
 *
 * Exists so an embedding surface (the combined thread panel) budgets the queue
 * with the layout's real accounting instead of a copy that drifts from it: the
 * pre-compact layout spent two blocks per item, and a caller still assuming
 * that halves the page for no reason. Result is clamped to
 * {@link FOLLOWUP_QUEUE_MAX_PAGE_SIZE} and never negative.
 */
export function followupQueueCompactCapacity(budget: number): number {
  if (!Number.isFinite(budget)) return 0;
  const forItems = Math.floor(budget) - FOLLOWUP_QUEUE_COMPACT_FIXED_BLOCKS;
  if (forItems < 1) return 0;
  return Math.min(Math.floor(forItems / FOLLOWUP_QUEUE_COMPACT_BLOCKS_PER_ITEM), FOLLOWUP_QUEUE_MAX_PAGE_SIZE);
}

const MAX_BUTTON_VALUE = 2000;
const MAX_SECTION_TEXT = 3000;
/**
 * An option object is NOT a button: `text` ≤75 and `value` ≤150
 * (https://docs.slack.dev/reference/block-kit/composition-objects/option-object,
 * verified 2026-09-17), and an overflow menu takes at most five of them
 * (https://docs.slack.dev/reference/block-kit/block-elements/overflow-menu-element).
 * A real session key is ~34 chars (`work:<channel>:<threadTs>`), so the long-key
 * payload sat at ~140/150 — see {@link encodeFollowupMenuValue} for why the menu
 * wire form is short-keyed. The short form lands near 85, which is headroom.
 */
const MAX_OPTION_VALUE = 150;
const MAX_OPTION_TEXT = 75;
const MAX_MENU_OPTIONS = 5;
/** Display-only clamp. The stored item is never modified — counts stay authoritative. */
const PREVIEW_MAX_CHARS = 280;
/**
 * Mrkdwn emphasis characters, and the look-alike code points the COMPACT
 * preview replaces them with.
 *
 * `escapeSlackMrkdwn` deliberately leaves `*_~` alone — they cannot address
 * anybody — but the compact row renders the real state as `_italic_`, so an
 * italic run inside the message text reads as one more state label sitting
 * before the real one (`작업 · _전달됨 · 모델이 다음 툴 호출에서 읽음_`). Each
 * replacement is a single code point, so the truncation budget is unchanged and
 * the word itself stays readable — only its markers change.
 */
const COMPACT_EMPHASIS_LOOKALIKES: Readonly<Record<string, string>> = {
  '*': '∗', // U+2217 ASTERISK OPERATOR
  _: 'ˍ', // U+02CD MODIFIER LETTER LOW MACRON
  '~': '∼', // U+223C TILDE OPERATOR
};
/** Compact is one line per item: the preview has to stay inside one rendered row. */
const COMPACT_PREVIEW_MAX_CHARS = 80;
const COMPACT_REASON_MAX_CHARS = 40;
/** R6 in one phrase — an uncertain item may already have run, so re-running is a decision. */
const COMPACT_UNCERTAIN_CAUTION = '재실행 전 확인';
/** Said on the item line, in BOTH layouts, whenever a control had to be dropped. */
const ACTION_UNAVAILABLE = 'action unavailable';

/**
 * The freeze reason the restart path writes verbatim (`slack-handler.ts:623`
 * → `followup-queue.ts:763`, which stores the caller's string as given).
 * Exported so the mapping below is pinned against the producer's constant
 * instead of a copy that can drift out of it.
 */
export const FOLLOWUP_RESTART_FREEZE_REASON = 'process restart';

/**
 * What the banner says under a restart freeze, in the user's words.
 *
 * A restart freeze parks ONLY the items the session already held
 * ({@link FREEZE_PARKED_STATES} — `paused`/`uncertain`); a message sent
 * afterwards is `queued` and dispatches normally. Printing the raw reason made
 * the panel read as "this queue is stopped", the same misreading the 2026-09-17
 * live bug produced in chat ("큐가 멈춰 있어 자동으로 실행되지 않습니다"), so the
 * sentence names its own scope (재시작 전 항목) and points at the control that
 * runs them.
 *
 * The control is named per STATE rather than per layout: Resume releases a
 * `paused` row and Retry is the only door out of an `uncertain` one, so the row
 * itself tells the user which word applies. Naming the compact `⋯` menu instead
 * was wrong in the legacy layout, where the same sentence sits over per-op
 * buttons.
 */
export const FOLLOWUP_RESTART_FREEZE_NOTICE =
  '재시작 전에 남아 있던 항목입니다 — 자동으로 다시 실행하지 않습니다. 필요하면 해당 항목의 Resume(보류)/Retry(불확실)로 실행하세요.';

/**
 * The freeze line both layouts render.
 *
 * Only the restart reason is rewritten. Every other reason is a sentence the
 * stop path (or a user) already chose, so it is passed through with the generic
 * frame — guessing at a wording for a reason this module does not own would
 * replace the operator's words with ours.
 */
export function followupFreezeBannerText(reason: string): string {
  if (reason.trim() === FOLLOWUP_RESTART_FREEZE_REASON) return FOLLOWUP_RESTART_FREEZE_NOTICE;
  return `보류된 항목이 있습니다 (${reason}) — 보류 항목은 Resume/Retry로 실행하고, 새 메시지는 정상 실행됩니다.`;
}

/**
 * What the builder needs. `FollowupSessionSnapshot` satisfies this structurally,
 * so a caller can pass either a snapshot or a `(sessionKey, list, freeze)` view.
 */
export interface FollowupQueueView {
  sessionKey: string;
  items: readonly FollowupItem[];
  freeze?: { reason: string; at: number };
  /**
   * The session's persisted turn-generation counter at render time (SSOT §3.3,
   * A12/A28). It is stamped onto `Send now` so a control minted by an earlier
   * dispatch is rejected instead of steering the new turn. The renderer only
   * passes this value through — it never derives or advances a counter of its
   * own; the queue owns it. Defaults to 0 when the caller has none yet.
   */
  turnEpoch?: number;
}

export interface FollowupQueueBlocksOptions {
  /** 1-based. Out-of-range / non-integer input is clamped, never rendered empty. */
  page?: number;
  pageSize?: number;
  /**
   * One block per item + a one-line header + one overflow menu per item.
   * Defaults to TRUE. `false` restores the pre-2026-09-17 layout (a section and
   * a context line per item, per-op buttons) — kept for callers that pin it.
   */
  compact?: boolean;
}

export interface FollowupQueueBlocksResult {
  blocks: unknown[];
  /** Slack requires a top-level fallback when `blocks` is used. Counts only. */
  text: string;
}

/** The payload every item-scoped button carries. */
export interface FollowupItemActionValue {
  sessionKey: string;
  itemId: string;
  /** The ITEM's CAS token — guards late writes against that one item. */
  epoch: number;
  /**
   * The SESSION's turn generation, present on `Send now` only: steering targets
   * the live turn, so a button minted in a previous dispatch must be refused.
   * `Resume`/`Retry` act on an item that is by definition not running, so they
   * are not gated on the turn generation and omit this field.
   */
  turnEpoch?: number;
}

/** The payload both pagination buttons carry. */
export interface FollowupPageActionValue {
  sessionKey: string;
  page: number;
}

/**
 * Which queue operation a compact menu option stands for. The compact layout
 * has one `action_id`, so this field — not the id — is what the host switches
 * on. Closed set: an unknown `op` is rejected, never guessed at.
 */
export type FollowupItemOp = 'send_now' | 'cancel' | 'retry' | 'resume';

export const FOLLOWUP_ITEM_OPS: readonly FollowupItemOp[] = ['send_now', 'cancel', 'retry', 'resume'];

/** A compact menu option's payload: the item-button payload plus the chosen op. */
export interface FollowupItemMenuValue extends FollowupItemActionValue {
  op: FollowupItemOp;
}

/**
 * Stable display order for a per-state counts breakdown, shared by this
 * builder's legacy header and the combined panel's fallback text
 * (`thread-surface.ts`) so the two cannot drift into two different orders for
 * the same queue. `steered` sits right after `queued`: it is the same message
 * one step further along the same path, not a separate outcome.
 */
export const FOLLOWUP_STATE_DISPLAY_ORDER = [
  'queued',
  'steered',
  'reserved',
  'claimed',
  'dispatched',
  'paused',
  'uncertain',
  'failed',
  'resolved',
  'cancelled',
] as const satisfies readonly FollowupItemState[];

/**
 * The states an item can still be acted on from — what the `queue` command
 * lists (A40) and, with it, the set this module calls "not processed yet".
 *
 * `resolved`/`cancelled` are history (the message ran, or the user dropped it)
 * and the in-flight trio (`reserved`/`claimed`/`dispatched`) belongs to the turn
 * that is running it, not to a list of things still waiting. `failed` stays in
 * because a failed item is still the user's message, awaiting a Retry.
 */
export const FOLLOWUP_PENDING_STATES = [
  'queued',
  'steered',
  'paused',
  'uncertain',
  'failed',
] as const satisfies readonly FollowupItemState[];

/**
 * Compile-time proof the order above lists EVERY state.
 *
 * The breakdown is a `.filter()` over that order ({@link stateBreakdown}), so a
 * state missing from it is dropped from the counts with no error anywhere: the
 * items still render, the summary just under-reports them. Typing the constant
 * as `readonly FollowupItemState[]` could not catch that — only `as const` keeps
 * the element literals, which makes this `Exclude` non-empty (and this line a
 * compile error) the moment a new state is added to `FollowupItemState` without
 * being given a place in the order.
 */
const _FOLLOWUP_STATE_DISPLAY_ORDER_IS_EXHAUSTIVE: Exclude<
  FollowupItemState,
  (typeof FOLLOWUP_STATE_DISPLAY_ORDER)[number]
> extends never
  ? true
  : never = true;

/**
 * What one state reads as on an item line. Every state is its own enum name —
 * they are already the words the runbooks use — except `steered`, which names
 * an SDK-side fact no user can be expected to decode ({@link FOLLOWUP_STEERED_LABEL}).
 */
export function followupStateLabel(state: FollowupItemState): string {
  return state === 'steered' ? FOLLOWUP_STEERED_LABEL : state;
}

/** Same mapping for a counts line, where a whole sentence would not fit. */
export function followupStateCountLabel(state: FollowupItemState): string {
  return state === 'steered' ? FOLLOWUP_STEERED_COUNT_LABEL : state;
}

/**
 * Sole encoder of an item-scoped BUTTON payload (the legacy layout). Buttons
 * have a 2000-char `value`, so the field names are spelled out.
 */
export function encodeFollowupItemActionValue(value: FollowupItemActionValue): string {
  const payload: Record<string, unknown> = {};
  payload.sessionKey = value.sessionKey;
  payload.itemId = value.itemId;
  payload.epoch = value.epoch;
  if (value.turnEpoch !== undefined) payload.turnEpoch = value.turnEpoch;
  return JSON.stringify(payload);
}

/** What a compact menu option needs to name one item. `seq`, not the item id. */
export interface FollowupItemMenuCoordinates {
  sessionKey: string;
  /** `FollowupItem.seq` — the id is `${sessionKey}#${seq}` (`followup-queue.ts:315`). */
  seq: number;
  epoch: number;
  turnEpoch?: number;
}

/**
 * Sole encoder of a compact MENU option payload (A30 — coordinates only).
 *
 * An option `value` is capped at 150 chars, an order of magnitude below a
 * button's 2000, and a real session key is `work:<channel>:<threadTs>`
 * (`src/session-identity.ts:45`) ≈ 34 chars. The long-key encoding spelled that
 * key twice — once as `sessionKey`, once inside `itemId` — which put a
 * `send_now` option at ~140/150: one longer channel id from being dropped by
 * the cap check below. So the wire form is short-keyed and carries the item's
 * `seq` instead of its id; {@link parseFollowupMenuValue} rebuilds the id. The
 * key names are an internal wire detail — nothing outside this file reads them.
 */
export function encodeFollowupMenuValue(value: FollowupItemMenuCoordinates, op: FollowupItemOp): string {
  const payload: Record<string, unknown> = { op, s: value.sessionKey, n: value.seq, e: value.epoch };
  if (value.turnEpoch !== undefined) payload.t = value.turnEpoch;
  return JSON.stringify(payload);
}

export function encodeFollowupPageActionValue(value: FollowupPageActionValue): string {
  return JSON.stringify({ sessionKey: value.sessionKey, page: value.page });
}

function parseObject(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Parse an item button `value`. Returns null on anything unexpected — never guesses. */
export function parseFollowupItemActionValue(value: string | undefined): FollowupItemActionValue | null {
  const parsed = parseObject(value);
  if (!parsed) return null;
  const { sessionKey, itemId, epoch, turnEpoch } = parsed;
  const keys = Object.keys(parsed).length;
  if (keys !== 3 && keys !== 4) return null;
  if (keys === 4 && turnEpoch === undefined) return null;
  if (typeof sessionKey !== 'string' || !sessionKey) return null;
  if (typeof itemId !== 'string' || !itemId) return null;
  if (typeof epoch !== 'number' || !Number.isFinite(epoch)) return null;
  if (turnEpoch === undefined) return { sessionKey, itemId, epoch };
  if (typeof turnEpoch !== 'number' || !Number.isFinite(turnEpoch)) return null;
  return { sessionKey, itemId, epoch, turnEpoch };
}

/**
 * Parse a compact menu option `value` (`{op,s,n,e,t?}`, see
 * {@link encodeFollowupMenuValue}). Returns `undefined` on anything unexpected
 * — an unknown `op`, a missing coordinate, an extra field, a wrong type,
 * including a stale button carrying the pre-2026-09-17 long-key form. The
 * caller-visible shape is unchanged: `itemId` is rebuilt from `s` and `n`
 * exactly as the queue mints it, so no handler has to know the wire names.
 */
export function parseFollowupMenuValue(value: string | undefined): FollowupItemMenuValue | undefined {
  const parsed = parseObject(value);
  if (!parsed) return undefined;
  const { op, s, n, e, t } = parsed;
  const keys = Object.keys(parsed).length;
  if (keys !== 4 && keys !== 5) return undefined;
  if (keys === 5 && t === undefined) return undefined;
  if (typeof op !== 'string' || !FOLLOWUP_ITEM_OPS.includes(op as FollowupItemOp)) return undefined;
  if (typeof s !== 'string' || !s) return undefined;
  // `seq` is a queue-minted counter: a non-integer would rebuild an item id
  // that cannot exist, and looking it up would 'not-found' instead of refusing.
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return undefined;
  if (typeof e !== 'number' || !Number.isFinite(e)) return undefined;
  const base = { sessionKey: s, itemId: `${s}#${n}`, epoch: e };
  if (t === undefined) return { op: op as FollowupItemOp, ...base };
  if (typeof t !== 'number' || !Number.isFinite(t)) return undefined;
  return { op: op as FollowupItemOp, ...base, turnEpoch: t };
}

/** Parse a pagination button `value`. Pages are 1-based integers. */
export function parseFollowupPageActionValue(value: string | undefined): FollowupPageActionValue | null {
  const parsed = parseObject(value);
  if (!parsed) return null;
  const { sessionKey, page } = parsed;
  if (Object.keys(parsed).length !== 2) return null;
  if (typeof sessionKey !== 'string' || !sessionKey) return null;
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) return null;
  return { sessionKey, page };
}

/** Code-point-safe truncation: slicing by UTF-16 unit would split emoji into U+FFFD. */
function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

function plainText(text: string): { type: 'plain_text'; text: string } {
  return { type: 'plain_text', text: truncate(text, MAX_SECTION_TEXT) };
}

function contextBlock(text: string): Record<string, unknown> {
  return { type: 'context', elements: [plainText(text)] };
}

/**
 * One-line, display-only rendering of the stored message. The item itself is
 * never touched — this only decides what fits on screen.
 *
 * `attachmentBadge` is the compact layout's substitute for the per-item context
 * line it no longer renders: a text+files item used to say `N file(s)` there
 * ({@link stateLine}) and without the badge it reads as text-only, hiding the
 * fact that the queued turn carries uploads. The badge is appended AFTER the
 * truncation so a long message cannot cut the count off.
 */
function previewOf(item: FollowupItem, options: { maxChars?: number; attachmentBadge?: boolean } = {}): string {
  const maxChars = options.maxChars ?? PREVIEW_MAX_CHARS;
  const raw = item.message.text ?? '';
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const fileCount = item.message.files?.length ?? 0;
  if (collapsed) {
    const text = truncate(collapsed, maxChars);
    return options.attachmentBadge && fileCount > 0 ? `${text} (📎${fileCount})` : text;
  }
  const names = (item.message.files ?? []).map((file) => file.name).filter(Boolean);
  if (names.length > 0) return truncate(`[files] ${names.join(', ')}`, maxChars);
  return '(empty message)';
}

/**
 * The item's `stateReason`, unless it only repeats the state.
 *
 * `steer` stamps `steered` as both the state and its reason
 * (`followup-queue.ts:587`), so rendering both would append the enum name the
 * label was written to replace — `전달됨 … · steered`.
 */
function stateReasonOf(item: FollowupItem): string | undefined {
  const reason = item.stateReason;
  return reason && reason !== item.state ? reason : undefined;
}

/** `state · reason · N file(s)` — state and reason live outside the message block so text cannot spoof them. */
function stateLine(item: FollowupItem, extra?: string): string {
  const parts: string[] = [followupStateLabel(item.state)];
  const reason = stateReasonOf(item);
  if (reason) parts.push(reason);
  const fileCount = item.message.files?.length ?? 0;
  if (fileCount > 0 && (item.message.text ?? '').trim()) parts.push(`${fileCount} file(s)`);
  if (extra) parts.push(extra);
  return parts.join(' · ');
}

function itemButton(
  item: FollowupItem,
  actionId: string,
  label: string,
  options: { style?: 'primary' | 'danger'; confirm?: Record<string, unknown>; turnEpoch?: number } = {},
): Record<string, unknown> | null {
  const value = encodeFollowupItemActionValue({
    sessionKey: item.sessionKey,
    itemId: item.id,
    epoch: item.epoch,
    turnEpoch: options.turnEpoch,
  });
  // Defensive: a value we cannot encode within Slack's cap must not be silently
  // truncated (it would no longer parse). Drop the control and say so instead.
  if (value.length > MAX_BUTTON_VALUE) return null;
  const button: Record<string, unknown> = {
    type: 'button',
    action_id: actionId,
    text: { type: 'plain_text', text: label },
    value,
  };
  if (options.style) button.style = options.style;
  if (options.confirm) button.confirm = options.confirm;
  return button;
}

/**
 * `uncertain` = the item was in flight when the process died; whether it had
 * side effects is unknown (SSOT §3.5 / R6). A retry is therefore a deliberate,
 * click-through-confirmed act, never an automatic one.
 */
function uncertainRetryConfirm(): Record<string, unknown> {
  return {
    title: { type: 'plain_text', text: 'Retry an uncertain item?' },
    text: {
      type: 'plain_text',
      text: 'This message may have already run before the interruption. Retrying can repeat its side effects.',
    },
    confirm: { type: 'plain_text', text: 'Retry' },
    deny: { type: 'plain_text', text: 'Cancel' },
    style: 'danger',
  };
}

/**
 * The control a given item offers, if any.
 *
 * Takes no freeze flag, and that is the point of the 2026-09-17 scoping fix: a
 * freeze holds back exactly the rows it parked ({@link FREEZE_PARKED_STATES} —
 * `paused`/`uncertain`), and the control each of those needs is the one its own
 * state already names here (Resume out of `paused`, confirm-gated Retry out of
 * `uncertain`, which `retry` now accepts while frozen). The session-level
 * `Resume on everything` branch this replaces put Resume on a `queued` row that
 * had arrived AFTER the freeze and drains normally — the live bug.
 *
 * The legacy layout emits no `Send now` on a parked state at all, so there is
 * nothing here for a parked row to withhold; the compact menu, which does offer
 * it on `paused`, is where the scope still matters ({@link menuOpsFor}).
 */
function accessoryFor(item: FollowupItem, turnEpoch: number): Record<string, unknown> | null {
  switch (item.state) {
    case 'queued':
    // A steered message is still the user's queued message: `Send now` means
    // "stop waiting for the tool-call boundary and run it now", which the
    // dispatcher does by unsteering it first (06 §3.3). The legacy layout has
    // no Cancel button for any state, so this is the one control it can offer.
    case 'steered':
      return itemButton(item, FOLLOWUP_SEND_NOW_ACTION_ID, FOLLOWUP_SEND_NOW_LABEL, { style: 'primary', turnEpoch });
    case 'paused':
      return itemButton(item, FOLLOWUP_RESUME_ACTION_ID, FOLLOWUP_RESUME_LABEL);
    case 'failed':
      return itemButton(item, FOLLOWUP_RETRY_ACTION_ID, FOLLOWUP_RETRY_LABEL);
    case 'uncertain':
      return itemButton(item, FOLLOWUP_RETRY_ACTION_ID, FOLLOWUP_RETRY_LABEL, { confirm: uncertainRetryConfirm() });
    default:
      // reserved / claimed / dispatched / resolved / cancelled: nothing to click.
      // `cancelled` stays visible as history, without a control.
      return null;
  }
}

/**
 * The operations one item offers in compact mode, in menu order.
 *
 * `Cancel` is offered on an in-flight item (`reserved`/`claimed`/`dispatched`)
 * even though `FollowupQueue.cancelItem` refuses it: the queue never aborts a
 * running turn, and an explicit `invalid-state` receipt beats a control that
 * silently is not there. Terminal history (`resolved`/`cancelled`) offers
 * nothing — there is no operation left that could succeed.
 */
function menuOpsFor(
  item: FollowupItem,
  parked: boolean,
  turnEpoch: number,
): Array<{ op: FollowupItemOp; label: string; turnEpoch?: number }> {
  const cancel = { op: 'cancel' as const, label: FOLLOWUP_CANCEL_LABEL };
  const sendNow = { op: 'send_now' as const, label: FOLLOWUP_SEND_NOW_LABEL, turnEpoch };
  const resume = { op: 'resume' as const, label: FOLLOWUP_RESUME_LABEL };
  const retry = { op: 'retry' as const, label: FOLLOWUP_RETRY_LABEL };
  if (item.state === 'resolved' || item.state === 'cancelled') return [];
  // A row the freeze PARKED is the one thing a freeze still scopes here: the
  // queue refuses to reserve or steer it (`followup-queue.ts:477/646`), so
  // `Send now` would be a control that can only answer `frozen`. What is left is
  // the single door out of its own state — Resume for `paused`, Retry for
  // `uncertain`, which `resume` never moves. A `queued`/`steered` row in the
  // same session arrived AFTER the freeze and is untouched by this (A29).
  if (parked) return [item.state === 'paused' ? resume : retry, cancel];
  switch (item.state) {
    case 'queued':
    // Same two operations as `queued`, both taking a different road (06 §3.3/
    // §3.4): `Send now` unsteers the item and interrupts the turn, `Cancel`
    // asks the SDK to drop its copy (`cancel_async_message`) and is refused
    // with "이미 전달됨" when the model already dequeued it. Neither is a
    // no-op, so neither is withheld.
    case 'steered':
      return [sendNow, cancel];
    case 'paused':
      return [resume, sendNow, cancel];
    case 'failed':
    case 'uncertain':
      return [retry, cancel];
    default:
      return [cancel];
  }
}

/**
 * One overflow menu per item, plus whether any offered operation was DROPPED.
 *
 * `menu` is null when the item has no operation left (terminal history) and
 * also when every offered one was dropped; `dropped` is what tells the two
 * apart, so the caller can say "action unavailable" instead of rendering a line
 * that silently lost its control.
 */
function itemMenu(
  item: FollowupItem,
  parked: boolean,
  turnEpoch: number,
): { menu: Record<string, unknown> | null; dropped: boolean } {
  const encoded = menuOpsFor(item, parked, turnEpoch).map((entry) => ({
    text: { type: 'plain_text', text: truncate(entry.label, MAX_OPTION_TEXT) },
    value: encodeFollowupMenuValue(
      { sessionKey: item.sessionKey, seq: item.seq, epoch: item.epoch, turnEpoch: entry.turnEpoch },
      entry.op,
    ),
  }));
  // Defensive: an option value past Slack's cap cannot be truncated (it would
  // stop parsing), so the option is dropped rather than shipped unusable.
  const options = encoded.filter((option) => option.value.length <= MAX_OPTION_VALUE).slice(0, MAX_MENU_OPTIONS);
  const dropped = options.length < Math.min(encoded.length, MAX_MENU_OPTIONS);
  if (options.length === 0) return { menu: null, dropped };
  // Deliberately NO element-level `confirm`, not even for `uncertain`: Slack
  // attaches an overflow's confirm to EVERY option, so the R6 dialog meant for
  // Retry would also gate Cancel — the one operation an uncertain item can
  // always take safely. The caution rides in the item line instead
  // ({@link compactStateLabel}); the confirm-gated Retry survives in the legacy
  // layout, where it hangs off the Retry button alone.
  return { menu: { type: 'overflow', action_id: FOLLOWUP_ITEM_MENU_ACTION_ID, options }, dropped };
}

/**
 * `queued · interrupt 권한 거부` — the state first, its reason clamped to one line.
 *
 * `uncertain` additionally carries the R6 caution inline, because the compact
 * layout has nowhere else to put it (see {@link itemMenu}).
 */
function compactStateLabel(item: FollowupItem): string {
  const label = followupStateLabel(item.state);
  const state = item.state === 'uncertain' ? `${label} — ${COMPACT_UNCERTAIN_CAUTION}` : label;
  const reason = stateReasonOf(item)?.replace(/\s+/g, ' ').trim();
  return reason ? `${state} · ${truncate(reason, COMPACT_REASON_MAX_CHARS)}` : state;
}

/**
 * Replace the mrkdwn emphasis characters of a compact preview with the
 * look-alikes above. Applied AFTER truncation and escaping, both of which it
 * leaves intact: it is a 1:1 code-point map that neither produces nor consumes
 * `&`/`<`/`>`, so the entity encoding stays exactly as `escapeSlackMrkdwn` left
 * it and the truncation budget is unaffected.
 */
function neutraliseCompactEmphasis(text: string): string {
  return text.replace(/[*_~]/g, (char) => COMPACT_EMPHASIS_LOOKALIKES[char] ?? char);
}

/**
 * `3. 진행중인거 알려줘? · _queued_` — the whole item on one row.
 *
 * Both untrusted parts (message, state reason) are escaped before they touch
 * the mrkdwn string; `verbatim` then stops Slack from auto-linking whatever
 * survived. The state label sits OUTSIDE the escaped message, and the preview's
 * own emphasis characters are neutralised, so the italic run that the eye reads
 * as the state is always the real one, always last on the row.
 */
function compactItemBlock(item: FollowupItem, parked: boolean, turnEpoch: number): Record<string, unknown> {
  const { menu, dropped } = itemMenu(item, parked, turnEpoch);
  const block: Record<string, unknown> = {
    type: 'section',
    text: { type: 'mrkdwn', text: compactItemLine(item, item.seq, dropped), verbatim: true },
  };
  if (menu) block.accessory = menu;
  return block;
}

/**
 * The compact row's text, shared by the panel layout and the in-thread item
 * message (A39) so the same item reads the same way wherever it is rendered.
 *
 * `dropped` says a control could not be encoded and is GONE from the row — a row
 * that silently lost its only control is indistinguishable from an item that
 * never had one, so it says so in the same words the legacy layout uses.
 */
function compactItemLine(item: FollowupItem, index: number, dropped: boolean): string {
  const preview = compactPreview(item);
  const label = escapeSlackMrkdwn(compactStateLabel(item));
  const line = `${index}. ${preview} · _${label}_${dropped ? ` · _${ACTION_UNAVAILABLE}_` : ''}`;
  return truncate(line, MAX_SECTION_TEXT);
}

/** The message as it appears on a compact row: escaped, emphasis-neutralised, ≤80 chars. */
function compactPreview(item: FollowupItem): string {
  return neutraliseCompactEmphasis(
    escapeSlackMrkdwn(previewOf(item, { maxChars: COMPACT_PREVIEW_MAX_CHARS, attachmentBadge: true })),
  );
}

function clampPageSize(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return FOLLOWUP_QUEUE_DEFAULT_PAGE_SIZE;
  const size = Math.floor(requested);
  if (size < 1) return 1;
  return Math.min(size, FOLLOWUP_QUEUE_MAX_PAGE_SIZE);
}

function clampPage(requested: number | undefined, pageCount: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return 1;
  const page = Math.floor(requested);
  if (page < 1) return 1;
  return Math.min(page, pageCount);
}

/** `queued 90 · 전달 1 · paused 10` in the shared display order. */
function stateBreakdown(items: readonly FollowupItem[]): string {
  const counts = new Map<FollowupItemState, number>();
  for (const item of items) counts.set(item.state, (counts.get(item.state) ?? 0) + 1);
  return FOLLOWUP_STATE_DISPLAY_ORDER.filter((state) => counts.has(state))
    .map((state) => `${followupStateCountLabel(state)} ${counts.get(state)}`)
    .join(' · ');
}

/**
 * Render the follow-up queue for one session.
 *
 * The input is treated as read-only; nothing in `view` is mutated. Items render
 * in `seq` order (FIFO), including terminal ones, so cancelled history stays
 * visible. Every item is reachable: the summary line states the full count and
 * page position, and navigation walks all pages — a long backlog is paged, never
 * silently dropped.
 */
export function buildFollowupQueueBlocks(
  view: FollowupQueueView,
  options: FollowupQueueBlocksOptions = {},
): FollowupQueueBlocksResult {
  const items = [...view.items].sort((a, b) => a.seq - b.seq);
  const total = items.length;
  const pageSize = clampPageSize(options.pageSize);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = clampPage(options.page, pageCount);
  const start = (page - 1) * pageSize;
  const visible = items.slice(start, start + pageSize);
  const frozen = view.freeze !== undefined;
  const turnEpoch = view.turnEpoch ?? 0;

  const compact = options.compact ?? true;
  const blocks: unknown[] = [];

  if (compact) {
    // One header line: total + page position only. The per-state breakdown and
    // the `showing a–b` range were three more rows for information the page
    // itself already shows, so they are gone (2026-09-17 panel-height report).
    const header = [FOLLOWUP_QUEUE_TITLE, `${total} item(s)`];
    if (pageCount > 1) header.push(`page ${page}/${pageCount}`);
    blocks.push(contextBlock(header.join(' · ')));
  } else {
    const summaryParts = [`${total} item(s)`, `page ${page}/${pageCount}`];
    if (total > 0) summaryParts.push(`showing ${start + 1}–${start + visible.length}`, stateBreakdown(items));
    blocks.push({ type: 'section', text: plainText(FOLLOWUP_QUEUE_TITLE) }, contextBlock(summaryParts.join(' · ')));
  }

  if (view.freeze) {
    blocks.push(contextBlock(followupFreezeBannerText(view.freeze.reason)));
  }

  for (const item of visible) {
    // Per ITEM, never per session: a freeze holds back the rows it parked, and
    // a `queued` row in a frozen session is a message that arrived after it
    // (`followup-queue.ts:221`).
    const parked = frozen && FREEZE_PARKED_STATES.includes(item.state);
    if (compact) {
      blocks.push(compactItemBlock(item, parked, turnEpoch));
      continue;
    }
    const accessory = accessoryFor(item, turnEpoch);
    const section: Record<string, unknown> = {
      type: 'section',
      text: plainText(`${item.seq}. ${previewOf(item)}`),
    };
    if (accessory) section.accessory = accessory;
    blocks.push(section);
    const dropped = accessory === null && isActionable(item);
    blocks.push(contextBlock(stateLine(item, dropped ? ACTION_UNAVAILABLE : undefined)));
  }

  const nav: Array<Record<string, unknown>> = [];
  if (page > 1) {
    nav.push({
      type: 'button',
      action_id: FOLLOWUP_PAGE_PREV_ACTION_ID,
      text: { type: 'plain_text', text: 'Prev' },
      value: encodeFollowupPageActionValue({ sessionKey: view.sessionKey, page: page - 1 }),
    });
  }
  if (page < pageCount) {
    nav.push({
      type: 'button',
      action_id: FOLLOWUP_PAGE_NEXT_ACTION_ID,
      text: { type: 'plain_text', text: 'Next' },
      value: encodeFollowupPageActionValue({ sessionKey: view.sessionKey, page: page + 1 }),
    });
  }
  if (nav.length > 0) blocks.push({ type: 'actions', elements: nav });

  return {
    blocks,
    text: `${FOLLOWUP_QUEUE_TITLE} — ${total} item(s) · page ${page}/${pageCount}`,
  };
}

/**
 * True when the item's state would normally carry a control (used to explain a
 * dropped one). The session's freeze is not an input: {@link accessoryFor} picks
 * the control from the state alone, so the states that carry one are the same
 * whether or not the session is frozen.
 */
function isActionable(item: FollowupItem): boolean {
  return (FOLLOWUP_PENDING_STATES as readonly FollowupItemState[]).includes(item.state);
}

/** One item, as its own Slack message. */
export interface FollowupItemMessage {
  /** Slack's fallback/notification text. Escaped — see {@link buildFollowupItemMessage}. */
  text: string;
  blocks: unknown[];
}

/** What a caller may say about ONE item message beyond the item itself. */
export interface FollowupItemMessageOptions {
  /**
   * The number on the line. Defaults to the item's `seq` (its FIFO position);
   * the `queue` command passes a 1-based list position instead.
   */
  index?: number;
  /**
   * The SESSION's freeze, if there is one — the same value the panel view
   * carries. Only a row the freeze actually PARKED
   * ({@link FREEZE_PARKED_STATES}) renders its notice; a message that arrived
   * after the freeze drains normally and says nothing about it (A29).
   */
  freeze?: { reason: string; at: number };
  /**
   * Render the buttons? Default `true`. The `queue` command passes `false`
   * since 09: the controls live as reactions on the user's own message, so a
   * LISTING that carried its own `Send now` would be a second copy of a control
   * the item already has — and one nothing takes down when the item settles.
   *
   * It suppresses the `action unavailable` suffix along with the buttons, and
   * that is why this is an option here rather than a `blocks.filter` at the
   * call site: "a control was DROPPED" is only true of a row that was trying to
   * render one.
   */
  controls?: boolean;
}

/**
 * The controls ONE item message offers, and whether any of them was dropped.
 *
 * State-driven, mirroring {@link accessoryFor}: the primary control is the one
 * door out of the item's own state (`Send now` for `queued`/`steered`, `Resume`
 * for `paused`, confirm-gated `Retry` for `uncertain`, plain `Retry` for
 * `failed`), and `Cancel` rides along because dropping the user's message is
 * legal from all of them. Rendering `Send now` on a `paused` row — what this
 * message did before — was a control whose only possible answer is `frozen`,
 * and on a `failed` row one the dispatcher refuses outright.
 *
 * Terminal history offers nothing: there is no operation left that could
 * succeed, and A41 deletes the message anyway.
 *
 * `dropped` is the difference between "this state carries no control" and "a
 * control could not be encoded and is GONE from the row" — the second is said
 * out loud, the first is not.
 */
function itemMessageControls(
  item: FollowupItem,
  turnEpoch: number,
): { elements: Array<Record<string, unknown>>; dropped: boolean } {
  if (item.state === 'resolved' || item.state === 'cancelled') return { elements: [], dropped: false };
  const primary = accessoryFor(item, turnEpoch);
  // No `turnEpoch`: a cancel acts on an item, not on the running turn, and a
  // generation fence it does not need would only expire a working control.
  const cancel = itemButton(item, FOLLOWUP_CANCEL_ACTION_ID, FOLLOWUP_CANCEL_LABEL);
  const elements = [primary, cancel].filter((button): button is Record<string, unknown> => button !== null);
  // What this state OFFERS: its own control (only actionable states have one)
  // plus the cancel every non-terminal row gets.
  const offered = (isActionable(item) ? 1 : 0) + 1;
  return { elements, dropped: elements.length < offered };
}

/**
 * ONE queue item as ONE thread message (A39) — the surface that replaced the
 * panel's Queue section.
 *
 * The user asked to read the queue where they typed, with the controls in reach
 * ("thread안에 유저가 메세지 쳤을때마다 출력해줘 즉시 send now / cancel 할수
 * 있도록"), so the host posts this right under the message it parked. Two blocks
 * in the ordinary case: the compact line the panel already used
 * ({@link compactItemLine} — same wording in both places by construction) and an
 * actions row carrying the item's controls as BUTTONS. The overflow menu is not
 * reused here: a one-item message has room for the real labels, and an overflow
 * gives no visual feedback at all.
 *
 * The controls are picked from the item's STATE ({@link itemMessageControls}),
 * not fixed at `Send now`+`Cancel`: this message is re-rendered as the item
 * moves ({@link FollowupItemMessageOptions}), and a `paused`/`failed`/`uncertain`
 * row whose only button is `Send now` is a dead end — the panel that used to
 * carry Resume/Retry no longer renders the queue at all.
 *
 * What it keeps from the panel layout, because this payload now reaches Slack on
 * its own:
 *   - the message text is escaped BEFORE it touches mrkdwn and its emphasis
 *     characters are neutralised, so the last italic run on the line is always
 *     the real state ({@link compactPreview});
 *   - the button `value`s carry queue coordinates only (A30), with `turnEpoch`
 *     on `Send now` alone (A12/A28: it targets the LIVE turn, the others do not);
 *   - a control whose value would not fit Slack's cap is DROPPED and said so,
 *     never truncated into something that no longer parses;
 *   - the freeze notice, for a row the freeze PARKED — the panel's freeze line
 *     was the only place it was ever said, and the panel is gone.
 *
 * The fallback `text` deliberately differs from the queue panel's counts-only
 * one: this message IS one user message, so hiding its text would leave the
 * notification meaningless. Slack parses that string as mrkdwn, so it is escaped
 * exactly like the block line — a `<!channel>` in a queued message cannot become
 * a broadcast ping through either path.
 */
export function buildFollowupItemMessage(
  item: FollowupItem,
  turnEpoch: number,
  options: FollowupItemMessageOptions = {},
): FollowupItemMessage {
  const seq = options.index ?? item.seq;
  const { elements, dropped } =
    options.controls === false ? { elements: [], dropped: false } : itemMessageControls(item, turnEpoch);
  // Per ITEM, never per session (A29): a freeze holds back exactly the rows it
  // parked, and a `queued` row in a frozen session arrived after it and drains
  // normally. Printing the notice on that row is the 2026-09-17 live misreading.
  const notice =
    options.freeze && FREEZE_PARKED_STATES.includes(item.state)
      ? followupFreezeBannerText(options.freeze.reason)
      : undefined;

  const blocks: unknown[] = [];
  // Ahead of the line it is about: the notice explains why this row is not
  // running by itself, which is the first thing to read.
  if (notice) blocks.push(contextBlock(notice));
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: compactItemLine(item, seq, dropped), verbatim: true },
  });
  if (elements.length > 0) blocks.push({ type: 'actions', elements });

  const line = `${FOLLOWUP_QUEUE_TITLE} ${seq}. ${compactPreview(item)} · ${escapeSlackMrkdwn(compactStateLabel(item))}`;
  return { text: notice ? `${notice}\n${line}` : line, blocks };
}
