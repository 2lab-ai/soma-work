/**
 * PromptBuilder - Builds system prompts with persona and workflow support
 * Extracted from claude-handler.ts (Phase 5.2)
 * Extended for workflow-based prompt routing (Phase 6)
 */

import * as fs from 'fs';
import * as path from 'path';
import { SYSTEM_PROMPT_FILE } from './env-paths';
import { Logger } from './logger';
import { buildUserInstructionsBlock } from './prompt/user-instructions-block';
import type { ConversationSession, WorkflowType } from './types';
import { formatMemoryForPrompt } from './user-memory-store';
import { userSettingsStore } from './user-settings-store';
import { listUserSkills } from './user-skill-store';

// Prompt file paths
const PROMPT_DIR = path.join(__dirname, 'prompt');
const DEFAULT_PROMPT_PATH = path.join(PROMPT_DIR, 'default.prompt');
const WORKFLOWS_DIR = path.join(PROMPT_DIR, 'workflows');
const LOCAL_SYSTEM_PROMPT_PATH = SYSTEM_PROMPT_FILE;
const PERSONA_DIR = path.join(__dirname, 'persona');

// Include directive pattern: {{include:filename.prompt}}
const INCLUDE_PATTERN = /\{\{include:([^}]+)\}\}/g;
// Runtime variable pattern: {{variable_name}} or {{user.field}}
// Negative lookbehind: \{{ is escaped and won't be substituted
const VARIABLE_PATTERN = /(?<!\\)\{\{([\w.]+)\}\}/g;

/**
 * Options for constructing a PromptBuilder.
 * When agentName is set, prompts are loaded from the agent-specific directory
 * with fallback to the main prompt directory.
 * Trace: docs/multi-agent/trace.md, Scenario 6
 */
export interface PromptBuilderOptions {
  agentName?: string;
  promptDir?: string; // explicit override, takes precedence over agentName
}

/**
 * PromptBuilder handles system prompt, workflow prompts, and persona loading
 */
export class PromptBuilder {
  private logger = new Logger('PromptBuilder');
  private defaultSystemPrompt: string | undefined;
  private localSystemPrompt: string | undefined; // .system.prompt content (injected into ALL workflows)
  private workflowPromptCache: Map<WorkflowType, string> = new Map();

  /** Resolved prompt directory for this builder instance */
  private promptDir: string;
  /** Fallback prompt directory (main) when agent-specific prompt is missing */
  private fallbackPromptDir: string;
  /** Agent name (undefined for main bot) */
  private agentName: string | undefined;

  constructor(options?: PromptBuilderOptions) {
    this.fallbackPromptDir = PROMPT_DIR;
    this.agentName = options?.agentName;

    if (options?.promptDir) {
      // Explicit prompt dir override
      this.promptDir = path.isAbsolute(options.promptDir)
        ? options.promptDir
        : path.join(PROMPT_DIR, '..', options.promptDir);
    } else if (options?.agentName) {
      // Agent-specific: src/prompt/{agentName}/
      this.promptDir = path.join(PROMPT_DIR, options.agentName);
    } else {
      // Main bot: src/prompt/
      this.promptDir = PROMPT_DIR;
    }

    this.loadDefaultPrompt();
  }

  /**
   * Get the resolved prompt directory (for testing)
   */
  getPromptDir(): string {
    return this.promptDir;
  }

  /**
   * Get the default system prompt content (for testing)
   */
  getDefaultSystemPrompt(): string | undefined {
    return this.defaultSystemPrompt;
  }

  /**
   * Load the default system prompt from files.
   * For agents: tries agent dir first, falls back to main dir.
   * Trace: docs/multi-agent/trace.md, Scenario 6, Section 3a
   */
  private loadDefaultPrompt(): void {
    try {
      const agentDefaultPath = path.join(this.promptDir, 'default.prompt');
      const mainDefaultPath = DEFAULT_PROMPT_PATH;

      if (fs.existsSync(agentDefaultPath)) {
        let content = fs.readFileSync(agentDefaultPath, 'utf-8');
        content = this.processIncludes(content);
        this.defaultSystemPrompt = content;
        if (this.agentName) {
          this.logger.info(`PromptBuilder: loaded agent prompt from ${this.promptDir}`);
        }
      } else if (this.agentName && fs.existsSync(mainDefaultPath)) {
        // Fallback to main prompt for agents without their own
        let content = fs.readFileSync(mainDefaultPath, 'utf-8');
        content = this.processIncludes(content);
        this.defaultSystemPrompt = content;
        this.logger.warn(`PromptBuilder: agent '${this.agentName}' using main prompt (no agent-specific prompt found)`);
      } else if (fs.existsSync(mainDefaultPath)) {
        let content = fs.readFileSync(mainDefaultPath, 'utf-8');
        content = this.processIncludes(content);
        this.defaultSystemPrompt = content;
      }

      // Load local system prompt if exists (not committed to source)
      // This is stored separately and appended to ALL workflow prompts
      if (fs.existsSync(LOCAL_SYSTEM_PROMPT_PATH)) {
        this.localSystemPrompt = fs.readFileSync(LOCAL_SYSTEM_PROMPT_PATH, 'utf-8');
        this.logger.info('Loaded local system prompt from .system.prompt (will be injected into all workflows)');
      }
    } catch (error) {
      this.logger.error('Failed to load system prompt', error);
    }
  }

  /**
   * Append local system prompt to content if available
   */
  private appendLocalSystemPrompt(content: string): string {
    if (this.localSystemPrompt) {
      return `${content}\n\n${this.localSystemPrompt}`;
    }
    return content;
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

    const resolvedPromptDir = path.resolve(this.promptDir);
    const resolvedFallbackDir = path.resolve(this.fallbackPromptDir);

    return content.replace(INCLUDE_PATTERN, (match, filename) => {
      const trimmedFilename = filename.trim();

      // Reject absolute paths
      if (path.isAbsolute(trimmedFilename)) {
        this.logger.warn('Include blocked: absolute path not allowed', { filename: trimmedFilename });
        return `<!-- Include blocked: ${trimmedFilename} -->`;
      }

      // Try agent dir first, then fallback to main dir
      // Trace: docs/multi-agent/trace.md, Scenario 6, Section 3b
      let includePath = path.resolve(this.promptDir, trimmedFilename);
      if (!fs.existsSync(includePath) && this.promptDir !== this.fallbackPromptDir) {
        includePath = path.resolve(this.fallbackPromptDir, trimmedFilename);
      }

      // Verify path stays within prompt dirs (prevent directory traversal)
      const inPromptDir = includePath.startsWith(resolvedPromptDir + path.sep) || includePath === resolvedPromptDir;
      const inFallbackDir =
        includePath.startsWith(resolvedFallbackDir + path.sep) || includePath === resolvedFallbackDir;
      if (!inPromptDir && !inFallbackDir) {
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
   * Process runtime variable placeholders in prompt content
   * Replaces {{variable_name}} and {{user.*}} with runtime values
   * Escaped variables \\{{...}} are preserved as literal {{...}}
   */
  private processVariables(content: string, userId?: string): string {
    const result = content.replace(VARIABLE_PATTERN, (match, varName) => {
      // user.* variable substitution
      if (varName.startsWith('user.') && userId) {
        return this.resolveUserVariable(varName, userId) ?? match;
      }

      // Unknown variables are left as-is
      return match;
    });

    // Unescape \\{{ → {{ after substitution
    return result.replace(/\\\{\{/g, '{{');
  }

  /**
   * Resolve user.* variables from UserSettings
   */
  private resolveUserVariable(varName: string, userId: string): string | undefined {
    const settings = userSettingsStore.getUserSettings(userId);
    if (!settings) return undefined;

    switch (varName) {
      case 'user.email':
        return settings.email || undefined; // empty sentinel → unresolved
      case 'user.displayName':
        return settings.slackName || undefined;
      case 'user.slackId':
        return settings.userId || undefined;
      case 'user.jiraName':
        return settings.jiraName || undefined;
      default:
        return undefined;
    }
  }

  /**
   * Load workflow-specific prompt
   * All workflows get .system.prompt appended (if it exists)
   */
  loadWorkflowPrompt(workflow: WorkflowType): string | undefined {
    // Check cache first
    if (this.workflowPromptCache.has(workflow)) {
      return this.workflowPromptCache.get(workflow);
    }

    let content: string | undefined;

    // For 'default' workflow, use the default system prompt
    if (workflow === 'default') {
      content = this.defaultSystemPrompt;
    } else {
      // Try to load workflow-specific prompt
      const workflowPath = path.join(WORKFLOWS_DIR, `${workflow}.prompt`);
      try {
        if (fs.existsSync(workflowPath)) {
          content = fs.readFileSync(workflowPath, 'utf-8');
          // Process include directives
          content = this.processIncludes(content);
        }
      } catch (error) {
        this.logger.error(`📋 WORKFLOW PROMPT failed: [${workflow}]`, { error });
      }

      // Fallback to default system prompt if workflow file not found
      if (!content) {
        this.logger.warn(`📋 WORKFLOW PROMPT not found: [${workflow}] → using default`);
        content = this.defaultSystemPrompt;
      }
    }

    // Append .system.prompt to ALL workflows
    if (content) {
      content = this.appendLocalSystemPrompt(content);
      this.workflowPromptCache.set(workflow, content);
      this.logger.info(
        `📋 WORKFLOW PROMPT loaded: [${workflow}] (${content.length} chars, local: ${!!this.localSystemPrompt})`,
      );
    }

    return content;
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
   * Includes base prompt (or workflow prompt) and user's persona.
   *
   * When a `session` is provided, the user-instructions SSOT block is
   * appended so the model sees the current active/todo/completed
   * instructions on every fresh build. The caller is expected to cache
   * the result on `session.systemPrompt` and only rebuild at the three
   * reset points (first turn / reset / post-compact) + SSOT change
   * invalidations. See PLAN.md §2 for the cache protocol.
   */
  buildSystemPrompt(userId?: string, workflow?: WorkflowType, session?: ConversationSession): string | undefined {
    let systemPrompt = this.loadBaseSystemPrompt(workflow);
    systemPrompt = this.applyUserPersona(systemPrompt, userId, workflow);
    systemPrompt = this.applyPersistentMemory(systemPrompt, userId);
    systemPrompt = this.applyPersonalSkills(systemPrompt, userId);
    systemPrompt = this.applyUserInstructions(systemPrompt, session);

    // Process runtime variables (e.g., {{user.email}})
    // Done last so dynamic values are always current
    if (systemPrompt) {
      systemPrompt = this.processVariables(systemPrompt, userId);
    }

    return systemPrompt || undefined;
  }

  /**
   * Load workflow-specific prompt or default.
   * Returns '' when no prompt is available so downstream concatenation
   * helpers can use the `prompt ? ... : block` empty-string pattern.
   */
  private loadBaseSystemPrompt(workflow?: WorkflowType): string {
    return workflow
      ? this.loadWorkflowPrompt(workflow) || this.defaultSystemPrompt || ''
      : this.defaultSystemPrompt || '';
  }

  /**
   * Load and append the user's persona, wrapped in <persona> tags.
   */
  private applyUserPersona(prompt: string, userId?: string, workflow?: WorkflowType): string {
    if (!userId) return prompt;
    const personaName = userSettingsStore.getUserPersona(userId);
    const personaContent = this.loadPersona(personaName);
    if (!personaContent) return prompt;

    this.logger.debug('Applied persona', { user: userId, persona: personaName, workflow });
    return prompt
      ? `${prompt}\n\n<persona>\n${personaContent}\n</persona>`
      : `<persona>\n${personaContent}\n</persona>`;
  }

  /**
   * Inject persistent memory (after persona, before variable processing).
   */
  private applyPersistentMemory(prompt: string, userId?: string): string {
    if (!userId) return prompt;
    const memoryBlock = formatMemoryForPrompt(userId);
    if (!memoryBlock) return prompt;

    const guidance = `\nYou have persistent memory across sessions. Save durable facts using the SAVE_MEMORY model-command: user preferences, environment details, tool quirks, and stable conventions. Memory is injected into every turn, so keep it compact and focused on facts that will still matter later.\nPrioritize what reduces future user steering -- the most valuable memory is one that prevents the user from having to correct or remind you again.\nDo NOT save: task progress, session outcomes, completed-work logs, or temporary TODO state.\n`;
    this.logger.debug('Injected persistent memory', { user: userId });
    return prompt ? `${prompt}\n\n${guidance}\n${memoryBlock}` : `${guidance}\n${memoryBlock}`;
  }

  /**
   * Inject user personal skills list (lazy — only names + descriptions).
   */
  private applyPersonalSkills(prompt: string, userId?: string): string {
    if (!userId) return prompt;
    try {
      const userSkills = listUserSkills(userId);
      if (userSkills.length === 0) return prompt;

      const skillList = userSkills
        .map((s) => `- \`$user:${s.name}\`: ${s.description || '(no description)'}`)
        .join('\n');
      const skillBlock = `\n## Your Personal Skills\nYou have ${userSkills.length} personal skill(s). Invoke with \`$user:skill-name\`. Manage with MANAGE_SKILL command (create/update/delete/rename/list/share).\n${skillList}`;
      return prompt ? `${prompt}\n${skillBlock}` : skillBlock;
    } catch {
      // Skills dir may not exist — that's fine, no skills to inject
      return prompt;
    }
  }

  /**
   * Inject user-instructions SSOT block (last — so it sits at the bottom
   * of the prompt and receives high recency attention from the model).
   * Empty when the session has no instructions yet.
   */
  private applyUserInstructions(prompt: string, session?: ConversationSession): string {
    if (!session) return prompt;
    const instructionsBlock = buildUserInstructionsBlock(session);
    if (!instructionsBlock) return prompt;
    return prompt ? `${prompt}\n\n${instructionsBlock}` : instructionsBlock;
  }

  /**
   * Get the default system prompt without persona (includes .system.prompt if exists)
   */
  getDefaultPrompt(): string | undefined {
    if (this.defaultSystemPrompt) {
      return this.appendLocalSystemPrompt(this.defaultSystemPrompt);
    }
    return this.localSystemPrompt;
  }
}

// Singleton instance for backward compatibility
let promptBuilderInstance: PromptBuilder | undefined;

/**
 * Get the singleton PromptBuilder instance
 */
function getPromptBuilder(): PromptBuilder {
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
