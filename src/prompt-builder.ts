/**
 * PromptBuilder - Builds system prompts with persona
 * Extracted from claude-handler.ts (Phase 5.2)
 */

import { Logger } from './logger';
import { userSettingsStore } from './user-settings-store';
import * as path from 'path';
import * as fs from 'fs';

// Prompt file paths
const SYSTEM_PROMPT_PATH = path.join(__dirname, 'prompt', 'system.prompt');
const LOCAL_SYSTEM_PROMPT_PATH = path.join(process.cwd(), '.system.prompt');
const PERSONA_DIR = path.join(__dirname, 'persona');

/**
 * PromptBuilder handles system prompt and persona loading
 */
export class PromptBuilder {
  private logger = new Logger('PromptBuilder');
  private defaultSystemPrompt: string | undefined;

  constructor() {
    this.loadDefaultPrompt();
  }

  /**
   * Load the default system prompt from files
   */
  private loadDefaultPrompt(): void {
    try {
      if (fs.existsSync(SYSTEM_PROMPT_PATH)) {
        this.defaultSystemPrompt = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf-8');
      }

      // Append local system prompt if exists (not committed to source)
      if (fs.existsSync(LOCAL_SYSTEM_PROMPT_PATH)) {
        const localPrompt = fs.readFileSync(LOCAL_SYSTEM_PROMPT_PATH, 'utf-8');
        this.defaultSystemPrompt = this.defaultSystemPrompt
          ? `${this.defaultSystemPrompt}\n\n${localPrompt}`
          : localPrompt;
        this.logger.info('Loaded local system prompt from .system.prompt');
      }
    } catch (error) {
      this.logger.error('Failed to load system prompt', error);
    }
  }

  /**
   * Load persona content from file
   */
  loadPersona(personaName: string): string | undefined {
    const personaPath = path.join(PERSONA_DIR, `${personaName}.md`);
    try {
      if (fs.existsSync(personaPath)) {
        return fs.readFileSync(personaPath, 'utf-8');
      }

      // Fallback to default if specified persona not found
      if (personaName !== 'default') {
        const defaultPath = path.join(PERSONA_DIR, 'default.md');
        if (fs.existsSync(defaultPath)) {
          return fs.readFileSync(defaultPath, 'utf-8');
        }
      }
    } catch (error) {
      this.logger.error(`Failed to load persona '${personaName}'`, error);
    }
    return undefined;
  }

  /**
   * Get list of available personas
   */
  getAvailablePersonas(): string[] {
    try {
      if (fs.existsSync(PERSONA_DIR)) {
        return fs
          .readdirSync(PERSONA_DIR)
          .filter((file) => file.endsWith('.md'))
          .map((file) => file.replace('.md', ''));
      }
    } catch (error) {
      this.logger.error('Failed to list personas', error);
    }
    return ['default'];
  }

  /**
   * Build the complete system prompt for a user
   * Includes base prompt and user's persona
   */
  buildSystemPrompt(userId?: string): string | undefined {
    let systemPrompt = this.defaultSystemPrompt || '';

    // Load and append user's persona
    if (userId) {
      const personaName = userSettingsStore.getUserPersona(userId);
      const personaContent = this.loadPersona(personaName);

      if (personaContent) {
        systemPrompt = systemPrompt
          ? `${systemPrompt}\n\n<persona>\n${personaContent}\n</persona>`
          : `<persona>\n${personaContent}\n</persona>`;

        this.logger.debug('Applied persona', { user: userId, persona: personaName });
      }
    }

    return systemPrompt || undefined;
  }

  /**
   * Get the default system prompt without persona
   */
  getDefaultPrompt(): string | undefined {
    return this.defaultSystemPrompt;
  }
}

// Singleton instance for backward compatibility
let promptBuilderInstance: PromptBuilder | undefined;

/**
 * Get the singleton PromptBuilder instance
 */
export function getPromptBuilder(): PromptBuilder {
  if (!promptBuilderInstance) {
    promptBuilderInstance = new PromptBuilder();
  }
  return promptBuilderInstance;
}

/**
 * Get list of available personas (backward compatible function)
 */
export function getAvailablePersonas(): string[] {
  return getPromptBuilder().getAvailablePersonas();
}
