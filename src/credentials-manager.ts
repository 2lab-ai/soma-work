import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Logger } from './logger';
import { config } from './config';

const logger = new Logger('CredentialsManager');

/**
 * Check if credential manager is enabled via ENABLE_LOCAL_FILE_CREDENTIALS_JSON=1
 */
export function isCredentialManagerEnabled(): boolean {
  return config.credentials.enabled;
}

// Path to Claude credentials file
const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const BACKUP_CREDENTIALS_PATH = path.join(os.homedir(), '.claude', 'credentials.json');

export interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    [key: string]: any;
  };
  [key: string]: any;
}

/**
 * Read credentials from ~/.claude/.credentials.json
 */
export function readCredentials(): ClaudeCredentials | null {
  try {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
      logger.warn('Credentials file not found', { path: CREDENTIALS_PATH });
      return null;
    }

    const content = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
    const credentials = JSON.parse(content) as ClaudeCredentials;
    logger.debug('Successfully read credentials file');
    return credentials;
  } catch (error) {
    logger.error('Failed to read credentials file', error);
    return null;
  }
}

/**
 * Check if claudeAiOauth exists in credentials
 */
export function hasClaudeAiOauth(): boolean {
  const credentials = readCredentials();
  if (!credentials) {
    return false;
  }

  const hasOauth = !!(credentials.claudeAiOauth && credentials.claudeAiOauth.accessToken);
  logger.debug('Checked for claudeAiOauth', { hasOauth });
  return hasOauth;
}

/**
 * Copy credentials.json to .credentials.json
 * (cp ~/.claude/credentials.json ~/.claude/.credentials.json)
 */
export function copyBackupCredentials(): boolean {
  try {
    if (!fs.existsSync(BACKUP_CREDENTIALS_PATH)) {
      logger.warn('Backup credentials file not found', { path: BACKUP_CREDENTIALS_PATH });
      return false;
    }

    // Ensure the directory exists
    const credentialsDir = path.dirname(CREDENTIALS_PATH);
    if (!fs.existsSync(credentialsDir)) {
      fs.mkdirSync(credentialsDir, { recursive: true });
    }

    // Copy the file
    fs.copyFileSync(BACKUP_CREDENTIALS_PATH, CREDENTIALS_PATH);
    logger.debug('Successfully copied backup credentials', {
      from: BACKUP_CREDENTIALS_PATH,
      to: CREDENTIALS_PATH,
    });
    return true;
  } catch (error) {
    logger.error('Failed to copy backup credentials', error);
    return false;
  }
}

/**
 * Check if automatic credential restore is enabled
 */
export function isAutoRestoreEnabled(): boolean {
  return process.env.AUTOMATIC_RESTORE_CREDENTIAL === '1';
}

/**
 * Result of credential validation
 */
export interface CredentialValidationResult {
  valid: boolean;
  restored: boolean;
  error?: string;
}

/**
 * Validate and optionally restore credentials before Claude SDK operations
 * Returns validation result including whether credentials are valid
 */
export async function ensureValidCredentials(): Promise<CredentialValidationResult> {
  // Skip validation if credential manager is disabled
  if (!isCredentialManagerEnabled()) {
    logger.debug('Credential manager disabled (ENABLE_LOCAL_FILE_CREDENTIALS_JSON != 1), skipping validation');
    return { valid: true, restored: false };
  }

  // First check if claudeAiOauth exists
  if (hasClaudeAiOauth()) {
    logger.debug('Claude credentials are valid');
    return { valid: true, restored: false };
  }

  logger.warn('Claude credentials missing or invalid (no claudeAiOauth)');

  // Check if automatic restore is enabled
  if (isAutoRestoreEnabled()) {
    logger.debug('Automatic credential restore is enabled, attempting to restore...');

    // Try to copy from backup
    const copied = copyBackupCredentials();
    if (copied) {
      // Verify the copy was successful
      if (hasClaudeAiOauth()) {
        logger.debug('Successfully restored credentials from backup');
        return { valid: true, restored: true };
      } else {
        logger.error('Backup credentials also missing claudeAiOauth');
        return {
          valid: false,
          restored: false,
          error: 'Backup credentials file exists but does not contain valid claudeAiOauth',
        };
      }
    } else {
      return {
        valid: false,
        restored: false,
        error: 'Failed to copy backup credentials (credentials.json not found or copy failed)',
      };
    }
  }

  // Auto restore not enabled
  return {
    valid: false,
    restored: false,
    error: 'Claude credentials missing. Enable AUTOMATIC_RESTORE_CREDENTIAL=1 or login to Claude manually.',
  };
}

/**
 * Get credential status for debugging/logging
 */
export function getCredentialStatus(): {
  enabled: boolean;
  credentialsFileExists: boolean;
  backupFileExists: boolean;
  hasClaudeAiOauth: boolean;
  autoRestoreEnabled: boolean;
} {
  const enabled = isCredentialManagerEnabled();

  // If disabled, return minimal status
  if (!enabled) {
    return {
      enabled: false,
      credentialsFileExists: false,
      backupFileExists: false,
      hasClaudeAiOauth: false,
      autoRestoreEnabled: false,
    };
  }

  return {
    enabled: true,
    credentialsFileExists: fs.existsSync(CREDENTIALS_PATH),
    backupFileExists: fs.existsSync(BACKUP_CREDENTIALS_PATH),
    hasClaudeAiOauth: hasClaudeAiOauth(),
    autoRestoreEnabled: isAutoRestoreEnabled(),
  };
}
