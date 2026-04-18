import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { isAdminUser } from '../../admin-utils';
import { Logger } from '../../logger';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

const execAsync = promisify(exec);

/** Anchored match for `ui-test` and its subcommands. Case-insensitive. */
const UI_TEST_RE = /^ui-test(?:\s+(stream|plan|task_card|work))?$/i;

/**
 * UI test harness for Phase 0 of #525 — Slack Agents UI migration.
 *
 * Exposes DM-only naked commands behind triple gating:
 *   `ui-test stream`    — chat.startStream / appendStream / stopStream (5 chunks)
 *   `ui-test plan`      — plan + 4 task_cards across 5 state transitions
 *   `ui-test task_card` — standalone task_card block, pending → in_progress → complete
 *   `ui-test work`      — combined streaming narrative + live plan updates driven by
 *                         real `child_process.exec` calls (pwd/date/uptime/ls), so the
 *                         harness literally "does work" on the host while both blocks
 *                         advance in lockstep.
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
 * Stream mode invariant: once `appendStream` is called with `chunks:[{type,text}]`,
 * Slack locks the stream into "chunks" mode. `stopStream` must ALSO close with a
 * `chunks` array — passing a top-level `markdown_text` after chunked appends will
 * raise `streaming_mode_mismatch`. Both runners below honor that invariant.
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
    return UI_TEST_RE.test((text ?? '').trim());
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, channel, threadTs, text, say } = ctx;

    if (process.env.SLACK_UI_TEST_ENABLED !== 'true') {
      await say({
        text: '⚠️ `ui-test` is disabled. Set `SLACK_UI_TEST_ENABLED=true` to enable the Phase 0 harness.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    if (!isAdminUser(user)) {
      await say({
        text: '🚫 *Permission Denied*\n\n`ui-test` is admin-only.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    // Slack DM channel IDs start with `D` (im), public/private channels with
    // `C`/`G`. We deliberately avoid extending CommandContext with
    // `channelType` — this one-char check suffices.
    if (!channel.startsWith('D')) {
      await say({
        text: '🙈 `ui-test` is DM-only. Please send this command in a direct message with the bot.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    const subcommand = UI_TEST_RE.exec((text ?? '').trim())?.[1]?.toLowerCase();

    if (!subcommand) {
      await say({
        text:
          '📖 *`ui-test` usage*\n' +
          '• `ui-test stream` — 5-chunk streaming demo (chat.startStream/appendStream/stopStream)\n' +
          '• `ui-test plan` — render a plan + 4 task_cards and transition through 5 states\n' +
          '• `ui-test task_card` — standalone task_card block, pending → in_progress → complete\n' +
          '• `ui-test work` — combined stream + plan driven by real shell work (pwd/date/uptime/ls)',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    try {
      if (subcommand === 'stream') {
        await this.runStreamDemo(ctx);
      } else if (subcommand === 'plan') {
        await this.runPlanDemo(ctx);
      } else if (subcommand === 'task_card') {
        await this.runTaskCardDemo(ctx);
      } else if (subcommand === 'work') {
        await this.runWorkDemo(ctx);
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

    // Must close in the SAME mode appendStream used (chunks). Passing a
    // top-level `markdown_text` here after chunked appends raises
    // `streaming_mode_mismatch` server-side. Verified in DM on 2026-04-17.
    await client.chat.stopStream({
      channel,
      ts,
      chunks: [{ type: 'markdown_text', text: '✅ Stream demo complete (5 chunks).' }],
    } as any);
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

  /**
   * Standalone task_card demo — posts one task_card block (outside any plan
   * wrapper) and transitions it pending → in_progress → complete via
   * `chat.update`. Confirms whether Slack accepts task_card as a top-level
   * block on all three clients (iOS / Android / desktop web). If Slack rejects
   * the payload, the outer try/catch surfaces the error text in-channel.
   */
  private async runTaskCardDemo(ctx: CommandContext): Promise<void> {
    const { channel } = ctx;
    const client = this.deps.slackApi.getClient();
    const thread_ts = this.resolveThreadTs(ctx);
    const threadArg = thread_ts ? { thread_ts } : {};

    const states: TaskStatus[] = ['pending', 'in_progress', 'complete'];

    const first = await client.chat.postMessage({
      channel,
      ...threadArg,
      text: `task_card demo — ${states[0]}`,
      blocks: [standaloneTaskCard(states[0])] as any[],
    });
    const ts = first.ts;
    if (!ts) {
      throw new Error('chat.postMessage task_card returned no ts');
    }

    for (let i = 1; i < states.length; i += 1) {
      await sleep(3000);
      await client.chat.update({
        channel,
        ts,
        text: `task_card demo — ${states[i]}`,
        blocks: [standaloneTaskCard(states[i])] as any[],
      });
    }
  }

  /**
   * Combined simulation — runs a 4-step "fake agent" loop:
   *   top:    streaming narration (startStream → appendStream → stopStream)
   *   bottom: plan block with 4 task_cards (postMessage → chat.update ×N)
   *
   * Each step really executes a hardcoded shell command (pwd / date -u /
   * uptime / ls /tmp | wc -l) via node:child_process.exec so the block
   * transitions are driven by actual I/O instead of timers. Output is
   * redacted to N lines per step and appended to the stream. No user input
   * reaches the shell — commands are compile-time constants. 5s timeout and
   * 4KB buffer per step limit blast radius if the host environment misbehaves.
   */
  private async runWorkDemo(ctx: CommandContext): Promise<void> {
    const { channel } = ctx;
    const client = this.deps.slackApi.getClient();
    const thread_ts = this.resolveThreadTs(ctx);
    const threadArg = thread_ts ? { thread_ts } : {};

    // Start stream FIRST so it anchors above the plan in the DM timeline.
    const start = await client.chat.startStream({
      channel,
      ...threadArg,
    } as any);
    const streamTs = start.ts;
    if (!streamTs) {
      throw new Error('chat.startStream returned no ts');
    }

    await appendStreamText(
      client,
      channel,
      streamTs,
      `🤖 *Simulated agent run* — ${WORK_STEPS.length} real shell tasks queued.\n\n`,
    );

    const statuses: TaskStatus[] = WORK_STEPS.map(() => 'pending');

    // Plan block posted AFTER stream so it lands below the stream in the DM.
    const planPost = await client.chat.postMessage({
      channel,
      ...threadArg,
      text: workFallbackText(statuses),
      blocks: buildWorkPlan(statuses) as any[],
    });
    const planTs = planPost.ts;
    if (!planTs) {
      throw new Error('chat.postMessage plan returned no ts');
    }

    for (let i = 0; i < WORK_STEPS.length; i += 1) {
      const step = WORK_STEPS[i];

      statuses[i] = 'in_progress';
      await client.chat.update({
        channel,
        ts: planTs,
        text: workFallbackText(statuses),
        blocks: buildWorkPlan(statuses) as any[],
      });
      await appendStreamText(client, channel, streamTs, `### ${step.title}\n\`$ ${step.cmd}\`\n\n`);

      const result = await runShell(step.cmd);
      const truncated = result.text.split('\n').slice(0, step.maxLines).join('\n');
      await appendStreamText(client, channel, streamTs, '```\n' + truncated + '\n```\n\n');

      statuses[i] = result.ok ? 'complete' : 'error';
      await client.chat.update({
        channel,
        ts: planTs,
        text: workFallbackText(statuses),
        blocks: buildWorkPlan(statuses) as any[],
      });
      await sleep(400);
    }

    const finalSummary = workSummary(statuses);
    await client.chat.stopStream({
      channel,
      ts: streamTs,
      chunks: [{ type: 'markdown_text', text: finalSummary }],
    } as any);
  }
}

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

function standaloneTaskCard(status: TaskStatus): Record<string, unknown> {
  return {
    type: 'task_card',
    task_id: 'tc-standalone',
    title: 'Standalone task_card demo',
    status,
    details: {
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_section',
          elements: [{ type: 'text', text: `Currently ${status}` }],
        },
      ],
    },
  };
}

/**
 * Steps executed by `ui-test work`. Commands are HARDCODED constants — no
 * user input reaches the shell — so the admin/DM/env gate is the only trust
 * boundary we need. `maxLines` clamps streamed output per step.
 */
const WORK_STEPS: ReadonlyArray<{ title: string; cmd: string; maxLines: number }> = [
  { title: 'Check working directory', cmd: 'pwd', maxLines: 1 },
  { title: 'Capture UTC timestamp', cmd: 'date -u', maxLines: 1 },
  { title: 'Host uptime snapshot', cmd: 'uptime', maxLines: 1 },
  { title: 'Count /tmp entries', cmd: 'ls /tmp 2>/dev/null | wc -l', maxLines: 1 },
];

async function runShell(cmd: string): Promise<{ ok: boolean; text: string }> {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: 5000,
      maxBuffer: 4096,
      shell: '/bin/bash',
    });
    const text = (stdout || stderr || '').trim();
    return { ok: true, text: text.length > 0 ? text : '(no output)' };
  } catch (err: any) {
    const msg = (err?.stderr || err?.stdout || err?.message || 'unknown error').toString().trim();
    return { ok: false, text: msg };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function appendStreamText(client: any, channel: string, ts: string, text: string): Promise<void> {
  await client.chat.appendStream({
    channel,
    ts,
    chunks: [{ type: 'markdown_text', text }],
  });
}

function buildWorkPlan(statuses: readonly TaskStatus[]): Record<string, unknown>[] {
  const tasks = WORK_STEPS.map((step, i) => ({
    type: 'task_card',
    task_id: `w${i}`,
    title: step.title,
    status: statuses[i],
    details: {
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_section',
          elements: [{ type: 'text', text: `$ ${step.cmd}` }],
        },
      ],
    },
  }));
  return [
    {
      type: 'plan',
      title: 'Live agent work',
      tasks,
    },
  ];
}

function workFallbackText(statuses: readonly TaskStatus[]): string {
  return 'Live agent work — ' + statuses.map((s, i) => `w${i}=${s}`).join(' · ');
}

function workSummary(statuses: readonly TaskStatus[]): string {
  const ok = statuses.filter((s) => s === 'complete').length;
  const fail = statuses.filter((s) => s === 'error').length;
  const verdict = fail === 0 ? '✅ All tasks complete.' : `⚠️ ${ok} complete, ${fail} error.`;
  return `${verdict} (${statuses.length} total)`;
}
