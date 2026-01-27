/**
 * PromptBuilder - Builds system prompts with persona and workflow support
 * Extracted from claude-handler.ts (Phase 5.2)
 * Extended for workflow-based prompt routing (Phase 6)
 */

import { Logger } from './logger';
import { userSettingsStore } from './user-settings-store';
import { WorkflowType } from './types';
import * as path from 'path';
import * as fs from 'fs';

// Prompt file paths
const PROMPT_DIR = path.join(__dirname, 'prompt');
const SYSTEM_PROMPT_PATH = path.join(PROMPT_DIR, 'system.prompt');
const WORKFLOWS_DIR = path.join(PROMPT_DIR, 'workflows');
const LOCAL_SYSTEM_PROMPT_PATH = path.join(process.cwd(), '.system.prompt');
const PERSONA_DIR = path.join(__dirname, 'persona');

// Include directive pattern: {{include:filename.prompt}}
const INCLUDE_PATTERN = /\{\{include:([^}]+)\}\}/g;

/**
 * PromptBuilder handles system prompt, workflow prompts, and persona loading
 */
export class PromptBuilder {
  private logger = new Logger('PromptBuilder');
  private defaultSystemPrompt: string | undefined;
  private workflowPromptCache: Map<WorkflowType, string> = new Map();

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
   * Process include directives in prompt content
   * Supports {{include:filename.prompt}} syntax
   * Includes path traversal protection
   */
  private processIncludes(content: string, depth: number = 0): string {
    // Prevent infinite recursion
    if (depth > 5) {
      this.logger.warn('Include depth exceeded, stopping recursion');
      return content;
    }

    const resolvedPromptDir = path.resolve(PROMPT_DIR);

    return content.replace(INCLUDE_PATTERN, (match, filename) => {
      const trimmedFilename = filename.trim();

      // Reject absolute paths
      if (path.isAbsolute(trimmedFilename)) {
        this.logger.warn('Include blocked: absolute path not allowed', { filename: trimmedFilename });
        return `<!-- Include blocked: ${trimmedFilename} -->`;
      }

      const includePath = path.resolve(PROMPT_DIR, trimmedFilename);

      // Verify path stays within PROMPT_DIR (prevent directory traversal)
      if (!includePath.startsWith(resolvedPromptDir + path.sep) && includePath !== resolvedPromptDir) {
        this.logger.warn('Include blocked: path traversal detected', { filename: trimmedFilename });
        return `<!-- Include blocked: ${trimmedFilename} -->`;
      }

      // Use file descriptor to prevent TOCTOU race condition
      // Open file first, then validate via fd to ensure atomicity
      let fd: number | undefined;
      try {
        // Check if path exists and is a file (not directory)
        const stat = fs.statSync(includePath);
        if (!stat.isFile()) {
          this.logger.warn('Include blocked: not a file', { filename: trimmedFilename });
          return `<!-- Include blocked: ${trimmedFilename} -->`;
        }

        // Open file descriptor first to lock the inode
        fd = fs.openSync(includePath, 'r');

        // Now validate the real path (symlink resolution)
        // Use fstatSync on fd would be ideal but Node doesn't expose realpath from fd
        // So we validate realpath and then read via fd (same inode)
        const realPromptDir = fs.realpathSync(resolvedPromptDir);
        const realPath = fs.realpathSync(includePath);
        if (!realPath.startsWith(realPromptDir + path.sep) && realPath !== realPromptDir) {
          this.logger.warn('Include blocked: symlink escapes prompt directory', {
            filename: trimmedFilename,
            resolvedPath: includePath,
            realPath,
          });
          return `<!-- Include blocked: ${trimmedFilename} -->`;
        }

        // Read content via file descriptor (ensures we read the validated inode)
        const fileSize = fs.fstatSync(fd).size;
        const buffer = Buffer.alloc(fileSize);
        fs.readSync(fd, buffer, 0, fileSize, 0);
        const includeContent = buffer.toString('utf-8');

        // Recursively process includes in included content
        return this.processIncludes(includeContent, depth + 1);
      } catch (error) {
        // Handle specific error cases
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          this.logger.warn('Include file not found', { filename: trimmedFilename, path: includePath });
          return `<!-- Include not found: ${trimmedFilename} -->`;
        }
        this.logger.error('Failed to process include', { filename: trimmedFilename, error });
        return `<!-- Include error: ${trimmedFilename} -->`;
      } finally {
        if (fd !== undefined) {
          fs.closeSync(fd);
        }
      }
    });
  }

  /**
   * Load workflow-specific prompt
   */
  loadWorkflowPrompt(workflow: WorkflowType): string | undefined {
    // Check cache first
    if (this.workflowPromptCache.has(workflow)) {
      return this.workflowPromptCache.get(workflow);
    }

    // For 'default' workflow, use the default system prompt
    if (workflow === 'default') {
      return this.defaultSystemPrompt;
    }

    // Try to load workflow-specific prompt
    const workflowPath = path.join(WORKFLOWS_DIR, `${workflow}.prompt`);
    try {
      if (fs.existsSync(workflowPath)) {
        let content = fs.readFileSync(workflowPath, 'utf-8');
        // Process include directives
        content = this.processIncludes(content);
        this.workflowPromptCache.set(workflow, content);
        this.logger.info(`📋 WORKFLOW PROMPT loaded: [${workflow}] (${content.length} chars)`);
        return content;
      }
    } catch (error) {
      this.logger.error(`📋 WORKFLOW PROMPT failed: [${workflow}]`, { error });
    }

    // Fallback to default system prompt
    this.logger.warn(`📋 WORKFLOW PROMPT not found: [${workflow}] → using default`);
    return this.defaultSystemPrompt;
  }

  /**
   * Clear workflow prompt cache (useful for development/hot-reload)
   */
  clearCache(): void {
    this.workflowPromptCache.clear();
    this.logger.debug('Cleared workflow prompt cache');
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
   * Includes base prompt (or workflow prompt) and user's persona
   */
  buildSystemPrompt(userId?: string, workflow?: WorkflowType): string | undefined {
    // Load workflow-specific prompt or default
    let systemPrompt = workflow
      ? this.loadWorkflowPrompt(workflow) || this.defaultSystemPrompt || ''
      : this.defaultSystemPrompt || '';

    // Load and append user's persona
    if (userId) {
      const personaName = userSettingsStore.getUserPersona(userId);
      const personaContent = this.loadPersona(personaName);

      if (personaContent) {
        systemPrompt = systemPrompt
          ? `${systemPrompt}\n\n<persona>\n${personaContent}\n</persona>`
          : `<persona>\n${personaContent}\n</persona>`;

        this.logger.debug('Applied persona', { user: userId, persona: personaName, workflow });
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
