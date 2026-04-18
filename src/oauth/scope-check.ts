/**
 * OAuth scope guard for Claude credentials.
 *
 * Claude OAuth tokens must carry `user:profile` for the usage endpoint to work.
 * Additional scopes (`user:inference`, etc.) may be present but are not enforced here.
 */

export const REQUIRED_OAUTH_SCOPES: readonly string[] = ['user:profile'];

/** Returns `true` when every entry in {@link REQUIRED_OAUTH_SCOPES} is present in `scopes`. */
export function hasRequiredScopes(scopes: string[]): boolean {
  return missingScopes(scopes).length === 0;
}

/** Returns the required scopes that are missing from `scopes`. Order matches {@link REQUIRED_OAUTH_SCOPES}. */
export function missingScopes(scopes: string[]): string[] {
  const have = new Set(scopes);
  return REQUIRED_OAUTH_SCOPES.filter((s) => !have.has(s));
}
