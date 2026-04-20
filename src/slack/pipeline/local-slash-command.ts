/**
 * #617 followup — Claude Agent SDK local slash command detector.
 *
 * The SDK's CLI only treats `/compact`, `/clear`, `/model`, `/cost`,
 * `/status`, `/help`, `/usage` as local commands when the prompt STARTS
 * with the `/cmd` token. soma-work's `preparePrompt` normally wraps user
 * text with `<speaker>…</speaker>` + a trailing `<context>…</context>`
 * footer, which pushes the slash off the first character and makes the
 * SDK treat the command as a plain LLM message. `isLocalSlashCommand`
 * is the single source of truth for which prompts must skip that
 * wrapping and be forwarded to the SDK verbatim.
 *
 * This is separated from `stream-executor.ts` to keep the invariant
 * testable without booting the full executor.
 */

/**
 * Allowlist of local slash commands that the SDK CLI handles without
 * a model round-trip. Kept narrow on purpose: only commands documented
 * in sdk.d.ts (`SDKLocalCommandOutputMessage` subtype) belong here.
 */
const SDK_LOCAL_SLASH_COMMANDS = ['compact', 'clear', 'model', 'cost', 'status', 'help', 'usage'] as const;

const LOCAL_SLASH_COMMAND_RE = new RegExp(`^/(${SDK_LOCAL_SLASH_COMMANDS.join('|')})(\\s|$)`);

/**
 * Returns `true` when the trimmed prompt text is an exact SDK local
 * slash command invocation (bare or with an argument tail separated by
 * whitespace). Trimming is the caller's responsibility — we do not
 * re-trim so the function is cheap to call from hot paths.
 *
 * Examples (all return `true`):
 *   "/compact", "/compact 2", "/clear", "/model opus"
 *
 * Examples (all return `false`):
 *   "/compacta"         — not a known command
 *   "hey /compact"      — slash is not first char
 *   "<speaker>u</speaker>\n/compact" — same reason
 *   " /compact"         — leading whitespace; caller must trim first
 */
export function isLocalSlashCommand(trimmedText: string): boolean {
  return LOCAL_SLASH_COMMAND_RE.test(trimmedText);
}
