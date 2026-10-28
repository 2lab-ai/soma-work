/**
 * Block Kit builders for the `/z` surface: `buildHelpCard`, `buildSettingCard`,
 * `buildConfirmationCard`.
 *
 * All block_ids are generated deterministically via `zBlockId()`:
 *   `z_<topic>_<issuedAt>_<index>`
 *
 * Action ID conventions (see docs/misc/reference/slack-block-kit.md):
 *   - `z_setting_<topic>_set_<value>` — apply value
 *   - `z_setting_<topic>_cancel`      — dismiss the card
 *   - `z_setting_<topic>_open_modal`  — open a text-input modal
 *   - `z_setting_<topic>_modal_submit` — view_submission callback
 *   - `z_help_nav_<topic>`             — navigate help → topic card
 *
 * See: docs/current/spec/z-command-master-spec.md §8 / §15.
 */

import { isSlashForbidden } from './capability';
import type { ZBlock } from './types';

/** Deterministic block_id generator.
 *
 * Topic is sanitized to `[a-z0-9_]+`. Non-alphanumeric runs collapse to a
 * single underscore; leading/trailing underscores are stripped. If nothing
 * alphanumeric remains, falls back to `z` so the generated id is always
 * well-formed (`z_<topic>_<issuedAt>_<index>`).
 */
export function zBlockId(topic: string, issuedAt: number, index: number): string {
  const collapsed = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const safeTopic = collapsed || 'z';
  return `z_${safeTopic}_${issuedAt}_${index}`;
}

/* ------------------------------------------------------------------ *
 * buildHelpCard
 * ------------------------------------------------------------------ */

/** One help category: card topics render as buttons, the rest as `/z <command>` chips. */
export interface HelpCategory {
  /** Heading shown above the button row (markdown). */
  title: string;
  /** One-line description (markdown, optional). */
  description?: string;
  topics: Array<{
    /** Topic id — the `z_help_nav_<id>` action id of a card topic. */
    id: string;
    /** The command after `/z` (`admin session list`) — the button label of a card topic. */
    label: string;
    /**
     * True when the topic has a registered Block Kit card (`src/slack/z/topics/index.ts`): it
     * renders as a button that opens the card. Every other topic is a text command and renders as
     * a `/z <label>` chip — never a button that promises a card. `flow-e2e.test.ts` holds the
     * card topics equal to the registry.
     */
    card?: boolean;
  }>;
}

export interface HelpCardOptions {
  issuedAt: number;
  /** When omitted, {@link DEFAULT_HELP_CATEGORIES} is used. */
  categories?: HelpCategory[];
}

export const DEFAULT_HELP_CATEGORIES: HelpCategory[] = [
  {
    title: '*🗂️ Session*',
    description: '세션 생성·전환·종료 · 컨텍스트·테마 관리',
    topics: [
      { id: 'goal', label: 'goal', card: true },
      { id: 'theme', label: 'theme', card: true },
      { id: 'new', label: 'new' },
      { id: 'close', label: 'close' },
      { id: 'renew', label: 'renew' },
      { id: 'context', label: 'context' },
      { id: 'restore', label: 'restore' },
      { id: 'link', label: 'link' },
      { id: 'compact', label: 'compact' },
      { id: 'queue', label: 'queue' },
      { id: 'session', label: 'session' },
      { id: 'onboarding', label: 'onboarding' },
    ],
  },
  {
    title: '*🎭 Persona & Model*',
    description: '페르소나, 모델, 출력 상세도',
    topics: [
      { id: 'persona', label: 'persona', card: true },
      { id: 'model', label: 'model', card: true },
      { id: 'verbosity', label: 'verbosity', card: true },
    ],
  },
  {
    title: '*🛡️ Permissions*',
    description: '권한 우회 · 샌드박스 격리',
    topics: [
      { id: 'bypass', label: 'bypass', card: true },
      { id: 'sandbox', label: 'sandbox', card: true },
    ],
  },
  {
    title: '*🧠 Memory & Tools*',
    description: '기억, CCT 토큰, 스킬, MCP, 플러그인',
    topics: [
      { id: 'memory', label: 'memory', card: true },
      { id: 'cct', label: 'cct', card: true },
      { id: 'auth', label: 'auth', card: true },
      { id: 'skill', label: 'skill', card: true },
      { id: 'mcp', label: 'mcp' },
      { id: 'plugin', label: 'plugin' },
      { id: 'marketplace', label: 'marketplace' },
    ],
  },
  {
    title: '*🔔 Integrations*',
    description: '알림·웹훅·이메일·작업 디렉토리·리포트',
    topics: [
      { id: 'notify', label: 'notify', card: true },
      { id: 'email', label: 'email', card: true },
      { id: 'cwd', label: 'cwd', card: true },
      { id: 'webhook', label: 'webhook' },
      { id: 'report', label: 'report' },
    ],
  },
  {
    title: '*📊 Usage*',
    description: '토큰 사용량 조회 · 개인 통계 카드',
    topics: [{ id: 'usage', label: 'usage', card: true }],
  },
  {
    title: '*📈 Dashboard*',
    description: '대시보드 원클릭 로그인 링크',
    topics: [{ id: 'dashboard', label: 'dashboard' }],
  },
  {
    title: '*🛠️ Admin*',
    description: '관리자 전용 명령',
    topics: [
      { id: 'admin_accept', label: 'admin accept' },
      { id: 'admin_deny', label: 'admin deny' },
      { id: 'admin_users', label: 'admin users' },
      { id: 'admin_config', label: 'admin config' },
      { id: 'admin_session_list', label: 'admin session list' },
    ],
  },
];

/** `/z <label>` chip; 🧵 marks a command that needs a thread (cannot run as the `/z` slash command). */
function commandChip(label: string): string {
  const [topic, verb, arg] = label.split(' ');
  return `\`/z ${label}\`${isSlashForbidden(topic, verb, arg) ? '🧵' : ''}`;
}

/**
 * The `/z` help card — shown by `help`, `/z`, and `/z help`.
 *
 * Card topics are buttons; clicking one replaces the help card with the topic's card (see the
 * `z_help_nav_<topic>` handler in `z-settings-actions.ts`). Every other topic is a text command,
 * listed as a `/z <command>` chip under its category.
 */
export function buildHelpCard(opts: HelpCardOptions): ZBlock[] {
  const { issuedAt } = opts;
  const categories = opts.categories ?? DEFAULT_HELP_CATEGORIES;
  const blocks: ZBlock[] = [];
  let idx = 0;

  blocks.push({
    type: 'header',
    block_id: zBlockId('help', issuedAt, idx++),
    text: { type: 'plain_text', text: '📚 /z commands', emoji: true },
  });

  blocks.push({
    type: 'context',
    block_id: zBlockId('help', issuedAt, idx++),
    elements: [
      {
        type: 'mrkdwn',
        text:
          '버튼은 설정 카드를 엽니다. `/z …` 명령은 직접 입력해서 실행합니다. ' +
          '🧵 표시는 스레드에서 `@봇 /z <command>`로만 실행됩니다.',
      },
    ],
  });

  for (const cat of categories) {
    blocks.push({
      type: 'section',
      block_id: zBlockId('help', issuedAt, idx++),
      text: {
        type: 'mrkdwn',
        text: cat.description ? `${cat.title}\n${cat.description}` : cat.title,
      },
    });

    // Slack actions block limit: 25 elements. Chunk into rows of 5 for
    // visual balance and button-width consistency.
    const cards = cat.topics.filter((t) => t.card);
    const chunkSize = 5;
    for (let i = 0; i < cards.length; i += chunkSize) {
      blocks.push({
        type: 'actions',
        block_id: zBlockId('help', issuedAt, idx++),
        elements: cards.slice(i, i + chunkSize).map((topic) => ({
          type: 'button',
          action_id: `z_help_nav_${topic.id}`,
          text: { type: 'plain_text', text: topic.label, emoji: true },
          value: topic.id,
        })),
      });
    }

    const commands = cat.topics.filter((t) => !t.card);
    if (commands.length > 0) {
      blocks.push({
        type: 'context',
        block_id: zBlockId('help', issuedAt, idx++),
        elements: [{ type: 'mrkdwn', text: commands.map((t) => commandChip(t.label)).join('  ') }],
      });
    }
  }

  blocks.push({
    type: 'context',
    block_id: zBlockId('help', issuedAt, idx++),
    elements: [
      {
        type: 'mrkdwn',
        text: '_팁: `%`, `%model <v>`, `%verbosity <v>` 등 세션 전용 명령은 스레드에서 동작합니다. `$<skill>`은 스킬을 바로 실행합니다._',
      },
    ],
  });

  return blocks;
}

/* ------------------------------------------------------------------ *
 * buildSettingCard
 * ------------------------------------------------------------------ */

export interface SettingCardOption {
  id: string;
  label: string;
  /**
   * If set, Slack renders a confirmation dialog before the set action runs.
   * Also appended as context on hover/no-dialog fallback clients.
   */
  description?: string;
  /** If set, overrides the auto-generated `z_setting_<topic>_set_<id>`. */
  actionIdOverride?: string;
  /** Button style. */
  style?: 'primary' | 'danger';
  /** Optional extra payload delivered in `action.value`. */
  value?: string;
}

export interface SettingCardExtraAction {
  /** Required. e.g. `z_setting_notify_open_modal`. */
  actionId: string;
  label: string;
  style?: 'primary' | 'danger';
  value?: string;
}

export interface SettingCardOptions {
  topic: string;
  icon: string;
  title: string;
  currentLabel: string;
  currentDescription?: string;
  options: SettingCardOption[];
  /**
   * Extra (non-"set") buttons — typically used for "Open modal" / "Remove"
   * flows. Rendered in their own actions block below
   * the options grid.
   */
  extraActions?: SettingCardExtraAction[];
  /** Markdown lines listed in a context block under the options grid. */
  additionalCommands?: string[];
  /** Default `true`. When `false`, no 취소 button is rendered. */
  showCancel?: boolean;
  issuedAt: number;
}

/**
 * Setting card layout:
 *   [0] header          "<icon> <title>"
 *   [1] context         "*Current:* <currentLabel>\n<currentDescription>"
 *   [2..] actions rows  options buttons (5 per row)
 *   [N]   actions row   extraActions (if any)
 *   [N+1] divider       (only if additionalCommands)
 *   [N+2] context       additionalCommands (if any)
 *   [99]  actions       cancel (if showCancel)
 */
export function buildSettingCard(opts: SettingCardOptions): ZBlock[] {
  const {
    topic,
    icon,
    title,
    currentLabel,
    currentDescription,
    options,
    extraActions,
    additionalCommands,
    showCancel = true,
    issuedAt,
  } = opts;

  const blocks: ZBlock[] = [];

  // [0] header
  blocks.push({
    type: 'header',
    block_id: zBlockId(topic, issuedAt, 0),
    text: { type: 'plain_text', text: `${icon} ${title}`, emoji: true },
  });

  // [1] current
  const currentText = currentDescription
    ? `*Current:* ${currentLabel}\n${currentDescription}`
    : `*Current:* ${currentLabel}`;
  blocks.push({
    type: 'context',
    block_id: zBlockId(topic, issuedAt, 1),
    elements: [{ type: 'mrkdwn', text: currentText }],
  });

  // [2..] options buttons (chunked max 5 per actions block)
  let rowIdx = 2;
  for (let i = 0; i < options.length; i += 5) {
    const chunk = options.slice(i, i + 5);
    blocks.push({
      type: 'actions',
      block_id: zBlockId(topic, issuedAt, rowIdx++),
      elements: chunk.map((opt) => {
        const actionId = opt.actionIdOverride ?? `z_setting_${topic}_set_${opt.id}`;
        const button: any = {
          type: 'button',
          action_id: actionId,
          text: { type: 'plain_text', text: opt.label, emoji: true },
          value: opt.value ?? opt.id,
        };
        if (opt.style) button.style = opt.style;
        if (opt.description) {
          button.confirm = {
            title: { type: 'plain_text', text: opt.label },
            text: { type: 'plain_text', text: opt.description },
            confirm: { type: 'plain_text', text: 'OK' },
            deny: { type: 'plain_text', text: 'Cancel' },
          };
        }
        return button;
      }),
    });
  }

  // extra actions (open-modal / remove / toggle etc.)
  if (extraActions?.length) {
    blocks.push({
      type: 'actions',
      block_id: zBlockId(topic, issuedAt, rowIdx++),
      elements: extraActions.map((a) => {
        const button: any = {
          type: 'button',
          action_id: a.actionId,
          text: { type: 'plain_text', text: a.label, emoji: true },
          value: a.value ?? a.actionId,
        };
        if (a.style) button.style = a.style;
        return button;
      }),
    });
  }

  if (additionalCommands?.length) {
    blocks.push({
      type: 'divider',
      block_id: zBlockId(topic, issuedAt, rowIdx++),
    });
    blocks.push({
      type: 'context',
      block_id: zBlockId(topic, issuedAt, rowIdx++),
      elements: [{ type: 'mrkdwn', text: additionalCommands.join('\n') }],
    });
  }

  if (showCancel) {
    blocks.push({
      type: 'actions',
      block_id: zBlockId(topic, issuedAt, 99),
      elements: [
        {
          type: 'button',
          action_id: `z_setting_${topic}_cancel`,
          text: { type: 'plain_text', text: '❌ 취소' },
          style: 'danger',
          value: 'cancel',
        },
      ],
    });
  }

  return blocks;
}

/* ------------------------------------------------------------------ *
 * buildConfirmationCard — minimal "applied" card shown after set
 * ------------------------------------------------------------------ */

export interface ConfirmationCardOptions {
  topic: string;
  icon: string;
  title: string;
  /** Short one-line confirmation (markdown). */
  summary: string;
  /** Optional additional markdown context. */
  description?: string;
  issuedAt: number;
}

/** Simple confirmation card shown after a successful set/apply. */
export function buildConfirmationCard(opts: ConfirmationCardOptions): ZBlock[] {
  const { topic, icon, title, summary, description, issuedAt } = opts;
  const blocks: ZBlock[] = [
    {
      type: 'section',
      block_id: zBlockId(topic, issuedAt, 0),
      text: {
        type: 'mrkdwn',
        text: `${icon} *${title}*\n${summary}`,
      },
    },
  ];
  if (description) {
    blocks.push({
      type: 'context',
      block_id: zBlockId(topic, issuedAt, 1),
      elements: [{ type: 'mrkdwn', text: description }],
    });
  }
  return blocks;
}
