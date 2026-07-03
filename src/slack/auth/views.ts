/**
 * Auth card action / block / view ids (#llmux runtime switch).
 *
 * ⚠️ STABILITY: ids MUST NOT change across `views.update` calls — Slack
 * preserves typed `state.values` only when keys are stable (same contract
 * as `src/slack/cct/views.ts`).
 */

export const AUTH_ACTION_IDS = {
  /** Mode-switch button. Value: 'llmux' | 'ccp'. */
  mode: 'auth_mode_switch',
  /** llmux manual account switch. Value: account name. */
  switch: 'auth_llmux_switch_account',
  /** Open the Add-account modal (llmux api-key account). */
  add: 'auth_llmux_open_add',
  /** Open the Remove-account confirm modal. Value: account name. */
  remove: 'auth_llmux_open_remove',
  /** Open the llmux Settings modal (base URL / API key). */
  settings: 'auth_llmux_open_settings',
  /** Re-render the card with a fresh /llmux/status fetch. */
  refresh: 'auth_refresh',
  /** Dismiss the card (shared ZSettings chrome semantics). */
  cancel: 'z_setting_auth_cancel',
} as const;

export const AUTH_VIEW_IDS = {
  add: 'auth_llmux_add_account',
  remove: 'auth_llmux_remove_account',
  settings: 'auth_llmux_settings',
} as const;

export const AUTH_BLOCK_IDS = {
  add_name: 'auth_add_name',
  add_api_key: 'auth_add_api_key',
  settings_base_url: 'auth_settings_base_url',
  settings_api_key: 'auth_settings_api_key',
} as const;
