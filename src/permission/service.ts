import { UserSettingsStore } from '../user-settings-store';
import { SessionRegistry } from '../session-registry';
import { Logger } from '../logger';

const logger = new Logger('PermissionService');

export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Centralized permission service
 * Single source of truth for all permission-related checks
 */
export class PermissionService {
  constructor(
    private userSettings: UserSettingsStore,
    private sessionRegistry: SessionRegistry
  ) {}

  /**
   * Check if user has bypass permission enabled
   * When enabled, permission prompts are skipped
   */
  shouldBypassPermission(userId: string): boolean {
    const bypass = this.userSettings.getUserBypassPermission(userId);
    logger.debug('Checking bypass permission', { userId, bypass });
    return bypass;
  }

  /**
   * Set user's bypass permission setting
   */
  setBypassPermission(userId: string, bypass: boolean): void {
    this.userSettings.setUserBypassPermission(userId, bypass);
    logger.info('Updated bypass permission', { userId, bypass });
  }

  /**
   * Check if a user can interrupt an active session
   * Only session owner or current initiator can interrupt
   */
  canInterruptSession(
    userId: string,
    channelId: string,
    threadTs?: string
  ): PermissionCheckResult {
    const session = this.sessionRegistry.getSession(channelId, threadTs);

    if (!session) {
      return { allowed: true, reason: 'No active session' };
    }

    // Session owner can always interrupt
    if (session.ownerId === userId) {
      return { allowed: true, reason: 'User is session owner' };
    }

    // Current initiator can interrupt
    if (session.currentInitiatorId === userId) {
      return { allowed: true, reason: 'User is current initiator' };
    }

    return {
      allowed: false,
      reason: `Session owned by ${session.ownerName}, current initiator: ${session.currentInitiatorName}`,
    };
  }

  /**
   * Check if working directory is required for a user
   * Currently always required, but could be made configurable
   */
  requiresWorkingDirectory(userId: string): boolean {
    // Always require working directory for now
    return true;
  }

  /**
   * Comprehensive permission check for a message action
   */
  checkMessagePermissions(
    userId: string,
    channelId: string,
    threadTs?: string
  ): PermissionCheckResult {
    // Check interrupt permission
    const interruptCheck = this.canInterruptSession(userId, channelId, threadTs);
    if (!interruptCheck.allowed) {
      return interruptCheck;
    }

    return { allowed: true };
  }

  /**
   * Get user's bypass status for display
   */
  getBypassStatus(userId: string): string {
    const bypass = this.shouldBypassPermission(userId);
    return bypass ? 'enabled' : 'disabled';
  }
}
