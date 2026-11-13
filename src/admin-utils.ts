/**
 * Admin user utilities.
 * Admin users are defined by the ADMIN_USERS environment variable (comma-separated Slack user IDs).
 * An environment user (`env:<name>`, a server-tools entry's `envUser`) is an admin too: it runs the deploy and QA
 * work an admin approved for other users. It is never a person, so `getAdminUsers` (who is asked) leaves it out.
 */
import { isEnvironmentUser } from './env-users';

let adminUsers: ReadonlySet<string> | null = null;

function loadAdminUsers(): ReadonlySet<string> {
  if (adminUsers === null) {
    const raw = process.env.ADMIN_USERS || '';
    adminUsers = new Set(
      raw
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    );
  }
  return adminUsers;
}

export function isAdminUser(userId: string): boolean {
  return loadAdminUsers().has(userId) || isEnvironmentUser(userId);
}

/** The admin people (ADMIN_USERS) — the ones asked to approve. Environment users are not in it. */
export function getAdminUsers(): ReadonlySet<string> {
  return loadAdminUsers();
}

/** Reset cached admin users (for testing) */
export function resetAdminUsersCache(): void {
  adminUsers = null;
}
