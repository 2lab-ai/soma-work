/**
 * Block Kit builders for the user-instruction y/n confirmation flow.
 *
 * Critical constraints (docs/slack-block-kit.md):
 *   - `button.disabled` is NOT supported by Slack — attempting to render
 *     `{ disabled: true }` triggers `invalid_blocks`. Instead we model the
 *     "resolved" state by rebuilding the message WITHOUT the actions block.
 *   - On `chat.update`, reuse of `block_id` is forbidden; we therefore
 *     generate ALL block_ids from scratch here (leaving `block_id` unset
 *     lets Slack assign fresh ids).
 *   - `chat.update` cannot modify ephemeral messages — all confirm posts
 *     must be non-ephemeral `chat.postMessage`.
 */

import type { SessionInstructionOperation, SessionResourceUpdateRequest } from '../types';

/** Action IDs — prefix-matched by ActionRouter (`src/slack/actions/index.ts`). */
export const INSTRUCTION_CONFIRM_YES_ACTION = 'instr_confirm_y';
export const INSTRUCTION_CONFIRM_NO_ACTION = 'instr_confirm_n';

const ACTION_LABELS: Record<SessionInstructionOperation['action'], string> = {
  add: 'Add instruction',
  remove: 'Remove instruction',
  clear: 'Clear all instructions',
  complete: 'Mark instruction completed',
  setStatus: 'Change instruction status',
  // Sealed 5-op lifecycle vocabulary (#755) — link/cancel/rename complete the
  // model→host op alphabet for user-confirmable instruction state changes.
  link: 'Link instruction to this session',
  cancel: 'Cancel instruction',
  rename: 'Rename instruction',
};

function summariseOp(op: SessionInstructionOperation): string {
  const label = ACTION_LABELS[op.action] ?? op.action;
  switch (op.action) {
    case 'add':
      return `*${label}*: “${truncate(op.text, 200)}”`;
    case 'remove':
      return `*${label}*: \`${op.id}\``;
    case 'clear':
      return `*${label}*`;
    case 'complete':
      return `*${label}*: \`${op.id}\` — evidence: “${truncate(op.evidence, 200)}”`;
    case 'setStatus':
      return `*${label}*: \`${op.id}\` → \`${op.status}\``;
    case 'link':
      return `*${label}*: \`${op.id}\` ↔ \`${op.sessionKey}\``;
    case 'cancel':
      return `*${label}*: \`${op.id}\``;
    case 'rename':
      return `*${label}*: \`${op.id}\` → “${truncate(op.text, 200)}”`;
    default:
      return `*Unknown operation*: ${JSON.stringify(op)}`;
  }
}

function truncate(text: string | undefined, max: number): string {
  if (!text) return '';
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Build the active confirmation message — summary of proposed ops + y/n buttons.
 *
 * `requestId` is packed into each button `value` so the action handler can
 * resolve the pending record without a secondary lookup.
 */
export function buildInstructionConfirmBlocks(request: SessionResourceUpdateRequest, requestId: string): any[] {
  const ops = request.instructionOperations ?? [];
  const header = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '*🤖 Instruction write proposal*\nThe assistant wants to update the session SSOT. Approve to commit, reject to drop (the assistant may re-propose).',
    },
  };
  const opList = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: ops.length === 0 ? '_(no operations)_' : ops.map((op) => `• ${summariseOp(op)}`).join('\n'),
    },
  };
  const actions = {
    type: 'actions',
    elements: [
      {
        type: 'button',
        style: 'primary',
        text: { type: 'plain_text', text: '✅ Yes, apply' },
        action_id: `${INSTRUCTION_CONFIRM_YES_ACTION}:${requestId}`,
        value: requestId,
      },
      {
        type: 'button',
        style: 'danger',
        text: { type: 'plain_text', text: '❌ No, reject' },
        action_id: `${INSTRUCTION_CONFIRM_NO_ACTION}:${requestId}`,
        value: requestId,
      },
    ],
  };
  return [header, opList, actions];
}

/** Fallback-text for the confirmation post (Slack requires it when blocks are used). */
export function buildInstructionConfirmFallbackText(request: SessionResourceUpdateRequest): string {
  const n = request.instructionOperations?.length ?? 0;
  return `Instruction write proposal: ${n} operation(s) waiting for your y/n.`;
}

/** Resolved-to-applied terminal state (no buttons). */
export function buildInstructionAppliedBlocks(request: SessionResourceUpdateRequest): any[] {
  const ops = request.instructionOperations ?? [];
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*✅ Applied* — the assistant’s proposed instruction write was committed.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ops.length === 0 ? '_(no operations)_' : ops.map((op) => `• ${summariseOp(op)}`).join('\n'),
      },
    },
  ];
}

/** Resolved-to-rejected terminal state (no buttons). */
export function buildInstructionRejectedBlocks(request: SessionResourceUpdateRequest): any[] {
  const ops = request.instructionOperations ?? [];
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*❌ Rejected* — the assistant’s proposed instruction write was dropped. The assistant may try again with a different proposal.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ops.length === 0 ? '_(no operations)_' : ops.map((op) => `• ${summariseOp(op)}`).join('\n'),
      },
    },
  ];
}

/** Superseded state — the assistant replaced this proposal with a newer one. */
export function buildInstructionSupersededBlocks(request: SessionResourceUpdateRequest): any[] {
  const ops = request.instructionOperations ?? [];
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*⚠️ `[superseded]`* — the assistant replaced this proposal with a newer one.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ops.length === 0 ? '_(no operations)_' : ops.map((op) => `• ${summariseOp(op)}`).join('\n'),
      },
    },
  ];
}
