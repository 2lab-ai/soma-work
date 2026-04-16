/**
 * Block Kit builders for the `/z` surface.
 *
 * Phase 1 implements `buildHelpCard` and `buildTombstoneCard`.
 * `buildSettingCard` is a stub — full implementation lands in Phase 2 (#507).
 *
 * All block_ids are generated deterministically via `zBlockId()`:
 *   `z_<topic>_<issuedAt>_<index>`
 *
 * See: plan/MASTER-SPEC.md §8 / §15.
 */

import type { TombstoneHint } from './tombstone';
import type { ZBlock } from './types';

/** Deterministic block_id generator. */
export function zBlockId(topic: string, issuedAt: number, index: number): string {
  const safeTopic = topic.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'z';
  return `z_${safeTopic}_${issuedAt}_${index}`;
}

/* ------------------------------------------------------------------ *
 * buildHelpCard
 * ------------------------------------------------------------------ */

export interface HelpCardOptions {
  issuedAt: number;
}

/**
 * The `/z` help card — shown when `/z` is invoked with no remainder.
 *
 * Kept deliberately simple in Phase 1: one header + one markdown section that
 * enumerates the topic surface. Phase 2 can upgrade this to navigable buttons.
 */
export function buildHelpCard(opts: HelpCardOptions): ZBlock[] {
  const { issuedAt } = opts;
  const body = [
    '*📚 /z commands*',
    '',
    '*Session:* `/z new [prompt]` • `/z renew [prompt]` • `/z close` • `/z context` • `/z compact` • `/z restore`',
    '*Session state:* `/z session` • `/z session set model <v>` • `/z session set verbosity <v>` • `/z session set effort <v>` • `/z session set thinking <v>` • `/z session set thinking_summary <v>`',
    '*Settings:* `/z persona [set <n> | list]` • `/z model [set <n> | list]` • `/z verbosity [set <l>]` • `/z bypass [set on|off]` • `/z sandbox [set on|off]`',
    '*Notifications:* `/z notify [set on|off]` • `/z notify telegram set <token>` • `/z webhook [add <url> | remove <id> | test <id>]`',
    '*Memory & MCP:* `/z memory [clear [N] | save user <t>]` • `/z mcp [list | reload]`',
    '*Content:* `/z prompt` • `/z instructions` • `/z link issue|pr|doc <url>` • `/z email [set <x>]`',
    '*Plugins:* `/z plugin [add <x> | update | remove <x>]` • `/z skill [list | download]` • `/z marketplace [add <x>]`',
    '*Working dir:* `/z cwd [set <p>]` • `/z cct [set <n> | next]`',
    '*Reports:* `/z report [today|daily|weekly]` • `/z onboarding`',
    '*Admin:* `/z admin accept <@U>` • `/z admin deny <@U>` • `/z admin users` • `/z admin config [set <KEY> <VAL>]` • `/z admin llmchat [set <p> <k> <v> | reset]` • `/z admin session list`',
    '',
    '_팁: `$`, `$model <v>`, `$verbosity <v>` 등 네이키드 세션 명령은 그대로 동작합니다._',
  ].join('\n');

  return [
    {
      type: 'section',
      block_id: zBlockId('help', issuedAt, 0),
      text: { type: 'mrkdwn', text: body },
    },
  ];
}

/* ------------------------------------------------------------------ *
 * buildTombstoneCard
 * ------------------------------------------------------------------ */

export interface TombstoneCardOptions {
  hint: TombstoneHint;
  issuedAt: number;
}

/**
 * The one-time migration tombstone — shown on first legacy naked attempt per
 * user.
 */
export function buildTombstoneCard(opts: TombstoneCardOptions): ZBlock[] {
  const { hint, issuedAt } = opts;
  const topic = hint.title || 'z';

  const header: ZBlock = {
    type: 'section',
    block_id: zBlockId(topic, issuedAt, 0),
    text: {
      type: 'mrkdwn',
      text: [
        `ℹ️ *이 명령은 더 이상 사용되지 않습니다*`,
        ``,
        `이전: \`${hint.oldForm}\``,
        `신규: \`${hint.newForm}\``,
      ].join('\n'),
    },
  };

  const actions: ZBlock = {
    type: 'actions',
    block_id: zBlockId(topic, issuedAt, 1),
    elements: [
      {
        type: 'button',
        action_id: `z_tombstone_copy_${topic}`,
        text: { type: 'plain_text', text: '📋 복사' },
        value: hint.newForm,
      },
      {
        type: 'button',
        action_id: `z_tombstone_dismiss_${topic}`,
        text: { type: 'plain_text', text: '❌ 무시' },
        value: hint.title,
        style: 'danger',
      },
    ],
  };

  const footer: ZBlock = {
    type: 'context',
    block_id: zBlockId(topic, issuedAt, 2),
    elements: [
      {
        type: 'mrkdwn',
        text: '💡 `/z` 또는 `/z help`로 전체 명령을 확인할 수 있어요.',
      },
    ],
  };

  return [header, actions, footer];
}

/* ------------------------------------------------------------------ *
 * buildSettingCard — Phase 2 stub
 * ------------------------------------------------------------------ */

export interface SettingCardOption {
  id: string;
  label: string;
  description?: string;
}

export interface SettingCardOptions {
  topic: string;
  icon: string;
  title: string;
  currentLabel: string;
  currentDescription?: string;
  options: SettingCardOption[];
  additionalCommands?: string[];
  showCancel?: boolean;
  issuedAt: number;
}

/**
 * STUB — Phase 2 full implementation (#507).
 *
 * The signature is preserved so Phase 2 can swap the implementation without
 * touching any callers. For now it produces a minimal placeholder card so
 * test harnesses and ad-hoc callers don't crash.
 */
export function buildSettingCard(opts: SettingCardOptions): ZBlock[] {
  const { topic, icon, title, currentLabel, issuedAt } = opts;
  return [
    {
      type: 'section',
      block_id: zBlockId(topic, issuedAt, 0),
      text: {
        type: 'mrkdwn',
        text: `${icon} *${title}* — current: \`${currentLabel}\`\n_(buildSettingCard is a stub — full UI lands in Phase 2 #507)_`,
      },
    },
  ];
}
