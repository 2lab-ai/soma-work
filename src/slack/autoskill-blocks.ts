/**
 * Block Kit builders + id constants for the `autoskill` management UI.
 *
 * Leaf module (no handler imports) so both the command handler that renders the
 * card and the action/view handlers that mutate it can share the exact same
 * block shapes and action_ids without forming an import cycle.
 */

import type { AvailableSkill } from '../skill-locator';

/** Button action_id: delete one registered autoskill (value carries the name). */
export const AUTOSKILL_REMOVE_ACTION_ID = 'autoskill_remove';
/** Button action_id: open the "add skill" modal. */
export const AUTOSKILL_ADD_OPEN_ACTION_ID = 'autoskill_add_open';
/** view callback_id: the add-skill modal submit. */
export const AUTOSKILL_ADD_MODAL_CALLBACK_ID = 'autoskill_add_modal_submit';
/** input block_id inside the add modal. */
export const AUTOSKILL_ADD_BLOCK_ID = 'autoskill_add_block';
/** multi_static_select action_id inside the add modal. */
export const AUTOSKILL_ADD_SELECT_ACTION_ID = 'autoskill_add_select';

/** Slack `multi_static_select` hard cap on options. */
const MAX_SELECT_OPTIONS = 100;

export interface AutoskillButtonValue {
  requesterId: string;
  /** Present on the remove button; absent on the add-open button. */
  skillName?: string;
}

export interface AutoskillModalMetadata {
  requesterId: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
}

/**
 * Build the autoskill management card: one row per registered skill with a
 * "🗑 삭제" button, plus a "➕ 추가" button. `requesterId` is embedded in every
 * button value so only the user who opened the card can mutate it.
 */
export function buildAutoskillCard(args: { requesterId: string; skills: string[] }): {
  text: string;
  blocks: any[];
} {
  const { requesterId, skills } = args;
  const blocks: any[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '⚡ *Autoskill* — 새 작업(세션) 시작 시 항상 자동 발동되는 스킬 목록',
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '등록된 스킬은 새 세션 시작 시 (Autogoal 다음에) `$skill`처럼 자동으로 *강제 발동*됩니다. `set autoskill a, b` 로도 한 번에 설정할 수 있습니다.',
        },
      ],
    },
    { type: 'divider' },
  ];

  if (skills.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_등록된 autoskill이 없습니다._ `➕ 추가` 를 눌러 등록하세요.' },
    });
  } else {
    for (const name of skills) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `• \`${name}\`` },
        accessory: {
          type: 'button',
          action_id: AUTOSKILL_REMOVE_ACTION_ID,
          text: { type: 'plain_text', text: '🗑 삭제' },
          style: 'danger',
          value: JSON.stringify({ requesterId, skillName: name } satisfies AutoskillButtonValue),
        },
      });
    }
  }

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        action_id: AUTOSKILL_ADD_OPEN_ACTION_ID,
        text: { type: 'plain_text', text: '➕ 추가' },
        style: 'primary',
        value: JSON.stringify({ requesterId } satisfies AutoskillButtonValue),
      },
    ],
  });

  const text = skills.length === 0 ? '⚡ Autoskill: (없음)' : `⚡ Autoskill: ${skills.join(', ')}`;
  return { text, blocks };
}

/**
 * Build the "add autoskill" modal: a multi-select of every available skill the
 * user can register, excluding ones already registered. Returns null when there
 * is nothing left to add (caller surfaces an ephemeral instead of an empty
 * modal Slack would reject).
 */
export function buildAutoskillAddModal(args: {
  available: AvailableSkill[];
  alreadyRegistered: string[];
  privateMetadata: AutoskillModalMetadata;
}): Record<string, any> | null {
  const registered = new Set(args.alreadyRegistered);
  const selectable = args.available.filter((s) => !registered.has(s.name));
  if (selectable.length === 0) return null;

  const truncated = selectable.length > MAX_SELECT_OPTIONS;
  const options = selectable.slice(0, MAX_SELECT_OPTIONS).map((s) => ({
    text: { type: 'plain_text', text: `${s.name} · ${s.source}`.slice(0, 75) },
    value: s.name.slice(0, 75),
  }));

  const blocks: any[] = [
    {
      type: 'input',
      block_id: AUTOSKILL_ADD_BLOCK_ID,
      label: { type: 'plain_text', text: '추가할 스킬 선택' },
      element: {
        type: 'multi_static_select',
        action_id: AUTOSKILL_ADD_SELECT_ACTION_ID,
        placeholder: { type: 'plain_text', text: '여러 개 선택 가능' },
        options,
      },
    },
  ];
  if (truncated) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `_스킬이 ${selectable.length}개라 처음 ${MAX_SELECT_OPTIONS}개만 표시됩니다. 나머지는 \`set autoskill <name>\` 으로 추가하세요._`,
        },
      ],
    });
  }

  return {
    type: 'modal',
    callback_id: AUTOSKILL_ADD_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify(args.privateMetadata),
    title: { type: 'plain_text', text: '⚡ Autoskill 추가'.slice(0, 24) },
    submit: { type: 'plain_text', text: '추가' },
    close: { type: 'plain_text', text: '취소' },
    blocks,
  };
}

/** Parse a button `value` JSON payload, returning null on malformed input. */
export function parseAutoskillButtonValue(raw: unknown): AutoskillButtonValue | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as { requesterId?: unknown; skillName?: unknown };
    if (typeof parsed.requesterId !== 'string' || !parsed.requesterId) return null;
    return {
      requesterId: parsed.requesterId,
      skillName: typeof parsed.skillName === 'string' ? parsed.skillName : undefined,
    };
  } catch {
    return null;
  }
}

/** Parse the modal `private_metadata` JSON, returning null on malformed input. */
export function parseAutoskillModalMetadata(raw: unknown): AutoskillModalMetadata | null {
  if (typeof raw !== 'string') return null;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (typeof p.requesterId !== 'string' || !p.requesterId) return null;
    return {
      requesterId: p.requesterId,
      channelId: typeof p.channelId === 'string' ? p.channelId : '',
      messageTs: typeof p.messageTs === 'string' ? p.messageTs : '',
      threadTs: typeof p.threadTs === 'string' ? p.threadTs : '',
    };
  } catch {
    return null;
  }
}
