/**
 * Leaf helper for `/z` prefix stripping.
 *
 * Lives in its own module so `normalize.ts`, `whitelist.ts`, and any future
 * sibling can import it without forming an import cycle. Previously this
 * helper sat in `normalize.ts`, which made `whitelist.ts → normalize.ts` a
 * back-edge of the `normalize → whitelist → normalize` cycle (#745).
 *
 * Pure / synchronous / no z-domain types.
 */

/**
 * Strip a leading `/z` prefix. Returns the trimmed remainder, or `null` if
 * the input does NOT start with `/z`.
 *
 * Matching is case-insensitive on the literal `/z` token. The remainder is
 * everything after the first whitespace run; an empty remainder (bare `/z`)
 * returns `''`.
 */
export function stripZPrefix(text: string): string | null {
  const match = text.match(/^\/z(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return (match[1] ?? '').trim();
}
