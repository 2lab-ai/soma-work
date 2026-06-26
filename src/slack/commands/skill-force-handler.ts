import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA_DIR, PLUGINS_DIR } from '../../env-paths';
import { Logger } from '../../logger';
import { isSafePathSegment } from '../../path-utils';
import { extractCopiedFrom } from '../../user-skill-frontmatter';
import { ToolFormatter } from '../tool-formatter';
import type { CommandContext, CommandHandler, CommandResult } from './types';
import { resolveUserIdentifier, type UserResolver } from './user-identity-resolver';

/**
 * LOCAL_SKILLS_DIR: resolves to dist/local/skills at runtime.
 * __dirname at runtime = dist/slack/commands/ → ../../local/skills
 */
const LOCAL_SKILLS_DIR = path.resolve(__dirname, '..', '..', 'local', 'skills');

/** Max recursion depth to prevent infinite loops in skill references. */
const MAX_DEPTH = 10;

/**
 * Regex to find $plugin:skillname patterns in text.
 * Matches: $local:z, $stv:new-task, $superpowers:brainstorming, etc.
 */
const SKILL_REF_PATTERN = /\$([\w-]+):([\w-]+)/g;

/**
 * Regex to find bare $skillname patterns (no plugin prefix).
 * Matches: $z, $zcheck, $learn — namespace resolved via fallback chain.
 * Negative lookahead prevents matching the plugin part of $plugin:skill.
 */
const BARE_SKILL_PATTERN = /\$([\w-]+)(?![\w-]*:)/g;

/**
 * Cross-user forced invocation via Slack MENTION markup: `$<@UID>:skill` (S3).
 *
 * When a user types `$@Zhuge:deploy`, Slack rewrites `@Zhuge` to `<@U094…>` in
 * the delivered text, so the bare/qualified patterns above (which only accept
 * `[\w-]`) can't see it. This pattern captures the embedded uid directly — no
 * directory lookup needed. An optional `|label` segment (Slack's hydrated
 * display label) is tolerated and discarded.
 */
const CROSS_USER_MENTION_PATTERN = /\$<@([A-Z0-9]+)(?:\|[^>]*)?>:([\w-]+)/g;

/**
 * Soft (no-`$`) cross-user use via natural language: `{user}:{skill}` (S2).
 *
 * Deliberately conservative (codex verdict D3): the token must sit on a
 * whitespace/start boundary, the skill must be a kebab name terminated by
 * whitespace / end / light punctuation, AND — enforced by the caller — the
 * user must resolve to a real uid whose skill exists on disk. This keeps
 * ordinary colon text (`TODO: fix`, `note:something`, `10:30`) from being
 * intercepted. The `(?:^|\s)` anchor also excludes `$`-prefixed forms, which
 * the force path owns.
 *
 * Token forms: `<@UID>` mention markup, a `@name` / bare display name, or a uid.
 */
const SOFT_CROSS_USER_PATTERN = /(?:^|\s)(<@[A-Z0-9]+(?:\|[^>]*)?>|@?[\w.-]+):([a-z0-9][a-z0-9-]*)(?=\s|$|[.,!?)])/g;

/** Slack id shape used to short-circuit a bare uid token to itself. */
const UID_SHAPE = /^[UWB][A-Z0-9]{6,}$/;
/** Slack mention markup `<@UID>` / `<@UID|label>`. */
const MENTION_TOKEN = /^<@([A-Z0-9]+)(?:\|[^>]*)?>$/;

/**
 * Reserved skill namespaces that always win over a same-named Slack user when
 * parsing `$X:skill` (codex design verdict D1). A coworker whose display name
 * collides with one of these must invoke via uid or mention markup.
 */
const RESERVED_NAMESPACES: ReadonlySet<string> = new Set(['user', 'local', 'stv', 'superpowers']);

/**
 * Fallback order for bare `$skill` resolution. Probed sequentially; the first
 * namespace whose `SKILL.md` exists on disk wins.
 *
 * - `user`        — `DATA_DIR/{userId}/skills/{name}/SKILL.md` (only when userId present)
 * - `local`       — `LOCAL_SKILLS_DIR/{name}/SKILL.md`
 * - `stv`         — `PLUGINS_DIR/stv/skills/{name}/SKILL.md`
 * - `superpowers` — `PLUGINS_DIR/superpowers/skills/{name}/SKILL.md`
 *
 * If all four miss, a final pass scans every other plugin directory under
 * `PLUGINS_DIR` for an exact-name match (see {@link SkillForceHandler.scanRemainingPlugins}).
 */
type FallbackNamespace = 'user' | 'local' | 'stv' | 'superpowers';
const BARE_FALLBACK_NAMESPACES: ReadonlyArray<FallbackNamespace> = ['user', 'local', 'stv', 'superpowers'];

/**
 * Plugin slots inside {@link BARE_FALLBACK_NAMESPACES} (i.e. excluding the
 * `user`/`local` namespaces that don't live under `PLUGINS_DIR`). Used by
 * {@link SkillForceHandler.scanRemainingPlugins} to skip plugins already
 * probed in steps 3–4. Derived from the priority list so adding a new plugin
 * slot only requires editing one place.
 */
const PRIORITY_PLUGIN_SLOTS: ReadonlyArray<string> = BARE_FALLBACK_NAMESPACES.filter(
  (ns): ns is 'stv' | 'superpowers' => ns === 'stv' || ns === 'superpowers',
);

/**
 * Bare `$word` tokens that look like skills but are documented top-level
 * directives handled by sibling command handlers (`ModelHandler`,
 * `VerbosityHandler`, `EffortHandler`, etc.). Without this short-circuit,
 * every common command message (e.g. `$model opus`, `$effort high`) would
 * walk the full fallback chain (4–12 `existsSync` syscalls + a `readdirSync`)
 * before discovering nothing matches and falling through to the actual
 * directive handler. Order matters in {@link CommandRouter} (this handler
 * runs before the directives) so the cheap blacklist check matters here, not
 * just an aesthetic.
 *
 * Keep this list narrow to bare directive verbs that are unlikely to ever
 * become real skill names. A `$plugin:directive` form is unaffected — the
 * blacklist only applies to bare resolution.
 */
const KNOWN_NON_SKILL_DIRECTIVES: ReadonlySet<string> = new Set([
  'model',
  'verbosity',
  'effort',
  'persona',
  'bypass',
  'sandbox',
  'rate',
  'email',
  'notify',
  'webhook',
  'compact',
  'close',
  'report',
  'usage',
  'help',
  'context',
  'renew',
  'onboarding',
  'mcp',
  'cwd',
  'cct',
  'instructions',
  'prompt',
  'admin',
  'dashboard',
  'marketplace',
  'plugins',
  'skills',
  'memory',
  'restore',
  'new',
  'session',
  'link',
]);

/** Qualified skill reference: plugin + skill name */
interface SkillRef {
  plugin: string;
  skill: string;
  /** Canonical key for deduplication: "plugin:skill" */
  key: string;
  /**
   * Cross-user invocation (S3): when set, the skill lives at
   * `DATA_DIR/{ownerUserId}/skills/{skill}/SKILL.md` regardless of the
   * requester. Drives owner-scoped nested resolution (S7/S8). When absent, a
   * `user`-namespace ref resolves against the threaded owner context (the
   * requester for top-level own skills).
   */
  ownerUserId?: string;
}

/**
 * Outcome of resolving a bare `$skill` against the fallback chain.
 *
 * - `found`     — single namespace owns the name; use `ref`
 * - `ambiguous` — exactly one of the priority slots (1–4) didn't match but
 *                 the final PLUGINS_DIR scan turned up multiple plugins
 *                 hosting the same name; surface to user as an error
 * - `not_found` — no namespace owns the name
 */
type BareResolution =
  | { kind: 'found'; ref: SkillRef }
  | { kind: 'ambiguous'; name: string; matches: string[] }
  | { kind: 'not_found'; name: string };

/**
 * Handles forced skill invocation via $plugin:skillname syntax.
 *
 * Resolution order for bare $skill:
 *   1. user        → DATA_DIR/{userId}/skills/{skill}/SKILL.md (only if userId present)
 *   2. local       → LOCAL_SKILLS_DIR/{skill}/SKILL.md
 *   3. stv         → PLUGINS_DIR/stv/skills/{skill}/SKILL.md
 *   4. superpowers → PLUGINS_DIR/superpowers/skills/{skill}/SKILL.md
 *   5. PLUGINS_DIR full scan, exact name match. Multiple hits → ambiguous error.
 *
 * Examples:
 *   $z               → first slot of user/local/stv/superpowers/other-plugins owning "z"
 *   $local:z         → reads local/skills/z/SKILL.md (qualified, no fallback)
 *   $user:my-deploy  → reads DATA_DIR/{userId}/skills/my-deploy/SKILL.md
 *   $stv:new-task    → reads plugins/stv/skills/new-task/SKILL.md
 *
 * Qualified `$plugin:skill` references are NEVER fallback-resolved — they
 * point at exactly the namespace the user typed.
 *
 * Nested $plugin:skill references inside skill content are resolved recursively.
 * Nested bare $skill references inherit the same fallback chain (and the
 * caller's userId for the `user` slot).
 */
export class SkillForceHandler implements CommandHandler {
  private logger = new Logger('SkillForceHandler');

  /**
   * @param resolveUser maps a Slack identifier (uid / display name) to a uid
   *   for cross-user `$X:skill` invocation (S3/S6). Defaults to the offline
   *   `userSettingsStore`-backed resolver; injected as a stub in tests.
   */
  constructor(private resolveUser: UserResolver = resolveUserIdentifier) {}

  canHandle(text: string, userId?: string): boolean {
    const trimmed = text.trim();

    // Cross-user mention force: `$<@UID>:skill`.
    CROSS_USER_MENTION_PATTERN.lastIndex = 0;
    if (CROSS_USER_MENTION_PATTERN.test(trimmed)) return true;

    SKILL_REF_PATTERN.lastIndex = 0;
    if (SKILL_REF_PATTERN.test(trimmed)) return true;

    // Bare $skill — match only when the fallback chain actually resolves
    // (or detects an ambiguity worth surfacing). This keeps `$model`,
    // `$verbosity`, `$effort` and other unrelated `$word` tokens from being
    // intercepted.
    BARE_SKILL_PATTERN.lastIndex = 0;
    for (;;) {
      const match = BARE_SKILL_PATTERN.exec(trimmed);
      if (match === null) break;
      const resolution = this.resolveBareSkill(match[1], userId);
      if (resolution.kind !== 'not_found') return true;
    }

    // Soft (no-$) cross-user use — only when a token resolves to a real user
    // AND the named skill exists on disk (S2).
    if (this.extractTopLevelSoftRefs(trimmed, userId).length > 0) return true;

    return false;
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { text, say, threadTs, user } = ctx;

    // Collect all top-level skill references from user text: explicit `$` forms
    // plus soft (no-$) cross-user refs (S2). Soft refs are merged with `$` refs
    // and deduplicated by canonical key.
    const { refs: dollarRefs, ambiguous } = this.extractSkillRefs(text, user);
    const topLevelRefs = [...dollarRefs];
    const seenTopLevel = new Set(dollarRefs.map((r) => r.key));
    for (const softRef of this.extractTopLevelSoftRefs(text, user)) {
      if (!seenTopLevel.has(softRef.key)) {
        seenTopLevel.add(softRef.key);
        topLevelRefs.push(softRef);
      }
    }

    if (ambiguous.length > 0) {
      // Ambiguous bare reference — surface immediately so the user knows to
      // disambiguate with an explicit `$plugin:name` form.
      const lines = ambiguous.map(
        (a) =>
          `\`$${a.name}\` 가 여러 plugin 에 존재합니다: ${a.matches
            .map((m) => `\`${m}\``)
            .join(', ')}. 명시적으로 \`$plugin:${a.name}\` 형태로 호출해 주세요.`,
      );
      await say({
        text: `❌ 모호한 스킬 참조:\n${lines.join('\n')}`,
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    if (topLevelRefs.length === 0) {
      return { handled: false };
    }

    // Resolve all skills recursively, collecting content
    const resolved = new Map<string, string>();
    const errors: string[] = [];

    for (const ref of topLevelRefs) {
      this.resolveSkill(ref, resolved, errors, 0, user);
    }

    if (resolved.size === 0) {
      await say({
        text: `❌ 스킬을 찾을 수 없습니다: ${errors.join(', ')}`,
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    if (errors.length > 0) {
      this.logger.warn('Some skills could not be resolved', { errors });
    }

    // Build the <invoked_skills> block with plugin:skill tags
    const skillBlocks = Array.from(resolved.entries())
      .map(([key, content]) => `<${key}>\n${content}\n</${key}>`)
      .join('\n');

    const invokedBlock = `<invoked_skills>\n${skillBlocks}\n</invoked_skills>`;
    const finalPrompt = `${text}\n\n${invokedBlock}`;

    const resolvedKeys = Array.from(resolved.keys());
    this.logger.info('Forced skill invocation', {
      skills: resolvedKeys,
      errorSkills: errors,
    });

    // Emit RPG-style forced skill invocation banner (red attachment bar)
    const casterName = user ? `<@${user}>` : '누군가';
    const rpg = ToolFormatter.formatSkillForceInvocationRPG(resolvedKeys, casterName);
    await say({
      text: '',
      thread_ts: threadTs,
      attachments: [{ color: rpg.color, text: rpg.text }],
    });

    return {
      handled: true,
      continueWithPrompt: finalPrompt,
    };
  }

  /**
   * Extract unique skill references from text (in order of appearance).
   * Supports both qualified ($plugin:skill — namespace as typed) and bare
   * ($skill — namespace via {@link resolveBareSkill}).
   *
   * Returned `ambiguous` entries belong to bare references that hit multiple
   * plugins in the PLUGINS_DIR scan; the caller (execute) reports them and
   * does NOT include them in `refs`.
   */
  private extractSkillRefs(
    text: string,
    userId?: string,
  ): { refs: SkillRef[]; ambiguous: { name: string; matches: string[] }[] } {
    const refs: SkillRef[] = [];
    const seen = new Set<string>();
    const ambiguous: { name: string; matches: string[] }[] = [];
    const ambiguousSeen = new Set<string>();

    // 0. Cross-user mention refs: `$<@UID>:skill` (S3). The uid is embedded by
    //    Slack, so no directory lookup is needed. Parsed first so the `<@…>`
    //    markup is consumed before the qualified pattern (which can't match it).
    CROSS_USER_MENTION_PATTERN.lastIndex = 0;
    for (;;) {
      const match = CROSS_USER_MENTION_PATTERN.exec(text);
      if (match === null) break;
      const ownerUserId = match[1];
      const skill = match[2];
      const key = `user:${ownerUserId}:${skill}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ plugin: 'user', skill, key, ownerUserId });
      }
    }

    // 1. Qualified refs: $plugin:skill. A non-reserved, non-plugin prefix that
    //    resolves to a Slack user is a cross-user invocation (S3). Otherwise the
    //    prefix is treated as a namespace exactly as before (no fallback).
    SKILL_REF_PATTERN.lastIndex = 0;
    for (;;) {
      const match = SKILL_REF_PATTERN.exec(text);
      if (match === null) break;
      const plugin = match[1];
      const skill = match[2];

      if (!this.isReservedOrPlugin(plugin)) {
        const ownerUserId = this.resolveIdentifier(plugin);
        if (ownerUserId && isSafePathSegment(ownerUserId)) {
          const key = `user:${ownerUserId}:${skill}`;
          if (!seen.has(key)) {
            seen.add(key);
            refs.push({ plugin: 'user', skill, key, ownerUserId });
          }
          continue;
        }
      }

      const key = `${plugin}:${skill}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ plugin, skill, key });
      }
    }

    // 2. Bare refs: $skill → resolve via fallback chain
    BARE_SKILL_PATTERN.lastIndex = 0;
    for (;;) {
      const match = BARE_SKILL_PATTERN.exec(text);
      if (match === null) break;
      const name = match[1];
      const resolution = this.resolveBareSkill(name, userId);

      if (resolution.kind === 'found') {
        if (!seen.has(resolution.ref.key)) {
          seen.add(resolution.ref.key);
          refs.push(resolution.ref);
        }
      } else if (resolution.kind === 'ambiguous') {
        if (!ambiguousSeen.has(name)) {
          ambiguousSeen.add(name);
          ambiguous.push({ name, matches: resolution.matches });
        }
      }
      // 'not_found' — silently skip; caller's regex matched a `$word` that
      // simply isn't a skill (likely `$model`, `$effort`, etc).
    }

    return { refs, ambiguous };
  }

  /**
   * Resolve a bare `$skill` to a single namespace by walking the fallback
   * chain. Pure read-only filesystem probing; no caching (skill installs are
   * rare relative to dispatch frequency).
   *
   * Two cheap short-circuits run before any filesystem syscall:
   *   1. unsafe `name` (path traversal) → `not_found`
   *   2. `name ∈ KNOWN_NON_SKILL_DIRECTIVES` → `not_found` (avoids 4–12
   *      syscalls for `$model`, `$effort`, `$verbosity`, … on every command
   *      message — see the const's JSDoc for rationale).
   */
  private resolveBareSkill(name: string, userId?: string): BareResolution {
    if (!isSafePathSegment(name)) {
      return { kind: 'not_found', name };
    }
    if (KNOWN_NON_SKILL_DIRECTIVES.has(name)) {
      return { kind: 'not_found', name };
    }

    // 1–4: priority slots (user → local → stv → superpowers)
    for (const ns of BARE_FALLBACK_NAMESPACES) {
      if (ns === 'user' && (!userId || !isSafePathSegment(userId))) {
        continue;
      }
      const ref: SkillRef = { plugin: ns, skill: name, key: `${ns}:${name}` };
      if (fs.existsSync(this.resolveSkillPath(ref, userId))) {
        return { kind: 'found', ref };
      }
    }

    // 5: scan remaining plugins under PLUGINS_DIR for an exact-name match.
    // Excludes the priority plugin slots (already probed) and any plugin
    // directory that fails the safe-segment check.
    const matches = this.scanRemainingPlugins(name);

    if (matches.length === 1) {
      const plugin = matches[0];
      return { kind: 'found', ref: { plugin, skill: name, key: `${plugin}:${name}` } };
    }
    if (matches.length > 1) {
      return {
        kind: 'ambiguous',
        name,
        matches: matches.map((p) => `${p}:${name}`),
      };
    }
    return { kind: 'not_found', name };
  }

  /**
   * List plugin directories under {@link PLUGINS_DIR} that own a skill named
   * `name`, excluding {@link PRIORITY_PLUGIN_SLOTS} (already probed in steps
   * 3–4) and any plugin directory that fails the safe-segment check.
   *
   * Skill paths are constructed via {@link SkillForceHandler.resolveSkillPath}
   * so the on-disk layout convention (`{plugin}/skills/{name}/SKILL.md`)
   * lives in exactly one place.
   *
   * `ENOENT` on the directory itself is swallowed (PLUGINS_DIR may not exist
   * in dev/test environments). Other errors are logged at WARN — this is a
   * best-effort lookup, not a critical path.
   */
  private scanRemainingPlugins(name: string): string[] {
    let entries: fs.Dirent[] | undefined;
    try {
      entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.logger.warn('PLUGINS_DIR read failed during bare-skill scan', {
          pluginsDir: PLUGINS_DIR,
          error: (err as Error).message,
        });
      }
      return [];
    }
    // Defensive: real fs always returns an array or throws, but auto-mocked
    // `vi.fn()` returns undefined — guard so the for-of below can't crash.
    if (!Array.isArray(entries)) return [];

    const skip = new Set<string>(PRIORITY_PLUGIN_SLOTS);
    const matches: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const plugin = entry.name;
      if (skip.has(plugin)) continue;
      if (!isSafePathSegment(plugin)) continue;
      const skillPath = this.resolveSkillPath({ plugin, skill: name, key: '' });
      if (fs.existsSync(skillPath)) {
        matches.push(plugin);
      }
    }
    return matches;
  }

  /**
   * Resolve the filesystem path for a skill based on its plugin.
   *
   * - `local` → `LOCAL_SKILLS_DIR/{skill}/SKILL.md`
   * - `user`  → `DATA_DIR/{userId}/skills/{skill}/SKILL.md` (requires safe userId+skill)
   * - others  → `{PLUGINS_DIR}/{plugin}/skills/{skill}/SKILL.md`
   *
   * Throws if `ref.plugin === 'user'` but the userId/skill safety guard
   * fails. The previous behavior — silently falling through to the generic
   * `PLUGINS_DIR/user/skills/...` branch — would build a real but
   * surprising path (e.g. for a malformed userId). Failing loud surfaces
   * the misconfiguration instead of routing to the wrong namespace.
   * Callers (`resolveBareSkill`) already gate the user slot on the same
   * safety check, so this throw should be unreachable in practice.
   */
  private resolveSkillPath(ref: SkillRef, userId?: string): string {
    if (ref.plugin === 'local') {
      return path.join(LOCAL_SKILLS_DIR, ref.skill, 'SKILL.md');
    }
    // Cross-user ref (S3): the explicit owner uid on the ref overrides the
    // threaded owner-context userId. Lives in the owner's skills dir.
    const ownerForUserSlot = ref.ownerUserId ?? userId;
    if (ref.plugin === 'user') {
      if (!ownerForUserSlot || !isSafePathSegment(ownerForUserSlot) || !isSafePathSegment(ref.skill)) {
        throw new Error(
          `resolveSkillPath: user namespace requires safe owner + skill (got owner=${JSON.stringify(ownerForUserSlot)}, skill=${JSON.stringify(ref.skill)})`,
        );
      }
      return path.join(DATA_DIR, ownerForUserSlot, 'skills', ref.skill, 'SKILL.md');
    }
    return path.join(PLUGINS_DIR, ref.plugin, 'skills', ref.skill, 'SKILL.md');
  }

  /**
   * True when `plugin` is a reserved namespace (`user`/`local`/`stv`/
   * `superpowers`) or an existing plugin directory under {@link PLUGINS_DIR}.
   * Such prefixes always win over a same-named Slack user (codex verdict D1),
   * so a coworker whose display name collides must use a uid / mention.
   */
  /**
   * Resolve a cross-user identifier token to a uid. Mention markup (`<@UID>`)
   * and uid-shaped tokens are decoded internally; bare display names are
   * delegated to the injected {@link resolveUser} (offline directory). Keeping
   * mention/uid handling here means the injected resolver only ever needs to
   * answer display-name lookups.
   */
  private resolveIdentifier(token: string): string | null {
    const m = token.match(MENTION_TOKEN);
    if (m) return m[1];
    const bare = token.startsWith('@') ? token.slice(1) : token;
    if (!bare) return null;
    if (UID_SHAPE.test(bare)) return bare;
    return this.resolveUser(bare);
  }

  /**
   * Extract soft (no-`$`) cross-user refs from the TOP-LEVEL message text only
   * (S2). Never run on nested skill content — skill bodies are full of
   * `key: value` lines that would be misread as cross-user refs. Each candidate
   * is double-gated: the token must resolve to a uid AND the skill must exist on
   * disk, otherwise the text is left untouched.
   */
  private extractTopLevelSoftRefs(text: string, requesterUserId?: string): SkillRef[] {
    const out: SkillRef[] = [];
    const seen = new Set<string>();
    SOFT_CROSS_USER_PATTERN.lastIndex = 0;
    for (;;) {
      const match = SOFT_CROSS_USER_PATTERN.exec(text);
      if (match === null) break;
      const skill = match[2];
      const ownerUserId = this.resolveIdentifier(match[1]);
      if (!ownerUserId || !isSafePathSegment(ownerUserId) || !isSafePathSegment(skill)) continue;

      const ref: SkillRef = { plugin: 'user', skill, key: `user:${ownerUserId}:${skill}`, ownerUserId };
      let exists = false;
      try {
        exists = fs.existsSync(this.resolveSkillPath(ref, requesterUserId));
      } catch {
        exists = false;
      }
      if (!exists) continue;
      if (!seen.has(ref.key)) {
        seen.add(ref.key);
        out.push(ref);
      }
    }
    return out;
  }

  private isReservedOrPlugin(plugin: string): boolean {
    if (RESERVED_NAMESPACES.has(plugin)) return true;
    if (!isSafePathSegment(plugin)) return false;
    try {
      return fs.existsSync(path.join(PLUGINS_DIR, plugin));
    } catch {
      return false;
    }
  }

  /**
   * Recursively resolve a skill and all its nested $plugin:skill references.
   * Results are added to the `resolved` map in dependency order (depth-first).
   *
   * Nested bare references inherit the caller's `userId` so a user-scoped
   * skill can transitively reference its sibling user-scoped skills.
   * Ambiguous nested bare refs are dropped silently with a warning — they
   * are not the user's direct request, so a thrown error would be surprising.
   */
  private resolveSkill(
    ref: SkillRef,
    resolved: Map<string, string>,
    errors: string[],
    depth: number,
    userId?: string,
  ): void {
    // Owner-aware canonical key: a `user`-namespace ref's identity is
    // (owner, skill), NOT just the skill name. Without the owner, two borrowed
    // skills from different owners that both nest `$user:dev` would collide on
    // `user:dev` and the second owner's `dev` would be silently dropped
    // (wrong-owner mixing). Cross-user refs already carry `ownerUserId`; nested
    // own/borrowed `user` refs derive the owner from the threaded context.
    const effectiveOwner = ref.ownerUserId ?? (ref.plugin === 'user' ? userId : undefined);
    const canonicalKey = effectiveOwner ? `user:${effectiveOwner}:${ref.skill}` : ref.key;

    if (resolved.has(canonicalKey)) return;
    if (depth >= MAX_DEPTH) {
      this.logger.warn('Max skill recursion depth reached', { skill: canonicalKey, depth });
      return;
    }

    const skillPath = this.resolveSkillPath(ref, userId);
    if (!fs.existsSync(skillPath)) {
      errors.push(canonicalKey);
      this.logger.warn('Skill file not found', { skill: canonicalKey, skillPath });
      return;
    }

    const content = fs.readFileSync(skillPath, 'utf-8');

    // Owner context for THIS skill's nested owner-relative refs (S7/S8):
    //   1. `copied_from` frontmatter → the original owner of a copied skill, so
    //      a copy's `$user:dev` keeps resolving to the origin owner.
    //   2. else the ref's explicit cross-user owner (a borrowed skill).
    //   3. else the inherited owner context (own skills / same-owner nesting).
    const childOwner = extractCopiedFrom(content)?.ownerUserId ?? ref.ownerUserId ?? userId;

    // Recursively resolve nested skill references against the child owner.
    const nested = this.extractSkillRefs(content, childOwner);
    if (nested.ambiguous.length > 0) {
      this.logger.warn('Ambiguous bare skill refs in nested content', {
        parent: ref.key,
        ambiguous: nested.ambiguous.map((a) => a.name),
      });
    }
    for (const nestedRef of nested.refs) {
      this.resolveSkill(nestedRef, resolved, errors, depth + 1, childOwner);
    }

    // Add this skill AFTER its dependencies (depth-first)
    resolved.set(canonicalKey, content);
  }
}
