import { isAdminUser } from '../../admin-utils';
import { Logger } from '../../logger';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

/**
 * UI test harness for Phase 0 of #525 — Slack Agents UI migration.
 *
 * Exposes two DM-only naked commands behind triple gating:
 *   `ui-test stream` — exercises chat.startStream / appendStream / stopStream
 *   `ui-test plan`   — exercises plan + task_card blocks across 5 state transitions
 *
 * Gating order (env → admin → DM-only → subcommand) is deliberate:
 *  1. If SLACK_UI_TEST_ENABLED is not exactly 'true', the handler still matches
 *     but returns early with a disabled notice — this prevents the naked
 *     `ui-test` text from falling through to the session initialization path.
 *  2. Non-admin users get a permission-denied notice.
 *  3. Non-DM channels get a DM-only notice (avoids prod noise, dodges the
 *     `recipient_user_id`/`recipient_team_id` requirement on channel streams).
 *  4. Unknown subcommands print usage.
 *
 * Slash `/z ui-test` is intentionally blocked by SLASH_FORBIDDEN in
 * `src/slack/z/capability.ts` — the slash path sets `threadTs = channel_id` as
 * a placeholder which is incompatible with `chat.startStream({ thread_ts })`.
 *
 * See issue #525 and docs/slack-ui-phase0.md for go/no-go checklist.
 */
export class UITestHandler implements CommandHandler {
  private logger = new Logger('UITestHandler');

  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    // Intentionally DO NOT check SLACK_UI_TEST_ENABLED here. The env gate is
    // enforced inside execute() so the handler still claims the message and
    // prevents fall-through to the general session pipeline when disabled.
    return /^ui-test(\s+(stream|plan))?$/i.test((text ?? '').trim());
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, channel, threadTs, text, say } = ctx;

    // Gate 1: env flag
    if (process.env.SLACK_UI_TEST_ENABLED !== 'true') {
      await say({
        text: '⚠️ `ui-test` is disabled. Set `SLACK_UI_TEST_ENABLED=true` to enable the Phase 0 harness.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    // Gate 2: admin-only
    if (!isAdminUser(user)) {
      await say({
        text: '🚫 *Permission Denied*\n\n`ui-test` is admin-only.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    // Gate 3: DM-only. Slack DM channel IDs start with `D` (im), public/
    // private channels start with `C`/`G`. We deliberately avoid extending
    // CommandContext with `channelType` — this one-char check suffices.
    if (!channel.startsWith('D')) {
      await say({
        text: '🙈 `ui-test` is DM-only. Please send this command in a direct message with the bot.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    // Gate 4: subcommand dispatch
    const trimmed = (text ?? '').trim();
    const match = /^ui-test(?:\s+(stream|plan))?$/i.exec(trimmed);
    const subcommand = match?.[1]?.toLowerCase();

    if (!subcommand) {
      await say({
        text:
          '📖 *`ui-test` usage*\n' +
          '• `ui-test stream` — run a 5-chunk streaming demo (chat.startStream/appendStream/stopStream)\n' +
          '• `ui-test plan` — render a plan + 4 task_cards and transition through 5 states',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    try {
      if (subcommand === 'stream') {
        await this.runStreamDemo(ctx);
      } else if (subcommand === 'plan') {
        await this.runPlanDemo(ctx);
      }
    } catch (error: any) {
      this.logger.error('ui-test handler failed', {
        subcommand,
        error: error?.message,
        stack: error?.stack,
      });
      await say({
        text: `❌ \`ui-test ${subcommand}\` failed: ${error?.message ?? 'unknown error'}`,
        thread_ts: threadTs,
      });
    }
    return { handled: true };
  }

  /**
   * Resolve the thread_ts for this run.
   *
   * If the user triggered `ui-test` inside an existing DM thread, we reply
   * into that thread. Otherwise we start at the DM root. The guard against
   * `threadTs === channel` defends against slash adapter placeholders, but
   * since slash `/z ui-test` is forbidden this is belt-and-suspenders.
   */
  private resolveThreadTs(ctx: CommandContext): string | undefined {
    const { threadTs, channel } = ctx;
    if (!threadTs || threadTs === '' || threadTs === channel) {
      return undefined;
    }
    return threadTs;
  }

  private async runStreamDemo(ctx: CommandContext): Promise<void> {
    const { channel } = ctx;
    const client = this.deps.slackApi.getClient();
    const thread_ts = this.resolveThreadTs(ctx);

    // Cast: `ChatStartStreamArguments.thread_ts` is typed as required in the
    // SDK, but the API treats it as optional for DM root streams. Spread-omit
    // is semantically what we want; the cast bridges the SDK's stricter type.
    const start = await client.chat.startStream({
      channel,
      ...(thread_ts ? { thread_ts } : {}),
    } as any);
    const ts = start.ts;
    if (!ts) {
      throw new Error('chat.startStream returned no ts');
    }

    for (let n = 1; n <= 5; n += 1) {
      await client.chat.appendStream({
        channel,
        ts,
        chunks: [
          {
            type: 'markdown_text',
            text: buildStreamChunkText(n),
          },
        ],
      });
      await sleep(800);
    }

    await client.chat.stopStream({
      channel,
      ts,
      markdown_text: '✅ Stream demo complete (5 chunks).',
    });
  }

  private async runPlanDemo(ctx: CommandContext): Promise<void> {
    const { channel } = ctx;
    const client = this.deps.slackApi.getClient();
    const thread_ts = this.resolveThreadTs(ctx);

    // Cast to `any[]` — plan/task_card blocks are a recent Block Kit addition
    // (2026-02) and the `KnownBlock` union in @slack/types uses loose typing
    // (`Record<string, unknown>` for task arrays). Passing our typed object
    // literal directly triggers TS2322 vs the VideoBlock branch of the union.
    const first = await client.chat.postMessage({
      channel,
      ...(thread_ts ? { thread_ts } : {}),
      text: fallbackText(0),
      blocks: buildPlanBlocks(0) as any[],
    });
    const ts = first.ts;
    if (!ts) {
      throw new Error('chat.postMessage returned no ts');
    }

    for (let state = 1; state <= 4; state += 1) {
      await sleep(3000);
      await client.chat.update({
        channel,
        ts,
        text: fallbackText(state),
        blocks: buildPlanBlocks(state) as any[],
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Streaming chunk helpers
// ---------------------------------------------------------------------------

const LOREM_260 =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod ' +
  'tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim ' +
  'veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea ' +
  'commodo consequat. Duis aute irure dolor in reprehenderit in voluptate.';

function buildStreamChunkText(n: number): string {
  return `${LOREM_260} — chunk ${n} of 5.`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Plan + task_card helpers
// ---------------------------------------------------------------------------

type TaskStatus = 'pending' | 'in_progress' | 'complete' | 'error';

/**
 * Status matrix for the 5 plan-demo states. Each row is (t0, t1, t2, t3).
 * status value `complete` matches the Slack schema (NOT `completed`).
 */
const STATE_MATRIX: ReadonlyArray<readonly [TaskStatus, TaskStatus, TaskStatus, TaskStatus]> = [
  ['pending', 'pending', 'pending', 'pending'],
  ['in_progress', 'pending', 'pending', 'pending'],
  ['complete', 'in_progress', 'pending', 'pending'],
  ['complete', 'complete', 'error', 'pending'],
  ['complete', 'complete', 'error', 'complete'],
];

function taskCard(i: number, status: TaskStatus): Record<string, unknown> {
  return {
    type: 'task_card',
    task_id: `t${i}`,
    title: `Task ${i}`,
    status,
    details: {
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_section',
          elements: [{ type: 'text', text: `Detail for task ${i}` }],
        },
      ],
    },
  };
}

function planBlock(state: number): Record<string, unknown> {
  const row = STATE_MATRIX[state];
  return {
    type: 'plan',
    title: 'Phase 0 UI test plan',
    tasks: row.map((status, idx) => taskCard(idx, status)),
  };
}

function fallbackSection(state: number): Record<string, unknown> {
  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Fallback* — state ${state}: ${statesDescription(state)}`,
    },
  };
}

function buildPlanBlocks(state: number): Record<string, unknown>[] {
  return [planBlock(state), fallbackSection(state)];
}

function statesDescription(state: number): string {
  const row = STATE_MATRIX[state];
  return row.map((status, idx) => `t${idx}=${status}`).join(' · ');
}

function fallbackText(state: number): string {
  return `Plan demo state ${state}: ${statesDescription(state)}`;
}
