/**
 * `ZRouter` — dispatches a normalized `/z` invocation.
 *
 * Responsibilities:
 *  1. Empty remainder → show help card (buildHelpCard).
 *  2. Legacy naked (multi-word) → show tombstone card (once per user) + drop.
 *  3. `/z <topic> …` → translate to legacy syntax and hand off to CommandRouter.
 *     - SLASH_FORBIDDEN topic/verb combos are rejected on slash with a hint
 *       to use DM / channel thread.
 *  4. Whitelisted naked (session/new/renew/$…) → direct passthrough to
 *     CommandRouter.
 *
 * The router never talks to Slack directly — all output goes through the
 * `ZRespond` surface attached to the invocation.
 */

import { Logger } from '../../logger';
import type { CommandContext, SayFn } from '../commands/types';
import { isSlashForbidden, SLASH_FORBIDDEN_MESSAGE } from './capability';
import { detectLegacyNaked } from './tombstone';
import type { ZInvocation } from './types';
import { buildHelpCard, buildTombstoneCard } from './ui-builder';

const logger = new Logger('ZRouter');

export interface LegacyCommandRouter {
  route(ctx: CommandContext): Promise<{ handled: boolean; continueWithPrompt?: string; error?: string }>;
}

export interface TombstoneStore {
  /** Returns true if the hint was freshly marked; false if already shown. */
  markMigrationHintShown(userId: string): Promise<boolean>;
  hasMigrationHintShown(userId: string): boolean;
}

export interface ZRouterDeps {
  legacyRouter: LegacyCommandRouter;
  tombstoneStore: TombstoneStore;
}

export interface ZDispatchResult {
  handled: boolean;
  /** Prompt to continue the pipeline with (e.g. `/z new <prompt>`). */
  continueWithPrompt?: string;
  /** If true, the caller should treat the input as a no-op (tombstone shown etc.). */
  consumed?: boolean;
  error?: string;
}

export class ZRouter {
  constructor(private deps: ZRouterDeps) {}

  async dispatch(inv: ZInvocation): Promise<ZDispatchResult> {
    // 1. Whitelisted naked — passthrough.
    if (inv.whitelistedNaked) {
      return this.routeToLegacy(inv, inv.remainder);
    }

    // 2. Legacy naked — tombstone hint.
    if (inv.isLegacyNaked) {
      await this.handleTombstone(inv);
      return { handled: true, consumed: true };
    }

    // 3. `/z` invocation (remainder may be empty).
    const remainder = inv.remainder.trim();
    if (!remainder) {
      await inv.respond.send({
        text: 'Available /z commands',
        blocks: buildHelpCard({ issuedAt: Date.now() }),
        ephemeral: true,
      });
      return { handled: true, consumed: true };
    }

    // Parse topic / verb / arg for slash-forbidden check.
    const { topic, verb, arg } = parseTopic(remainder);
    if (inv.source === 'slash' && isSlashForbidden(topic, verb, arg)) {
      await inv.respond.send({ text: SLASH_FORBIDDEN_MESSAGE, ephemeral: true });
      return { handled: true, consumed: true };
    }

    // Translate `/z <topic> [verb] [...]` → legacy text.
    const legacy = translateToLegacy(remainder);
    return this.routeToLegacy(inv, legacy);
  }

  private async handleTombstone(inv: ZInvocation): Promise<void> {
    const hint = detectLegacyNaked(inv.remainder);
    if (!hint) {
      // Shouldn't happen — isLegacyNaked should ensure a hint exists.
      return;
    }

    // CAS-style mark: first caller for this user wins.
    const freshlyMarked = await this.deps.tombstoneStore.markMigrationHintShown(inv.userId);
    if (!freshlyMarked) {
      logger.debug('Tombstone already shown for user, suppressing', { userId: inv.userId });
      return;
    }

    await inv.respond.send({
      text: `ℹ️ \`${hint.oldForm}\`은 더 이상 사용되지 않습니다. 대신 \`${hint.newForm}\`을 사용해주세요.`,
      blocks: buildTombstoneCard({ hint, issuedAt: Date.now() }),
      ephemeral: true,
    });
  }

  private async routeToLegacy(inv: ZInvocation, text: string): Promise<ZDispatchResult> {
    const sayFn: SayFn = async (message) => {
      await inv.respond.send({
        text: message.text,
        blocks: message.blocks,
        ephemeral: inv.source !== 'dm',
      });
      return {};
    };

    const ctx: CommandContext = {
      user: inv.userId,
      channel: inv.channelId,
      threadTs: inv.threadTs ?? inv.channelId, // slash: no thread; use channel as placeholder.
      text,
      say: sayFn,
    };

    try {
      const result = await this.deps.legacyRouter.route(ctx);
      return { handled: result.handled, continueWithPrompt: result.continueWithPrompt, error: result.error };
    } catch (err) {
      logger.error('routeToLegacy failed', { err: (err as Error).message });
      return { handled: false, error: (err as Error).message };
    }
  }
}

/**
 * Parse a normalized `/z` remainder into topic / verb / arg.
 *
 * Topic aliases (back-compat):
 *  - `plugins` → `plugin`
 *  - `skills` → `skill`
 *  - `sessions` → `session`
 *
 * Whitespace is collapsed; underscores inside topic are not accepted (§7-5).
 */
export function parseTopic(remainder: string): { topic: string; verb?: string; arg?: string } {
  const trimmed = remainder.trim().replace(/\s+/g, ' ');
  if (!trimmed) return { topic: '' };
  const parts = trimmed.split(' ');
  let topic = parts[0].toLowerCase();
  if (topic === 'plugins') topic = 'plugin';
  else if (topic === 'skills') topic = 'skill';
  else if (topic === 'sessions') topic = 'session';
  const verb = parts[1]?.toLowerCase();
  const arg = parts[2]?.toLowerCase();
  return { topic, verb, arg };
}

/**
 * Translate a `/z <topic> [verb] [args...]` remainder into legacy naked
 * syntax understood by the current CommandRouter.
 *
 * This is intentionally pragmatic — Phase 1 keeps all legacy handlers
 * working, so we just need to bridge the new noun-verb surface to the old
 * verb-noun / legacy syntaxes. Phase 2 will migrate handlers to accept
 * native `/z` syntax directly.
 */
export function translateToLegacy(remainder: string): string {
  const trimmed = remainder.trim().replace(/\s+/g, ' ');
  if (!trimmed) return trimmed;

  const lower = trimmed.toLowerCase();

  // help / empty → help
  if (/^help$/.test(lower)) return 'help';

  // prompt / instructions → legacy `show prompt` / `show instructions`
  if (/^prompt$/.test(lower)) return 'show prompt';
  if (/^instructions?$/.test(lower)) return 'show instructions';

  // email → show email / set email <x>
  const emailSet = trimmed.match(/^email\s+set\s+(\S+)$/i);
  if (emailSet) return `set email ${emailSet[1]}`;
  if (/^email$/i.test(trimmed)) return 'show email';

  // verbosity set <l> → verbosity <l>
  const verbositySet = trimmed.match(/^verbosity\s+set\s+(\S+)$/i);
  if (verbositySet) return `verbosity ${verbositySet[1]}`;

  // bypass set on|off → bypass on|off
  const bypassSet = trimmed.match(/^bypass\s+set\s+(\S+)$/i);
  if (bypassSet) return `bypass ${bypassSet[1]}`;

  // sandbox set on|off → sandbox on|off
  const sandboxSet = trimmed.match(/^sandbox\s+set\s+(on|off|true|false|enable|disable|status)$/i);
  if (sandboxSet) return `sandbox ${sandboxSet[1]}`;
  const sandboxNetSet = trimmed.match(/^sandbox\s+network\s+set\s+(on|off|true|false|enable|disable|status)$/i);
  if (sandboxNetSet) return `sandbox network ${sandboxNetSet[1]}`;

  // notify set on|off → notify on|off
  const notifySet = trimmed.match(/^notify\s+set\s+(on|off|status)$/i);
  if (notifySet) return `notify ${notifySet[1]}`;
  // notify telegram set <token> → notify telegram <token>
  const notifyTelegramSet = trimmed.match(/^notify\s+telegram\s+set\s+(.+)$/i);
  if (notifyTelegramSet) return `notify telegram ${notifyTelegramSet[1]}`;

  // webhook add|remove|test <x> → webhook register|remove|test <x>
  const webhookAdd = trimmed.match(/^webhook\s+add\s+(.+)$/i);
  if (webhookAdd) return `webhook register ${webhookAdd[1]}`;

  // mcp list → mcp (info), mcp reload → mcp reload
  if (/^mcp$/i.test(trimmed)) return 'mcp';
  if (/^mcp\s+(?:list|info|status)$/i.test(trimmed)) return 'mcp list';

  // plugin[s] … → plugins …
  const pluginMatch = trimmed.match(/^plugins?(?:\s+(.+))?$/i);
  if (pluginMatch) {
    const rest = pluginMatch[1] ?? '';
    return rest ? `plugins ${rest}` : 'plugins';
  }

  // skill[s] … → skills …
  const skillMatch = trimmed.match(/^skills?(?:\s+(.+))?$/i);
  if (skillMatch) {
    const rest = skillMatch[1] ?? '';
    return rest ? `skills ${rest}` : 'skills';
  }

  // cwd set <p> → cwd <p> (cwd-handler legacy form)
  const cwdSet = trimmed.match(/^cwd\s+set\s+(.+)$/i);
  if (cwdSet) return `cwd ${cwdSet[1]}`;

  // cct set <n> → set_cct <n>
  const cctSet = trimmed.match(/^cct\s+set\s+(\S+)$/i);
  if (cctSet) return `set_cct ${cctSet[1]}`;
  if (/^cct\s+next$/i.test(trimmed)) return 'nextcct';

  // admin subcommands
  // admin accept <@U> → accept <@U>
  const adminAccept = trimmed.match(/^admin\s+accept\s+(.+)$/i);
  if (adminAccept) return `accept ${adminAccept[1]}`;
  const adminDeny = trimmed.match(/^admin\s+deny\s+(.+)$/i);
  if (adminDeny) return `deny ${adminDeny[1]}`;
  if (/^admin\s+users$/i.test(trimmed)) return 'users';
  // admin session list → all_sessions
  if (/^admin\s+session(?:s)?\s+list$/i.test(trimmed)) return 'all_sessions';
  // admin config → config show / admin config set KEY VAL → config KEY=VAL
  if (/^admin\s+config$/i.test(trimmed)) return 'config show';
  const adminConfigSet = trimmed.match(/^admin\s+config\s+set\s+(\S+)\s+(.+)$/i);
  if (adminConfigSet) return `config ${adminConfigSet[1]}=${adminConfigSet[2]}`;
  // admin llmchat → show llm_chat / admin llmchat set <p> <k> <v> / admin llmchat reset
  if (/^admin\s+llmchat$/i.test(trimmed)) return 'show llm_chat';
  const llmChatSet = trimmed.match(/^admin\s+llmchat\s+set\s+(\S+)\s+(\S+)\s+(.+)$/i);
  if (llmChatSet) return `set llm_chat ${llmChatSet[1]} ${llmChatSet[2]} ${llmChatSet[3]}`;
  if (/^admin\s+llmchat\s+reset$/i.test(trimmed)) return 'reset llm_chat';

  // session set <attr> <v> → $<attr> <v>
  const sessionSet = trimmed.match(/^session\s+set\s+(\S+)\s+(.+)$/i);
  if (sessionSet) return `$${sessionSet[1]} ${sessionSet[2]}`;

  // Everything else: pass-through. The translator is additive — it does not
  // reject unknown topics; the downstream CommandRouter will do that.
  return trimmed;
}
