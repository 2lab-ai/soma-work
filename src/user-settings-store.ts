import fs from 'fs';
import path from 'path';
import { Logger } from './logger.js';

const logger = new Logger('UserSettingsStore');

export interface UserSettings {
  userId: string;
  defaultDirectory: string;
  bypassPermission: boolean;
  lastUpdated: string;
}

interface SettingsData {
  [userId: string]: UserSettings;
}

/**
 * File-based store for user settings persistence
 * Stores user preferences like default working directory
 */
export class UserSettingsStore {
  private settingsFile: string;
  private settings: SettingsData = {};

  constructor(dataDir?: string) {
    // Use data directory or default to project root
    const dir = dataDir || path.join(process.cwd(), 'data');

    // Ensure data directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.info('Created data directory', { dir });
    }

    this.settingsFile = path.join(dir, 'user-settings.json');
    this.loadSettings();
  }

  /**
   * Load settings from file
   */
  private loadSettings(): void {
    try {
      if (fs.existsSync(this.settingsFile)) {
        const data = fs.readFileSync(this.settingsFile, 'utf8');
        this.settings = JSON.parse(data);
        logger.info('Loaded user settings', {
          userCount: Object.keys(this.settings).length
        });
      } else {
        this.settings = {};
        logger.info('No existing settings file, starting fresh');
      }
    } catch (error) {
      logger.error('Failed to load user settings', error);
      this.settings = {};
    }
  }

  /**
   * Save settings to file
   */
  private saveSettings(): void {
    try {
      fs.writeFileSync(
        this.settingsFile,
        JSON.stringify(this.settings, null, 2),
        'utf8'
      );
      logger.debug('Saved user settings to file');
    } catch (error) {
      logger.error('Failed to save user settings', error);
    }
  }

  /**
   * Get user's default directory
   */
  getUserDefaultDirectory(userId: string): string | undefined {
    const userSettings = this.settings[userId];
    if (userSettings?.defaultDirectory) {
      logger.debug('Found user default directory', {
        userId,
        directory: userSettings.defaultDirectory
      });
      return userSettings.defaultDirectory;
    }
    return undefined;
  }

  /**
   * Set user's default directory
   */
  setUserDefaultDirectory(userId: string, directory: string): void {
    const existing = this.settings[userId];
    this.settings[userId] = {
      userId,
      defaultDirectory: directory,
      bypassPermission: existing?.bypassPermission ?? false,
      lastUpdated: new Date().toISOString(),
    };
    this.saveSettings();
    logger.info('Set user default directory', { userId, directory });
  }

  /**
   * Get user's bypass permission setting
   */
  getUserBypassPermission(userId: string): boolean {
    const userSettings = this.settings[userId];
    return userSettings?.bypassPermission ?? false;
  }

  /**
   * Set user's bypass permission setting
   */
  setUserBypassPermission(userId: string, bypass: boolean): void {
    if (this.settings[userId]) {
      this.settings[userId].bypassPermission = bypass;
      this.settings[userId].lastUpdated = new Date().toISOString();
    } else {
      this.settings[userId] = {
        userId,
        defaultDirectory: '',
        bypassPermission: bypass,
        lastUpdated: new Date().toISOString(),
      };
    }
    this.saveSettings();
    logger.info('Set user bypass permission', { userId, bypass });
  }

  /**
   * Get all settings for a user
   */
  getUserSettings(userId: string): UserSettings | undefined {
    return this.settings[userId];
  }

  /**
   * Remove user's settings
   */
  removeUserSettings(userId: string): boolean {
    if (this.settings[userId]) {
      delete this.settings[userId];
      this.saveSettings();
      logger.info('Removed user settings', { userId });
      return true;
    }
    return false;
  }

  /**
   * List all users with settings
   */
  listUsers(): string[] {
    return Object.keys(this.settings);
  }

  /**
   * Get statistics
   */
  getStats(): { userCount: number; directories: string[] } {
    const directories = [...new Set(
      Object.values(this.settings).map(s => s.defaultDirectory)
    )];
    return {
      userCount: Object.keys(this.settings).length,
      directories,
    };
  }
}

// Singleton instance
export const userSettingsStore = new UserSettingsStore();
