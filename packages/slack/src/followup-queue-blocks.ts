import type { FollowupItem, FollowupItemState } from './followup-queue';
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
 *     a freeze is `paused` and clears only through an explicit Resume. The two
 *     are never collapsed into one label (A29).
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
 * Slack's auto-linkification. Emphasis characters (`*_~`) survive and can only
 * garble the item's own line — they cannot address anybody. The fallback `text`
 * (which Slack DOES parse) carries counts only, never message content. Button and
 * menu-option `value`s carry queue coordinates only — `{sessionKey,itemId,epoch}`
 * plus `turnEpoch` on `Send now` and `op` on a menu option — and nothing else: no
 * author, no token, no working directory, no message text (A30).
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

/** Stable action ids for host wiring. Versioned; no existing prefix collides. */
export const FOLLOWUP_SEND_NOW_ACTION_ID = 'followup_send_now_v1';
export const FOLLOWUP_RESUME_ACTION_ID = 'followup_resume_v1';
export const FOLLOWUP_RETRY_ACTION_ID = 'followup_retry_v1';
export const FOLLOWUP_PAGE_PREV_ACTION_ID = 'followup_page_prev_v1';
export const FOLLOWUP_PAGE_NEXT_ACTION_ID = 'followup_page_next_v1';
/**
 * The compact layout's single per-item control. One `action_id` for every
 * operation: the clicked option's `value` says WHICH one (`op`), so the host
 * registers one handler instead of four. The per-op button ids above stay
 * exported and stay live in the legacy layout.
 */
export const FOLLOWUP_ITEM_MENU_ACTION_ID = 'followup_item_menu_v1';

/** All item-scoped action ids, for a host that registers them in one pass. */
export const FOLLOWUP_ITEM_ACTION_IDS = [
  FOLLOWUP_SEND_NOW_ACTION_ID,
  FOLLOWUP_RESUME_ACTION_ID,
  FOLLOWUP_RETRY_ACTION_ID,
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
 * The item payload is roughly 100 chars, so the cap is real headroom, not slack.
 */
const MAX_OPTION_VALUE = 150;
const MAX_OPTION_TEXT = 75;
const MAX_MENU_OPTIONS = 5;
/** Display-only clamp. The stored item is never modified — counts stay authoritative. */
const PREVIEW_MAX_CHARS = 280;
/** Compact is one line per item: the preview has to stay inside one rendered row. */
const COMPACT_PREVIEW_MAX_CHARS = 80;
const COMPACT_REASON_MAX_CHARS = 40;
/** R6 in one phrase — an uncertain item may already have run, so re-running is a decision. */
const COMPACT_UNCERTAIN_CAUTION = '재실행 전 확인';

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

/** States an explicit resume can act on while the session is frozen. */
const RESUMABLE_STATES: readonly FollowupItemState[] = ['queued', 'paused', 'failed', 'uncertain'];

/**
 * Sole encoder of an item-scoped payload — buttons AND menu options go through
 * it, so there is exactly one place that decides which fields reach the wire
 * (A30). `op` is present only for the compact menu, where the action id no
 * longer identifies the operation.
 */
export function encodeFollowupItemActionValue(value: FollowupItemActionValue, op?: FollowupItemOp): string {
  const payload: Record<string, unknown> = {};
  if (op !== undefined) payload.op = op;
  payload.sessionKey = value.sessionKey;
  payload.itemId = value.itemId;
  payload.epoch = value.epoch;
  if (value.turnEpoch !== undefined) payload.turnEpoch = value.turnEpoch;
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
 * Parse a compact menu option `value`. Returns `undefined` on anything
 * unexpected — an unknown `op`, a missing coordinate, an extra field. The
 * coordinates are validated by `parseFollowupItemActionValue` itself rather
 * than by a second, slightly different copy of the same checks.
 */
export function parseFollowupMenuValue(value: string | undefined): FollowupItemMenuValue | undefined {
  const parsed = parseObject(value);
  if (!parsed) return undefined;
  const { op, ...coordinates } = parsed;
  if (typeof op !== 'string' || !FOLLOWUP_ITEM_OPS.includes(op as FollowupItemOp)) return undefined;
  const base = parseFollowupItemActionValue(JSON.stringify(coordinates));
  if (!base) return undefined;
  return { op: op as FollowupItemOp, ...base };
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
 */
function previewOf(item: FollowupItem): string {
  const raw = item.message.text ?? '';
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed) return truncate(collapsed, PREVIEW_MAX_CHARS);
  const names = (item.message.files ?? []).map((file) => file.name).filter(Boolean);
  if (names.length > 0) return truncate(`[files] ${names.join(', ')}`, PREVIEW_MAX_CHARS);
  return '(empty message)';
}

/** `state · reason · N file(s)` — state and reason live outside the message block so text cannot spoof them. */
function stateLine(item: FollowupItem, extra?: string): string {
  const parts: string[] = [item.state];
  if (item.stateReason) parts.push(item.stateReason);
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

/** The control a given item offers, if any. Frozen sessions only offer Resume. */
function accessoryFor(item: FollowupItem, frozen: boolean, turnEpoch: number): Record<string, unknown> | null {
  if (frozen) {
    if (!RESUMABLE_STATES.includes(item.state)) return null;
    return itemButton(item, FOLLOWUP_RESUME_ACTION_ID, FOLLOWUP_RESUME_LABEL);
  }
  switch (item.state) {
    case 'queued':
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
  frozen: boolean,
  turnEpoch: number,
): Array<{ op: FollowupItemOp; label: string; turnEpoch?: number }> {
  const cancel = { op: 'cancel' as const, label: FOLLOWUP_CANCEL_LABEL };
  const sendNow = { op: 'send_now' as const, label: FOLLOWUP_SEND_NOW_LABEL, turnEpoch };
  const resume = { op: 'resume' as const, label: FOLLOWUP_RESUME_LABEL };
  const retry = { op: 'retry' as const, label: FOLLOWUP_RETRY_LABEL };
  if (item.state === 'resolved' || item.state === 'cancelled') return [];
  // A frozen session drains nothing, so `Send now` is withheld exactly as in the
  // legacy layout (A29); the freeze is cleared by Resume, not by a dispatch.
  if (frozen) return RESUMABLE_STATES.includes(item.state) ? [resume, cancel] : [cancel];
  switch (item.state) {
    case 'queued':
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

/** One overflow menu per item, or null when the item has no operation left. */
function itemMenu(item: FollowupItem, frozen: boolean, turnEpoch: number): Record<string, unknown> | null {
  const options = menuOpsFor(item, frozen, turnEpoch)
    .map((entry) => ({
      text: { type: 'plain_text', text: truncate(entry.label, MAX_OPTION_TEXT) },
      value: encodeFollowupItemActionValue(
        { sessionKey: item.sessionKey, itemId: item.id, epoch: item.epoch, turnEpoch: entry.turnEpoch },
        entry.op,
      ),
    }))
    // Defensive: an option value past Slack's cap cannot be truncated (it would
    // stop parsing), so the option is dropped rather than shipped unusable.
    .filter((option) => option.value.length <= MAX_OPTION_VALUE)
    .slice(0, MAX_MENU_OPTIONS);
  if (options.length === 0) return null;
  // Deliberately NO element-level `confirm`, not even for `uncertain`: Slack
  // attaches an overflow's confirm to EVERY option, so the R6 dialog meant for
  // Retry would also gate Cancel — the one operation an uncertain item can
  // always take safely. The caution rides in the item line instead
  // ({@link compactStateLabel}); the confirm-gated Retry survives in the legacy
  // layout, where it hangs off the Retry button alone.
  return { type: 'overflow', action_id: FOLLOWUP_ITEM_MENU_ACTION_ID, options };
}

/**
 * `queued · interrupt 권한 거부` — the state first, its reason clamped to one line.
 *
 * `uncertain` additionally carries the R6 caution inline, because the compact
 * layout has nowhere else to put it (see {@link itemMenu}).
 */
function compactStateLabel(item: FollowupItem): string {
  const state = item.state === 'uncertain' ? `${item.state} — ${COMPACT_UNCERTAIN_CAUTION}` : item.state;
  const reason = item.stateReason?.replace(/\s+/g, ' ').trim();
  return reason ? `${state} · ${truncate(reason, COMPACT_REASON_MAX_CHARS)}` : state;
}

/**
 * `3. 진행중인거 알려줘? · _queued_` — the whole item on one row.
 *
 * Both untrusted parts (message, state reason) are escaped before they touch
 * the mrkdwn string; `verbatim` then stops Slack from auto-linking whatever
 * survived. The state label sits OUTSIDE the escaped message, so a message
 * cannot spoof a state it is not in.
 */
function compactItemBlock(item: FollowupItem, frozen: boolean, turnEpoch: number): Record<string, unknown> {
  const preview = escapeSlackMrkdwn(truncate(previewOf(item), COMPACT_PREVIEW_MAX_CHARS));
  const label = escapeSlackMrkdwn(compactStateLabel(item));
  const block: Record<string, unknown> = {
    type: 'section',
    text: { type: 'mrkdwn', text: truncate(`${item.seq}. ${preview} · _${label}_`, MAX_SECTION_TEXT), verbatim: true },
  };
  const menu = itemMenu(item, frozen, turnEpoch);
  if (menu) block.accessory = menu;
  return block;
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

/** `queued 90 · paused 10` in a stable, state-enum order. */
function stateBreakdown(items: readonly FollowupItem[]): string {
  const order: readonly FollowupItemState[] = [
    'queued',
    'reserved',
    'claimed',
    'dispatched',
    'paused',
    'uncertain',
    'failed',
    'resolved',
    'cancelled',
  ];
  const counts = new Map<FollowupItemState, number>();
  for (const item of items) counts.set(item.state, (counts.get(item.state) ?? 0) + 1);
  return order
    .filter((state) => counts.has(state))
    .map((state) => `${state} ${counts.get(state)}`)
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
    blocks.push(contextBlock(`frozen · ${view.freeze.reason} · explicit Resume required`));
  }

  for (const item of visible) {
    if (compact) {
      blocks.push(compactItemBlock(item, frozen, turnEpoch));
      continue;
    }
    const accessory = accessoryFor(item, frozen, turnEpoch);
    const section: Record<string, unknown> = {
      type: 'section',
      text: plainText(`${item.seq}. ${previewOf(item)}`),
    };
    if (accessory) section.accessory = accessory;
    blocks.push(section);
    const dropped = accessory === null && isActionable(item, frozen);
    blocks.push(contextBlock(stateLine(item, dropped ? 'action unavailable' : undefined)));
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

/** True when the item's state would normally carry a control (used to explain a dropped one). */
function isActionable(item: FollowupItem, frozen: boolean): boolean {
  if (frozen) return RESUMABLE_STATES.includes(item.state);
  return item.state === 'queued' || item.state === 'paused' || item.state === 'failed' || item.state === 'uncertain';
}
