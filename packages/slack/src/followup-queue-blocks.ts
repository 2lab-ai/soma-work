import type { FollowupItem, FollowupItemState } from './followup-queue';

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
 *     already produced side effects, so its Retry carries a confirm dialog.
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
 * Security: every rendered text object is `plain_text`. The queued message is
 * untrusted user input; rendering it as `mrkdwn` would let it inject
 * `<!channel>`/`<@U…>` mentions or fake links. The fallback `text` (which Slack
 * DOES parse) therefore carries counts only, never message content. Button
 * `value`s carry queue coordinates only — `{sessionKey,itemId,epoch}` plus
 * `turnEpoch` on `Send now` — and nothing else: no author, no token, no working
 * directory, no message text (A30).
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

/** Stable action ids for host wiring. Versioned; no existing prefix collides. */
export const FOLLOWUP_SEND_NOW_ACTION_ID = 'followup_send_now_v1';
export const FOLLOWUP_RESUME_ACTION_ID = 'followup_resume_v1';
export const FOLLOWUP_RETRY_ACTION_ID = 'followup_retry_v1';
export const FOLLOWUP_PAGE_PREV_ACTION_ID = 'followup_page_prev_v1';
export const FOLLOWUP_PAGE_NEXT_ACTION_ID = 'followup_page_next_v1';

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

const MAX_BUTTON_VALUE = 2000;
const MAX_SECTION_TEXT = 3000;
/** Display-only clamp. The stored item is never modified — counts stay authoritative. */
const PREVIEW_MAX_CHARS = 280;

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

/** States an explicit resume can act on while the session is frozen. */
const RESUMABLE_STATES: readonly FollowupItemState[] = ['queued', 'paused', 'failed', 'uncertain'];

export function encodeFollowupItemActionValue(value: FollowupItemActionValue): string {
  const payload: FollowupItemActionValue = {
    sessionKey: value.sessionKey,
    itemId: value.itemId,
    epoch: value.epoch,
  };
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

  const summaryParts = [`${total} item(s)`, `page ${page}/${pageCount}`];
  if (total > 0) summaryParts.push(`showing ${start + 1}–${start + visible.length}`, stateBreakdown(items));

  const blocks: unknown[] = [
    { type: 'section', text: plainText(FOLLOWUP_QUEUE_TITLE) },
    contextBlock(summaryParts.join(' · ')),
  ];

  if (view.freeze) {
    blocks.push(contextBlock(`frozen · ${view.freeze.reason} · explicit Resume required`));
  }

  for (const item of visible) {
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
