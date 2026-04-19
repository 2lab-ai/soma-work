import { isAdminUser } from '../../admin-utils';
import type { AuthKey } from '../../auth/auth-key';
import type { CctStoreSnapshot, SlotState, UsageSnapshot } from '../../cct-store';
import { getTokenManager, type TokenSummary } from '../../token-manager';
import { formatRateLimitedAt } from '../../util/format-rate-limited-at';
import { CommandParser } from '../command-parser';
import { renderCctCard } from '../z/topics/cct-topic';
import type { CommandContext, CommandHandler, CommandResult } from './types';

/**
 * Handles CCT token management commands (admin only):
 *   - `cct`                 — show token status (Block Kit card)
 *   - `cct set <name>`      — switch active token (text ack)
 *   - `cct next`            — rotate to next available token
 *   - `cct usage [<name>]`  — show per-slot usage snapshot (5h / 7d windows)
 *
 * Forbidden via text (use the `/z cct` card buttons instead):
 *   - `cct add …`           — open the *Add* modal from the card
 *   - `cct rm …` / `remove` — open the *Remove* modal from the card
 *
 * Legacy `set_cct` / `nextcct` underscore aliases were removed in #506.
 */
export class CctHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return CommandParser.isCctCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, text, threadTs, say } = ctx;

    // Admin check
    if (!isAdminUser(user)) {
      await say({
        text: '⛔ Admin only command',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    const action = CommandParser.parseCctCommand(text);
    const tm = getTokenManager();
    const tokens = tm.listTokens();

    // `cct add …` / `cct rm …` are forbidden via text — the modal on the
    // `/z cct` card is the only path for token mutation (ToS ack, split
    // fields, lease drain semantics live there).
    if (action.action === 'add-forbidden') {
      await say({
        text: 'Token add via text is disabled. Open the `/z cct` card and use the *Add* button.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }
    if (action.action === 'rm-forbidden') {
      await say({
        text: 'Token remove via text is disabled. Open the `/z cct` card and use the *Remove* button.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    if (tokens.length === 0) {
      await say({
        text: 'No CCT tokens configured. Set `CLAUDE_CODE_OAUTH_TOKEN_LIST` environment variable.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    if (action.action === 'status') {
      // Render the Block Kit card. The plain-text fallback composes the
      // active slot's rate-limited timestamp via `formatRateLimitedAt`
      // so non-block clients see `YYYY-MM-DD HH:mm KST / HH:mmZ (Nm ago)`.
      const { text: cardFallback, blocks } = await renderCctCard({
        userId: user,
        issuedAt: Date.now(),
      });
      const fallback = await buildStatusTextFallback(cardFallback);
      await say({ text: fallback, blocks, thread_ts: threadTs });
    } else if (action.action === 'next') {
      const result = await tm.rotateToNext();
      if (result) {
        const active = tm.getActiveToken();
        await say({
          text: `🔄 Rotated to next token: *${active?.name ?? result.name}* (${active?.kind ?? 'cct'})`,
          thread_ts: threadTs,
        });
      } else {
        await say({
          text: '⚠️ Only one token available, cannot rotate.',
          thread_ts: threadTs,
        });
      }
    } else if (action.action === 'set') {
      const match = tokens.find((t: TokenSummary) => t.name === action.target);
      if (match) {
        await tm.applyToken(match.keyId);
        const active = tm.getActiveToken();
        await say({
          text: `✅ Active token switched to *${active?.name ?? match.name}* (${active?.kind ?? match.kind})`,
          thread_ts: threadTs,
        });
      } else {
        const available = tokens.map((t: TokenSummary) => `\`${t.name}\``).join(', ');
        await say({
          text: `❌ Unknown token: \`${action.target}\`\nAvailable: ${available}`,
          thread_ts: threadTs,
        });
      }
    } else if (action.action === 'usage') {
      await handleUsage(action.target, tm, tokens, (t) => say({ text: t, thread_ts: threadTs }));
    }

    return { handled: true };
  }
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Compose the plain-text fallback for the `/z cct` status card. When the
 * active slot has a `rateLimitedAt`, append a line rendered with
 * `formatRateLimitedAt` (e.g. `2026-04-18 13:42 KST / 03:42Z (5m ago)`)
 * so terminals / non-block clients still see the three-way timestamp.
 */
async function buildStatusTextFallback(cardFallback: string | undefined): Promise<string> {
  const header = cardFallback ?? '🔑 CCT';
  const snap = await loadSnapshotSafe();
  if (!snap) return header;
  const active = snap.registry.activeKeyId
    ? snap.registry.slots.find((s) => s.keyId === snap.registry.activeKeyId)
    : undefined;
  if (!active) return header;
  const state = snap.state[active.keyId];
  if (!state?.rateLimitedAt) return header;
  const ts = formatRateLimitedAt(state.rateLimitedAt);
  const source = state.rateLimitSource ? ` via ${state.rateLimitSource}` : '';
  return `${header}\nrate-limited ${ts}${source}`;
}

/** Defensive snapshot read through the public `getSnapshot()` API. */
async function loadSnapshotSafe(): Promise<CctStoreSnapshot | null> {
  try {
    return await getTokenManager().getSnapshot();
  } catch {
    return null;
  }
}

interface UsageCapableTokenManager {
  fetchAndStoreUsage: (keyId: string) => Promise<UsageSnapshot | null>;
  getActiveToken: () => { keyId: string; name: string; kind: AuthKey['kind'] } | null;
  getSnapshot?: () => Promise<CctStoreSnapshot>;
}

/**
 * Render the `/z cct usage [<name>]` reply.
 *
 * Resolution order:
 *   1. If `target` is provided → match `listTokens().find(s => s.name === target)`.
 *   2. Otherwise → use `tm.getActiveToken()`.
 *   3. Slot has no OAuth attachment → error: usage API requires an oauth_credentials attachment.
 *   4. `fetchAndStoreUsage()` returns null → backoff-active message with next-fetch hint.
 */
async function handleUsage(
  target: string | undefined,
  tm: unknown,
  tokens: readonly TokenSummary[],
  reply: (text: string) => Promise<unknown>,
): Promise<void> {
  const usageTm = tm as UsageCapableTokenManager;
  let resolved: { keyId: string; name: string; kind: AuthKey['kind'] } | null;
  if (target) {
    const match = tokens.find((t) => t.name === target);
    if (!match) {
      await reply(`❌ Unknown slot: ${target}`);
      return;
    }
    resolved = { keyId: match.keyId, name: match.name, kind: match.kind };
  } else {
    resolved = usageTm.getActiveToken();
    if (!resolved) {
      await reply('❌ No active slot configured.');
      return;
    }
  }

  // Usage endpoint requires an OAuth access token. Inspect the persisted
  // slot to see whether it currently carries an oauthAttachment.
  const snap = await loadSnapshotSafe();
  const slot = snap?.registry.slots.find((s) => s.keyId === resolved!.keyId);
  const hasOAuthAttachment = slot !== undefined && slot.kind === 'cct' && slot.oauthAttachment !== undefined;
  if (!hasOAuthAttachment) {
    await reply(
      `⚠️ Usage API requires an OAuth attachment. *${resolved.name}* has no oauth_credentials attached — cannot query /api/oauth/usage.`,
    );
    return;
  }

  const snapshot = await usageTm.fetchAndStoreUsage(resolved.keyId);
  if (!snapshot) {
    // Backoff active, or fetch-failed — try to render the next-fetch hint.
    const state = await loadSlotState(resolved.keyId);
    const waitHint = state?.nextUsageFetchAllowedAt ? formatDurationUntil(state.nextUsageFetchAllowedAt) : 'a bit';
    await reply(`⚠️ Usage not available yet — next fetch in ${waitHint}. Try again later.`);
    return;
  }

  const lines = renderUsageLines(resolved, snapshot);
  await reply(lines);
}

async function loadSlotState(keyId: string): Promise<SlotState | undefined> {
  const snap = await loadSnapshotSafe();
  return snap?.state[keyId];
}

/**
 * Render the Slack message body for a usage snapshot.
 *
 * Format:
 *   Usage for *{name}* ({kind})
 *   • 5h: {pct}% (resets in {T})
 *   • 7d: {pct}% (resets in {T})
 */
export function renderUsageLines(
  slot: { name: string; kind: AuthKey['kind'] },
  snapshot: UsageSnapshot,
  nowMs?: number,
): string {
  const now = nowMs ?? Date.now();
  const lines: string[] = [`Usage for *${slot.name}* (${slot.kind})`];
  if (snapshot.fiveHour) {
    const pct = toPctInt(snapshot.fiveHour.utilization);
    const reset = formatDurationDelta(new Date(snapshot.fiveHour.resetsAt).getTime() - now);
    lines.push(`• 5h: ${pct}% (resets in ${reset})`);
  }
  if (snapshot.sevenDay) {
    const pct = toPctInt(snapshot.sevenDay.utilization);
    const reset = formatDurationDelta(new Date(snapshot.sevenDay.resetsAt).getTime() - now);
    lines.push(`• 7d: ${pct}% (resets in ${reset})`);
  }
  if (snapshot.sevenDaySonnet) {
    const pct = toPctInt(snapshot.sevenDaySonnet.utilization);
    const reset = formatDurationDelta(new Date(snapshot.sevenDaySonnet.resetsAt).getTime() - now);
    lines.push(`• 7d (sonnet): ${pct}% (resets in ${reset})`);
  }
  if (lines.length === 1) {
    lines.push('_(no usage windows reported — try again after the next fetch)_');
  }
  return lines.join('\n');
}

/**
 * UsageSnapshot.utilization is observed to arrive in two shapes depending
 * on the upstream endpoint version:
 *   - 0..1 float (current `/api/oauth/usage` schema) — multiply by 100.
 *   - 0..100 integer (historical) — pass through.
 */
function toPctInt(utilization: number | undefined): number {
  if (utilization === undefined || !Number.isFinite(utilization)) return 0;
  const scaled = utilization <= 1 ? utilization * 100 : utilization;
  return Math.max(0, Math.round(scaled));
}

/** Render a positive ms duration as `Hh Mm` / `Mm` / `<1m`. */
function formatDurationDelta(deltaMs: number): string {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return '<1m';
  const totalMin = Math.floor(deltaMs / 60_000);
  if (totalMin < 1) return '<1m';
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatDurationUntil(isoUtc: string, nowMs?: number): string {
  const target = new Date(isoUtc).getTime();
  if (!Number.isFinite(target)) return 'a bit';
  const now = nowMs ?? Date.now();
  return formatDurationDelta(target - now);
}
