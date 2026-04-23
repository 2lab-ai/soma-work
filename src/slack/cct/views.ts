/**
 * CCT Slack UI constants — STABLE IDs for the card + modals.
 *
 * ⚠️ Stability contract:
 *   - `block_id`s and `action_id`s in `CCT_BLOCK_IDS` / `CCT_ACTION_IDS`
 *     MUST remain stable across `views.update` calls. Slack preserves
 *     typed `state.values` entries keyed by (block_id, action_id). If we
 *     regenerate these on every update, the user's typed text is lost
 *     when the kind radio flips between `setup_token` and
 *     `oauth_credentials`. Keep the set below append-only.
 *   - Card block_ids are issued-at-stamped (via `zBlockId`) and are
 *     allowed to change — cards are re-posted, not updated in-place.
 *   - View `callback_id`s are fixed so the `view_submission` router can
 *     dispatch without extra lookup.
 */

export const CCT_VIEW_IDS = {
  add: 'cct_add_slot',
  remove: 'cct_remove_slot',
  // Z2 — Attach OAuth credentials modal. Opened from the per-slot "Attach"
  // button emitted by `buildSlotRow` for setup-source cct slots.
  attach: 'cct_attach_oauth',
} as const;

/**
 * Input block_ids for the Add Slot modal. STABLE across `views.update`.
 * Changing these values mid-flight loses the user's in-progress input.
 */
export const CCT_BLOCK_IDS = {
  add_name: 'cct_add_name',
  add_kind: 'cct_add_kind',
  add_setup_token_value: 'cct_add_value',
  add_oauth_credentials_blob: 'cct_add_oauth_blob',
  add_tos_ack: 'cct_add_tos_ack',
  // Z3 — api_key arm of the Add Slot modal (radio option switches which
  // block renders).
  add_api_key_value: 'cct_add_api_key_value',
  remove_confirm: 'cct_remove_confirm',
  // Z2 — Attach OAuth modal inputs.
  attach_oauth_blob: 'cct_attach_oauth_blob',
  attach_tos_ack: 'cct_attach_tos_ack',
} as const;

/**
 * Stable block_id prefix for per-slot card blocks emitted by
 * `buildSlotRow`. The overflow guard (`trimBlocksToSlackCap`) matches
 * these by prefix so fragile text-content heuristics are avoided.
 */
export const CCT_CARD_BLOCK_ID_PREFIX = {
  /** Per-slot usage-context block (stripped first under overflow). */
  usagePanel: 'cct_usage_panel:',
  /** Card-level "Soonest expiring 7d budget" footer (#668 follow-up). */
  budgetFooter: 'cct_budget_footer',
} as const;

/** Action_ids stable across `views.update`. Preserves typed values. */
export const CCT_ACTION_IDS = {
  next: 'cct_next',
  add: 'cct_open_add',
  remove: 'cct_open_remove',
  tos_ack: 'cct_tos_ack',
  kind_radio: 'cct_kind_radio',
  // Inner element action_ids for input blocks. Must also stay stable.
  name_input: 'cct_name_value',
  setup_token_input: 'cct_setup_token_value',
  oauth_blob_input: 'cct_oauth_blob_value',
  // Z3 — api_key input (sk-ant-api03-<chars>).
  api_key_input: 'cct_api_key_value',
  remove_private_metadata: 'cct_remove_slot_id',
  // Z2 — Attach/Detach row buttons + modal inputs.
  attach: 'cct_open_attach',
  detach: 'cct_detach',
  attach_oauth_input: 'cct_attach_oauth_blob_value',
  attach_tos_ack: 'cct_attach_tos_ack_value',
  // #641 M1-S4 — Refresh buttons (card-level fan-out). Append-only;
  // existing IDs above are unchanged.
  refresh_usage_all: 'cct_refresh_usage_all',
  // Card v2 follow-up — pure usage re-fetch fan-out (sibling of
  // `refresh_usage_all` which refreshes OAuth tokens).
  refresh_card: 'cct_refresh_card',
  // per-slot Activate button. Non-active rows emit this button; the
  // active row omits it.
  activate_slot: 'cct_activate_slot',
} as const;

export type CctViewId = (typeof CCT_VIEW_IDS)[keyof typeof CCT_VIEW_IDS];
export type CctBlockId = (typeof CCT_BLOCK_IDS)[keyof typeof CCT_BLOCK_IDS];
export type CctActionId = (typeof CCT_ACTION_IDS)[keyof typeof CCT_ACTION_IDS];

/** Inline help shown under the oauth_credentials JSON input. */
export const OAUTH_BLOB_HELP =
  'Paste the `claudeAiOauth` nested object only, not the whole file. (Slack caps `plain_text_input` at 3000 chars.)';

/** Max chars for Slack plain_text_input. */
export const SLACK_PLAIN_TEXT_INPUT_MAX = 3000;
/** Threshold above which the inline "paste only claudeAiOauth" hint switches on. */
export const OAUTH_BLOB_WARN_THRESHOLD = 2800;
