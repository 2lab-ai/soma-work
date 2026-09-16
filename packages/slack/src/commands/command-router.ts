import { Logger } from '@soma/common/logger';
import { CommandParser } from '../command-parser';
import { isSlashForbidden, SLASH_FORBIDDEN_MESSAGE } from '../z/capability';
import { stripZPrefix } from '../z/normalize';
import { parseTopic, translateToLegacy } from '../z/router';

export interface CommandContext {
  user: string;
  channel: string;
  threadTs: string;
  text: string;
  say: SayFn;
  triggerId?: string;
  postEphemeral?: PostEphemeralFn;
  /**
   * When true, a forced `$skill` invocation must NOT post its banner or bake
   * its `<invoked_skills>` block into `continueWithPrompt` during routing.
   * Instead it returns the banner + block as `deferredSkillFire` so the caller
   * (slack-handler) can fire it AFTER session init / autogoal / autoskill on a
   * fresh-context start. Set for brand-new sessions and `new`-reset remainders.
   */
  deferSkillFire?: boolean;
}

/**
 * A forced `$skill` invocation that was deferred (see {@link CommandContext.deferSkillFire}).
 * The block is byte-identical to what `SkillForceHandler` would otherwise have
 * appended to `continueWithPrompt`; the banner is the RPG attachment it would
 * have posted. The caller posts the banner and appends the block last.
 */
export interface DeferredSkillFire {
  keys: string[];
  invokedBlock: string;
  banner: { text: string; color: string };
}

export interface CommandDependencies {
  [key: string]: any;
}

export interface CommandResult {
  handled: boolean;
  error?: string;
  continueWithPrompt?: string;
  forceWorkflow?: any;
  /**
   * Issue #1082 T1: objective parsed from a `goal <objective>` set-form that
   * arrived with NO active session. Rides out-of-band alongside
   * `continueWithPrompt` so slack-handler can apply the goal to the freshly
   * created session BEFORE the first dispatch.
   */
  setGoalObjective?: string;
  /**
   * Set when a forced `$skill` was deferred (ctx.deferSkillFire). slack-handler
   * posts the banner and appends the block AFTER autogoal + autoskill on a
   * fresh-context start. When present, `continueWithPrompt` holds the RAW
   * instruction text (no `<invoked_skills>` block).
   */
  deferredSkillFire?: DeferredSkillFire;
}

export type SayFn = (message: {
  text: string;
  thread_ts?: string;
  blocks?: any[];
  attachments?: any[];
}) => Promise<{ ts?: string; channel?: string }>;

export type PostEphemeralFn = (message: { text: string; blocks?: any[] }) => Promise<void>;

export interface CommandHandler {
  canHandle(text: string, userId?: string): boolean;
  execute(ctx: CommandContext): Promise<CommandResult>;
}

export interface CommandRouterHandlers {
  handlers: CommandHandler[];
  newHandler: CommandHandler;
  skillForceHandler: CommandHandler;
  goalHandler?: CommandHandler;
  /**
   * Active-session probe used by the `goal` + `$skill` preprocessor. Required
   * whenever `goalHandler` is supplied — without it, the preprocessor would
   * unconditionally intercept `goal foo $skill` on threads with no session,
   * silently drop the `$skill` suffix, and emit "No active session". When the
   * probe returns false the preprocessor falls through to the main handler
   * loop so `SkillForceHandler` picks up the full text.
   *
   * Default when omitted: `false`. A composition root that wires `goalHandler`
   * but forgets this probe gets "no preprocessor", not "preprocessor swallows
   * the skill" — failure mode chosen on the side of letting the user's
   * `$skill` actually run.
   */
  hasActiveSession?: (channel: string, threadTs: string) => boolean;
}

export interface CommandRouterProviders {
  createHandlers?: (deps: CommandDependencies) => CommandRouterHandlers;
}

const providers: Required<CommandRouterProviders> = {
  createHandlers: () => {
    throw new Error('CommandRouter handler provider is not configured.');
  },
};

export function setCommandRouterProviders(next: CommandRouterProviders): void {
  if (next.createHandlers) providers.createHandlers = next.createHandlers;
}

/**
 * Routes command text to concrete handlers supplied by the app composition root.
 */
export class CommandRouter {
  private logger = new Logger('CommandRouter');
  private handlers: CommandHandler[];
  private newHandler: CommandHandler;
  private skillForceHandler: CommandHandler;
  private goalHandler?: CommandHandler;
  private hasActiveSession?: (channel: string, threadTs: string) => boolean;

  constructor(deps: CommandDependencies) {
    const wired = providers.createHandlers(deps);
    this.handlers = wired.handlers;
    this.newHandler = wired.newHandler;
    this.skillForceHandler = wired.skillForceHandler;
    this.goalHandler = wired.goalHandler;
    this.hasActiveSession = wired.hasActiveSession;
  }

  /**
   * Maximum `new` re-route chain depth. Each `new` consumes its leading
   * token so the recursion is structurally terminating; the cap only bounds
   * the Slack side effects (every `new` posts a reset confirmation), e.g. a
   * pathological `new new new … ×100` message must not fan out into 100
   * chat.postMessage calls. Past the cap the remainder degrades to the old
   * behavior: delivered to the model as a plain prompt.
   */
  private static readonly MAX_NEW_CHAIN_DEPTH = 5;

  async route(ctx: CommandContext, depth = 0): Promise<CommandResult> {
    const { say, threadTs } = ctx;
    const originalText = ctx.text;

    if (!originalText) {
      return { handled: false };
    }

    const zPrefixRemainder = stripZPrefix(originalText.trim());
    if (zPrefixRemainder !== null) {
      if (!zPrefixRemainder) {
        await say({ text: CommandParser.getHelpMessage(), thread_ts: threadTs });
        return { handled: true };
      }
      if (ctx.threadTs === ctx.channel) {
        const { topic, verb, arg } = parseTopic(zPrefixRemainder);
        if (topic && isSlashForbidden(topic, verb, arg)) {
          await say({ text: SLASH_FORBIDDEN_MESSAGE, thread_ts: threadTs });
          return { handled: true };
        }
      }
      ctx.text = translateToLegacy(zPrefixRemainder);
    }

    const routedText = ctx.text ?? originalText;

    if (CommandParser.isNewCommand(routedText)) {
      const newResult = await this.newHandler.execute(ctx);
      if (newResult.continueWithPrompt === undefined) {
        return newResult;
      }
      const remainder = newResult.continueWithPrompt;

      // Re-route the remainder as if the user had typed it directly after
      // the reset. `new goal <objective>` must actually set the goal,
      // `new new <prompt>` must reset again, `new $skill …` must inject the
      // skill block — command semantics survive the `new` prefix instead of
      // degrading into a plain prompt (the old narrow-scope contract only
      // composed `$skill` and silently dropped every other command; see the
      // `new goal …` bug report).
      if (depth < CommandRouter.MAX_NEW_CHAIN_DEPTH) {
        // A `new` reset always starts a fresh context, so any `$skill` in the
        // remainder must be DEFERRED (fired after session init / autogoal /
        // autoskill), even when the pre-route session still had a sessionId.
        const rerouted = await this.route({ ...ctx, text: remainder, deferSkillFire: true }, depth + 1);
        if (rerouted.handled) {
          return rerouted;
        }
      }

      // Remainder is not a command (or chain depth exhausted) — deliver it
      // to the model as the post-reset prompt.
      return newResult;
    }

    // Goal + skill split (e.g. `goal set X $z foo`): set the goal on the
    // clean prefix, then dispatch the `$skill` suffix through
    // SkillForceHandler so the same turn carries the `<invoked_skills>`
    // block. Gated on `hasActiveSession` — GoalHandler needs a session to
    // do anything useful; without one it would emit "No active session" and
    // drop the skill suffix on the floor (the user's actual intent is to
    // fire the skill, so we let the main handler loop pick up the full
    // text instead).
    if (this.goalHandler && CommandParser.isGoalCommand(routedText)) {
      const skillRefPattern = /\$[\w-]+(?::[\w-]+)?/g;
      let split: { goalText: string; skillText: string } | null = null;
      let skillMatch = skillRefPattern.exec(routedText);
      while (skillMatch !== null) {
        if (this.skillForceHandler.canHandle(skillMatch[0], ctx.user)) {
          split = {
            goalText: routedText.slice(0, skillMatch.index).trim(),
            skillText: routedText.slice(skillMatch.index).trim(),
          };
          break;
        }
        skillMatch = skillRefPattern.exec(routedText);
      }

      // Default: assume no session. Composition roots that wire `goalHandler`
      // must wire `hasActiveSession` to opt into the preprocessor.
      const sessionActive = this.hasActiveSession?.(ctx.channel, ctx.threadTs) ?? false;
      if (split && sessionActive) {
        const goalResult = await this.goalHandler.execute({ ...ctx, text: split.goalText });
        if (goalResult.continueWithPrompt === undefined) {
          return goalResult;
        }
        if (this.skillForceHandler.canHandle(split.skillText, ctx.user)) {
          const skillResult = await this.skillForceHandler.execute({ ...ctx, text: split.skillText });
          if (skillResult.handled) {
            return skillResult;
          }
        }
        return goalResult;
      }

      // Issue #1082 T1: NO session yet, but the message still composes
      // `goal <objective>` + `$skill`. When the prefix parses as a SET form,
      // run GoalHandler on the clean prefix — it validates the objective and
      // declines with `setGoalObjective` (there is no session to mutate) —
      // then route ONLY the `$skill` suffix through SkillForceHandler so the
      // `goal …` phrasing never leaks into the model turn. The objective rides
      // out-of-band on the final result for slack-handler to apply right after
      // session init. Non-set prefixes (e.g. bare `goal $skill …`) keep the
      // old behavior: the main handler loop sees the full text and
      // SkillForceHandler picks it up.
      if (split && !sessionActive && CommandParser.parseGoalCommand(split.goalText).action === 'set') {
        const goalResult = await this.goalHandler.execute({ ...ctx, text: split.goalText });
        if (goalResult.handled) {
          // Objective failed validation — GoalHandler already posted the ⚠️;
          // consume the message instead of leaking it into session init.
          return goalResult;
        }
        const setGoalObjective = goalResult.setGoalObjective;
        if (this.skillForceHandler.canHandle(split.skillText, ctx.user)) {
          const skillResult = await this.skillForceHandler.execute({ ...ctx, text: split.skillText });
          if (skillResult.handled) {
            return { ...skillResult, setGoalObjective };
          }
        }
        return { handled: false, setGoalObjective };
      }
    }

    // Issue #1082 T1: a handler may decline while still carrying the parsed
    // goal objective (GoalHandler's no-session set form falls through so the
    // text reaches session init). Stash it so the final fall-through result
    // preserves it for slack-handler to apply post session-init.
    let fallThroughGoalObjective: string | undefined;
    for (const handler of this.handlers) {
      if (handler.canHandle(routedText, ctx.user)) {
        this.logger.debug('Routing to handler', {
          handler: handler.constructor.name,
          text: routedText.substring(0, 50),
        });

        try {
          const result = await handler.execute(ctx);
          if (result.handled) {
            return result;
          }
          if (result.setGoalObjective !== undefined) {
            fallThroughGoalObjective = result.setGoalObjective;
          }
        } catch (error: any) {
          this.logger.error('Error executing command handler', {
            handler: handler.constructor.name,
            error: error.message,
          });
          // 2026-07-09 incident guard: this text was CLAIMED by a handler
          // (canHandle → true), so a crash must CONSUME the message — never
          // let the raw command text fall through to session init, where
          // autogoal promoted the literal string `goal` into a session goal
          // after GoalHandler died on a Slack `invalid_blocks` error. Surface
          // the failure visibly instead.
          try {
            await say({
              text: `⚠️ \`${routedText.trim().split(/\s+/)[0]}\` 명령 처리 중 오류가 발생했습니다 (${handler.constructor.name}): ${error.message}`,
              thread_ts: threadTs,
            });
          } catch {
            // Error notice is best-effort — the command is consumed either way.
          }
          return { handled: true, error: error.message };
        }
      }
    }

    const { isPotential, keyword } = CommandParser.isPotentialCommand(routedText);
    if (isPotential) {
      this.logger.debug('Unrecognized potential command', { keyword, text: routedText.substring(0, 50) });
      await say({
        text: `❓ \`${keyword}\` 명령어를 인식할 수 없습니다. \`help\`를 입력하여 사용 가능한 명령어를 확인하세요.`,
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    // Issue #1082 T1: keep the carried objective on the unhandled result so
    // the new session is born with the goal already active.
    return fallThroughGoalObjective !== undefined
      ? { handled: false, setGoalObjective: fallThroughGoalObjective }
      : { handled: false };
  }

  /**
   * Would {@link route} CONSUME this text instead of letting it reach the model?
   *
   * Pure classification: no handler is executed, nothing is said, no session is
   * touched. The follow-up ingress (`.prd/slack-agent-ui/ssot.md` §3.1) asks
   * this while a turn is running to tell a *control* (which must keep working
   * live) from an *instruction* (which must be queued verbatim). It reuses the
   * SAME handler instances and the same `canHandle` predicates as `route`, so
   * there is no second command registry to drift.
   *
   * `user` matters: several handlers are admin-gated inside `canHandle`
   * (`AdminHandler`, `PromptHandler`, …). Omitting it would classify an
   * admin-only command as a plain instruction for everyone.
   *
   * Three deliberate distinctions:
   *
   *  1. `%model <v> <instruction>` / `%nogoal <instruction>` — a directive with
   *     a remainder is the user's TURN carrying a session directive (see
   *     `slack-handler.ts:454-501`, which strips the directive and dispatches
   *     the remainder). It must be queued RAW, so it is not a command here.
   *     A directive with no remainder (bare `%model x`, bare `%nogoal`, bare
   *     `%`) stays a control.
   *  2. `/z …` is normalized exactly as `route` does (`:149-163`) before the
   *     handler probe, so `/z new`-style invocations classify like their legacy
   *     form. Bare `/z` prints help — a control.
   *  3. `isPotentialCommand` mirrors `:308-316`: that text is answered and
   *     consumed by the router, so queueing it would park a message the router
   *     will never dispatch.
   */
  isCommand(text: string, user?: string): boolean {
    return this.classifyText(text, user) !== 'instruction';
  }

  /**
   * Ingress classification for the follow-up queue. Three kinds, because two
   * are not enough:
   *
   *  - `instruction` — the user's turn. Queue it verbatim while a turn runs.
   *  - `control` — answered immediately and consumed; it never starts a model
   *    turn (`help`, `cwd`, `%model x`, `sessions`, a `/z` card). Safe to run
   *    live: it cannot supersede the running request.
   *  - `control-with-dispatch` — a command that ALSO starts a turn
   *    (`new <prompt>`, `goal <objective>`, a forced `$skill`, `onboarding` /
   *    `renew` / `compact`). Running it live while a turn is in flight would
   *    supersede that turn through the session initializer
   *    (`session-initializer.ts:1368-1401`), which is exactly what the queue
   *    exists to prevent — so the host queues it and lets it re-route at the
   *    next safe boundary with its text intact.
   *
   * The `control-with-dispatch` set is a declared list, not a probe: the only
   * way to know for certain whether a handler returns `continueWithPrompt` is
   * to EXECUTE it, and executing is precisely what a classifier must not do.
   * A command missing from the list degrades to today's behavior (it runs
   * live), never to a lost message.
   */
  classifyText(text: string, user?: string): 'instruction' | 'control' | 'control-with-dispatch' {
    const trimmed = (text ?? '').trim();
    if (!trimmed) return 'instruction';

    // `%model <v> <instruction>` / `%nogoal <instruction>`: the remainder is
    // the user's turn (`slack-handler.ts:454-501` strips the directive and
    // dispatches it), so the whole message must be queued RAW. A directive with
    // no remainder is a plain control.
    const directives = CommandParser.parseInlineSessionDirectives(trimmed);
    if (directives) {
      // A directive with NO remainder is answered and consumed by the handler
      // (`slack-handler.ts:466-475` posts the usage hint and stops), so it is a
      // control even when no handler's `canHandle` claims the text.
      return directives.remainder === '' ? 'control' : 'instruction';
    }

    const zPrefixRemainder = stripZPrefix(trimmed);
    if (zPrefixRemainder !== null && !zPrefixRemainder) return 'control'; // bare `/z` → help card
    const routedText = zPrefixRemainder !== null ? translateToLegacy(zPrefixRemainder) : trimmed;
    if (!routedText) return 'instruction';

    if (CommandParser.isNewCommand(routedText)) {
      // `new` alone resets and answers; `new <prompt>` resets AND dispatches.
      return CommandParser.parseNewCommand(routedText).prompt ? 'control-with-dispatch' : 'control';
    }
    if (CommandParser.isGoalCommand(routedText)) {
      // Only the SET form continues into a turn (`slack-handler.ts:686-724`);
      // `goal status|pause|resume|done|clear` answer and stop.
      return CommandParser.parseGoalCommand(routedText).action === 'set' ? 'control-with-dispatch' : 'control';
    }
    if (this.skillForceHandler.canHandle(routedText, user)) return 'control-with-dispatch';
    if (CommandRouter.DISPATCHING_COMMAND_ROOTS.test(routedText)) return 'control-with-dispatch';

    if (this.handlers.some((handler) => handler.canHandle(routedText, user))) return 'control';
    return CommandParser.isPotentialCommand(routedText).isPotential ? 'control' : 'instruction';
  }

  /**
   * Commands that hand a prompt to the model after doing their own work
   * (host-built continuations). Kept next to {@link classifyText} so the list
   * and its rationale cannot drift apart.
   */
  private static readonly DISPATCHING_COMMAND_ROOTS = /^\/?(?:onboarding|renew|compact)\b/i;
}
