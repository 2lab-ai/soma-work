/**
 * Admin user utilities.
 * Admin users are defined by the ADMIN_USERS environment variable (comma-separated Slack user IDs).
 */

let adminUsers: ReadonlySet<string> | null = null;

function loadAdminUsers(): ReadonlySet<string> {
  if (adminUsers === null) {
    const raw = process.env.ADMIN_USERS || '';
    adminUsers = new Set(
      raw.split(',').map(id => id.trim()).filter(id => id.length > 0)
    );
  }
  return adminUsers;
}

export function isAdminUser(userId: string): boolean {
  return loadAdminUsers().has(userId);
}

/** Get all admin user IDs */
export function getAdminUsers(): ReadonlySet<string> {
  return loadAdminUsers();
}

/** Reset cached admin users (for testing) */
export function resetAdminUsersCache(): void {
  adminUsers = null;
}
