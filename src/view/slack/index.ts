/**
 * Slack View Module — Slack platform ViewAdapter (Issue #409)
 */

export { SlackInputAdapter } from './slack-input-adapter.js';
// Slack-specific refs (only for Slack adapter code, not controllers)
export {
  extractSlackMessageRef,
  extractSlackRef,
  type SlackConversationRef,
  type SlackMessageRef,
  slackMessageHandle,
  slackTarget,
} from './slack-refs.js';
export { type SlackApiForResponse, type SlackResponseDeps, SlackResponseSession } from './slack-response-session.js';
// Adapter
export { type SlackApiForView, SlackViewAdapter } from './slack-view-adapter.js';
