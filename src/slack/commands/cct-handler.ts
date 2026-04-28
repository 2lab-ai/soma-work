import { isAdminUser } from '../../admin-utils';
import type { AuthKey } from '../../auth/auth-key';
import type { CctStoreSnapshot, SlotState, UsageSnapshot } from '../../cct-store';
import { config } from '../../config';
import { evaluateAndMaybeRotate, type RotationOutcome } from '../../oauth/auto-rotate';
import { getTokenManager, type TokenSummary } from '../../token-manager';
import { formatRateLimitedAt } from '../../util/format-rate-limited-at';
import { formatUsageBar, formatUsageResetDelta } from '../cct/builder';
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
    // Z3 runtime fence (PR-B phase1): `cct set <name>` / `cct usage <name>`
    // / `cct next` may not target api_key slots — those are store-only in
    // PR-B and their name must not appear in the matching set nor in the
    // "Available slots:" hint. Follow-up issue wires ANTHROPIC_API_KEY
    // spawn isolation and will remove the filter.
    const tokens = tm.listRuntimeSelectableTokens();

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
    } else if (action.action === 'auto') {
      // Manual operator trigger of the #737 auto-rotate evaluator. Force-on:
      // we deliberately ignore `config.autoRotate.enabled` because that env
      // knob gates the *hourly tick*; an operator typing `cct auto` expects
      // an explicit one-shot evaluation regardless. Threshold + max-age
      // mirror the production wiring in `src/index.ts:160-177` so the
      // verdict matches what the next scheduled tick would produce. We do
      // NOT call `notifyAutoRotation` — DEFAULT_UPDATE_CHANNEL publishing
      // is reserved for the hourly path so the operator channel doesn't
      // double-up on manual evaluations.
      const outcome = await evaluateAndMaybeRotate(
        {
          loadSnapshot: () => tm.getSnapshot(),
          applyTokenIfActiveMatches: (target, expected, precond) =>
            tm.applyTokenIfActiveMatches(target, expected, precond),
        },
        {
          enabled: true,
          dryRun: action.dry,
          thresholds: {
            fiveHourMax: config.autoRotate.fiveHourMax,
            sevenDayMax: config.autoRotate.sevenDayMax,
          },
          usageMaxAgeMs: 2 * config.usage.refreshIntervalMs,
        },
      );
      const out = await renderRotationOutcome(outcome);
      await say({ text: out, thread_ts: threadTs });
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
  // M1-S4: the second `{ force? }` argument is optional — `/cct usage` does
  // NOT force-bypass the local throttle. The Slack "Refresh" button and
  // `/cct refresh` (future) are the sole force-paths.
  fetchAndStoreUsage: (keyId: string, opts?: { force?: boolean }) => Promise<UsageSnapshot | null>;
  getActiveToken: () => { keyId: string; name: string; kind: AuthKey['kind'] } | null;
  getSnapshot?: () => Promise<CctStoreSnapshot>;
}

/**
 * Render the `/z cct usage [<name>]` reply.
 *
 * Resolution order:
 *   1. If `target` is provided → match `listRuntimeSelectableTokens().find(s => s.name === target)` (Z3 fence — api_key excluded in PR-B).
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
 * M1-S2: shares the same `formatUsageBar` progress-bar formatter used
 * by the CCT card. Output format:
 *   Usage for *{name}* ({kind})
 *   ```
 *   5h        ██████░░░░ 60% · resets in 3h 12m
 *   7d        ██░░░░░░░░ 20% · resets in 5d 0h 0m
 *   7d-sonnet █░░░░░░░░░ 10% · resets in 5d 0h 0m
 *   ```
 *
 * A monospace code fence preserves the fixed-width label column that
 * `formatUsageBar` relies on for visual alignment.
 */
export function renderUsageLines(
  slot: { name: string; kind: AuthKey['kind'] },
  snapshot: UsageSnapshot,
  nowMs?: number,
): string {
  const now = nowMs ?? Date.now();
  const header = `Usage for *${slot.name}* (${slot.kind})`;
  const rows: string[] = [];
  if (snapshot.fiveHour) {
    rows.push(formatUsageBar(snapshot.fiveHour.utilization, snapshot.fiveHour.resetsAt, now, '5h'));
  }
  if (snapshot.sevenDay) {
    rows.push(formatUsageBar(snapshot.sevenDay.utilization, snapshot.sevenDay.resetsAt, now, '7d'));
  }
  if (snapshot.sevenDaySonnet) {
    rows.push(formatUsageBar(snapshot.sevenDaySonnet.utilization, snapshot.sevenDaySonnet.resetsAt, now, '7d-sonnet'));
  }
  if (rows.length === 0) {
    return `${header}\n_(no usage windows reported — try again after the next fetch)_`;
  }
  return `${header}\n\`\`\`\n${rows.join('\n')}\n\`\`\``;
}

/**
 * Render an ISO-timestamp delta to the same `Δ` shape as the `/cct usage`
 * card. `fallback` controls the string used when the ISO is missing or
 * unparseable — the `/cct usage` "Try again later" path wants `'a bit'`,
 * the `/cct auto` rotation lines want `'—'`.
 */
function formatDurationUntil(isoUtc: string | undefined, opts?: { fallback?: string; nowMs?: number }): string {
  const fallback = opts?.fallback ?? 'a bit';
  if (!isoUtc) return fallback;
  const target = new Date(isoUtc).getTime();
  if (!Number.isFinite(target)) return fallback;
  const now = opts?.nowMs ?? Date.now();
  return formatUsageResetDelta(target - now);
}

// ── #749 Auto-rotate text command renderer ─────────────────────────

/**
 * Format a utilization value (0..100 percent — store SSOT per #685/#781)
 * as `XX.X%`. Mirrors `fmtPct` in `auto-rotate-notifier.ts` — kept
 * inline (rather than imported) to keep the text-only handler
 * independent of the block-kit notifier module's import graph. Pinned
 * by test (`80 → "80.0%"`, `undefined → "—"`).
 */
function pct(util: number | undefined): string {
  if (util === undefined || !Number.isFinite(util)) return '—';
  return `${util.toFixed(1)}%`;
}

/**
 * Best-effort lookup of the active slot's in-flight lease count for the
 * `skipped/active-lease` outcome message. Reads through `loadSnapshotSafe`
 * (which already swallows store errors); if that returns null OR the keyId
 * is missing, fall back to `0` — the operator just gets a less specific
 * "N=0" lease line, never an exception. The slot name also falls back to
 * the keyId in the same path.
 *
 * Why a second snapshot read (the evaluator already loaded one): the
 * `RotationOutcome` discriminant doesn't carry lease-count or slot-name on
 * the `active-lease` branch. Adding those fields would touch every caller
 * of `evaluateAndMaybeRotate`, including the hourly-tick path in `index.ts`.
 * The cct-text command is admin-only and rare, so a second `getSnapshot()`
 * is cheap insurance — not worth the cross-module ripple.
 */
async function leaseCountForActive(activeKeyId: string): Promise<{ count: number; name: string }> {
  const snap = await loadSnapshotSafe();
  if (!snap) return { count: 0, name: activeKeyId };
  const slot = snap.registry.slots.find((s) => s.keyId === activeKeyId);
  const state = snap.state[activeKeyId];
  return {
    count: state?.activeLeases?.length ?? 0,
    name: slot?.name ?? activeKeyId,
  };
}

/** Format the per-slot rejection bullets used by both no-candidate and dry-run/skipped. */
function formatRejectedBullets(rejected: ReadonlyArray<{ keyId: string; name: string; reason: string }>): string {
  return rejected.map((r) => `• ${r.name} (${r.keyId}): rejected (${r.reason})`).join('\n');
}

/**
 * Render the 12-variant outcome of `evaluateAndMaybeRotate` to a single
 * compact thread-only Slack text line (or short bullet list for the
 * `no-candidate` reject breakdown). Mapping is fixed by the #749 plan
 * table — every `RotationOutcome` discriminant must produce a deterministic
 * non-empty string so the operator always sees *something* in the thread.
 */
async function renderRotationOutcome(outcome: RotationOutcome): Promise<string> {
  if (outcome.kind === 'rotated') {
    const fromName = outcome.from?.name ?? '(none)';
    const resets = formatDurationUntil(outcome.to.sevenDayResetsAt, { fallback: '—' });
    const five = pct(outcome.to.fiveHourUtilization);
    const seven = pct(outcome.to.sevenDayUtilization);
    return `:repeat: Auto-rotated *${fromName}* → *${outcome.to.name}* (7d resets ${resets}, 5h ${five} / 7d ${seven})`;
  }

  if (outcome.kind === 'noop') {
    if (outcome.reason === 'active-not-set') {
      return ':warning: No active slot configured';
    }
    const name = outcome.active?.name ?? '(unknown)';
    return `:white_check_mark: Active *${name}* is already optimal — no rotation needed`;
  }

  if (outcome.kind === 'skipped') {
    if (outcome.reason === 'active-lease') {
      const activeKeyId = outcome.debug.activeKeyId;
      if (activeKeyId) {
        const { count, name } = await leaseCountForActive(activeKeyId);
        return `:hourglass: Skipped — active *${name}* has ${count} in-flight lease(s) at last read. Try \`cct auto\` again after the lease drains.`;
      }
      return `:hourglass: Skipped — active slot has in-flight leases. Try \`cct auto\` again after the lease drains.`;
    }
    if (outcome.reason === 'no-candidate') {
      const bullets =
        outcome.debug.rejected.length > 0 ? formatRejectedBullets(outcome.debug.rejected) : '• (no slots evaluated)';
      return `:warning: No eligible candidate. See debug:\n${bullets}`;
    }
    if (outcome.reason === 'disabled') {
      // Defensive — `cct auto` always passes `enabled: true`, so this branch
      // is only reachable if a future caller forgets the override. Surface
      // a message that points the on-call operator at the right surface
      // (the handler's evaluateAndMaybeRotate call site) rather than a
      // generic "report it" line.
      return ':warning: Auto-rotation evaluator returned `disabled` — handler wiring bug, check the `enabled:` arg at the cct-handler call site';
    }
    if (outcome.reason === 'race-active-changed') {
      return ':hourglass: Skipped — active changed under us. Try `cct auto` again.';
    }
    return ':hourglass: Skipped — slot eligibility changed under us. Try `cct auto` again.';
  }

  // dry-run
  if (outcome.would === 'rotate' && outcome.to) {
    const fromName = outcome.from?.name ?? '(none)';
    const resets = formatDurationUntil(outcome.to.sevenDayResetsAt, { fallback: '—' });
    return `:test_tube: [dry-run] Would rotate *${fromName}* → *${outcome.to.name}* (7d resets ${resets})`;
  }
  if (outcome.would === 'noop') {
    const name = outcome.from?.name ?? '(unknown)';
    return `:test_tube: [dry-run] Active *${name}* is already optimal`;
  }
  const bullets = outcome.debug.rejected.length > 0 ? formatRejectedBullets(outcome.debug.rejected) : '';
  return bullets
    ? `:test_tube: [dry-run] No eligible candidate.\n${bullets}`
    : `:test_tube: [dry-run] No eligible candidate.`;
}
