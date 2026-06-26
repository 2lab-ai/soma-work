/**
 * Minimal offline user directory needed to resolve a Slack identifier (uid /
 * display name / mention markup) to a canonical uid.
 *
 * Backed by {@link userSettingsStore} in production (a synchronous, on-disk
 * store of every user who has ever interacted with the bot). Injected as a
 * stub in tests so the resolver stays a pure function with no Slack API
 * round-trip — `CommandContext` exposes no `slackApi`, and the
 * `SkillForceHandler` / `UserSkillsListHandler` preprocessors run synchronously
 * before the model sees the message.
 */
export interface UserDirectory {
  getAllUsers(): Array<{ userId: string; slackName?: string }>;
}

/** Resolves a Slack identifier (uid / display name / mention) to a uid. */
export type UserResolver = (token: string) => string | null;

/** Slack mention markup: `<@U123>` or `<@U123|display-label>`. */
const MENTION_RE = /^<@([A-Z0-9]+)(?:\|[^>]*)?>$/;

/**
 * Slack id shape (user `U…` / `W…`, bot `B…`). Deliberately loose — the real
 * gate is whether the resolved uid owns the requested skill on disk; this
 * predicate only decides "treat the bare token as a uid rather than a display
 * name". A display name almost never matches this all-caps-no-lowercase shape.
 */
const UID_RE = /^[UWB][A-Z0-9]{6,}$/;

const defaultDirectory: UserDirectory = {
  // Lazy require so merely importing this resolver (e.g. into SkillForceHandler)
  // does not pull the full user-settings-store dependency chain into unit tests
  // that never exercise the cross-user path. Mirrors the lazy-require pattern in
  // `src/pid-lock.ts`.
  getAllUsers: () => {
    const { userSettingsStore } = require('../../user-settings-store') as typeof import('../../user-settings-store');
    return userSettingsStore.getAllUsers();
  },
};

/**
 * Resolve a Slack user identifier to its canonical uid, or `null` when it
 * cannot be resolved.
 *
 * Accepted forms (S6):
 *   - mention markup  `<@U094E5L4A15>` / `<@U094E5L4A15|zhuge>`
 *   - raw uid         `U094E5L4A15`
 *   - display name    `Zhuge` / `@Zhuge` / `alice.kim` (case-insensitive)
 *
 * Resolution order is deliberate:
 *   1. mention markup → the embedded uid (definitive; Slack itself produced it)
 *   2. display-name match against the directory (the user's typed intent)
 *   3. uid-shaped bare token → itself (covers users absent from the directory,
 *      e.g. the skill-existence check downstream is the real gate)
 *
 * Display-name match precedes the uid-shape fallback so a token that is BOTH a
 * valid display name and uid-shaped resolves as the name the user meant.
 */
export function resolveUserIdentifier(token: string, directory: UserDirectory = defaultDirectory): string | null {
  if (typeof token !== 'string') return null;
  const trimmed = token.trim();
  if (!trimmed) return null;

  // 1. Mention markup is unambiguous — Slack embedded the uid.
  const mention = trimmed.match(MENTION_RE);
  if (mention) return mention[1];

  // Strip a single leading @ that a user may have typed before a display name.
  const bare = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  if (!bare) return null;

  // 2. Display-name match (case-insensitive) against the offline directory.
  //    Display names are NOT unique in Slack, so we fail closed on ambiguity:
  //    if two distinct uids share the name, the caller must use a uid/mention
  //    rather than silently target the wrong tenant.
  const lower = bare.toLowerCase();
  let users: Array<{ userId: string; slackName?: string }>;
  try {
    users = directory.getAllUsers();
  } catch {
    users = [];
  }
  const nameMatches = new Set<string>();
  for (const u of users) {
    if (u.slackName && u.slackName.toLowerCase() === lower) nameMatches.add(u.userId);
  }
  if (nameMatches.size === 1) return [...nameMatches][0];
  if (nameMatches.size > 1) return null; // ambiguous — require uid/mention

  // An exact uid match in the directory also wins (covers directories that key
  // by uid without a slackName).
  for (const u of users) {
    if (u.userId === bare) return u.userId;
  }

  // 3. uid-shaped bare token → itself (user may not be in the directory yet).
  if (UID_RE.test(bare)) return bare;

  return null;
}
