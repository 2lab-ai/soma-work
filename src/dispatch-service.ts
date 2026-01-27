/**
 * DispatchService - Routes user messages to appropriate workflows
 * Uses ClaudeHandler.dispatchOneShot for classification (unified auth path)
 */

import { WorkflowType } from './types';
import { Logger } from './logger';
import { ClaudeHandler } from './claude-handler';
import * as fs from 'fs';
import * as path from 'path';

// Default dispatch model - fast and cheap for classification
// Can be overridden via DEFAULT_DISPATCH_MODEL env var
const FALLBACK_DISPATCH_MODEL = 'claude-haiku-4-5-20251001';

// Dispatch prompt file path
const DISPATCH_PROMPT_PATH = path.join(__dirname, 'prompt', 'dispatch.prompt');

// Fallback counter for monitoring
let dispatchFallbackCount = 0;

/**
 * Result of dispatch classification
 */
export interface DispatchResult {
  workflow: WorkflowType;
  title: string;
}

/**
 * DispatchService classifies user messages and routes to appropriate workflows
 * Now uses ClaudeHandler for unified auth (Claude subscription / Agent SDK)
 */
export class DispatchService {
  private logger = new Logger('DispatchService');
  private model: string;
  private dispatchPrompt: string | undefined;
  private isConfigured: boolean = false;
  private claudeHandler: ClaudeHandler | undefined;

  constructor(claudeHandler?: ClaudeHandler) {
    this.claudeHandler = claudeHandler;
    this.model = process.env.DEFAULT_DISPATCH_MODEL || FALLBACK_DISPATCH_MODEL;
    this.loadDispatchPrompt();
    this.validateConfiguration();
  }

  /**
   * Set ClaudeHandler instance (for lazy initialization)
   */
  setClaudeHandler(claudeHandler: ClaudeHandler): void {
    this.claudeHandler = claudeHandler;
    this.validateConfiguration();
  }

  private loadDispatchPrompt(): void {
    try {
      if (fs.existsSync(DISPATCH_PROMPT_PATH)) {
        this.dispatchPrompt = fs.readFileSync(DISPATCH_PROMPT_PATH, 'utf-8');
        this.logger.debug('Loaded dispatch prompt', { path: DISPATCH_PROMPT_PATH });
      } else {
        this.logger.warn('Dispatch prompt not found, using default', { path: DISPATCH_PROMPT_PATH });
      }
    } catch (error) {
      this.logger.error('Failed to load dispatch prompt', error);
    }
  }

  /**
   * Validate dispatch configuration at startup
   */
  private validateConfiguration(): void {
    if (!this.dispatchPrompt) {
      this.logger.error('DISPATCH CONFIG ERROR: No dispatch prompt loaded. All sessions will use default workflow.', {
        expectedPath: DISPATCH_PROMPT_PATH,
        model: this.model,
      });
      this.isConfigured = false;
      return;
    }

    // Note: No ANTHROPIC_API_KEY check needed - we use ClaudeHandler's auth (subscription credentials)
    this.isConfigured = true;
    this.logger.debug('Dispatch service configured', {
      model: this.model,
      promptLength: this.dispatchPrompt.length,
      hasClaudeHandler: !!this.claudeHandler,
    });
  }

  /**
   * Check if dispatch service is properly configured
   */
  isReady(): boolean {
    return this.isConfigured && !!this.claudeHandler;
  }

  /**
   * Get current fallback count for monitoring
   */
  static getFallbackCount(): number {
    return dispatchFallbackCount;
  }

  /**
   * Classify user message and determine workflow
   * Uses ClaudeHandler.dispatchOneShot for unified auth
   * @param userMessage - The user's message to classify
   * @param abortSignal - Optional AbortSignal for cancellation
   */
  async dispatch(userMessage: string, abortSignal?: AbortSignal): Promise<DispatchResult> {
    // Check if service is properly configured (prompt + ClaudeHandler)
    if (!this.isConfigured || !this.dispatchPrompt) {
      this.logger.warn(`📍 DISPATCH → [default] (unconfigured - no dispatch prompt)`);
      dispatchFallbackCount++;
      return {
        workflow: 'default',
        title: this.generateFallbackTitle(userMessage),
      };
    }

    if (!this.claudeHandler) {
      this.logger.warn(`📍 DISPATCH → [default] (no ClaudeHandler)`);
      dispatchFallbackCount++;
      return {
        workflow: 'default',
        title: this.generateFallbackTitle(userMessage),
      };
    }

    const startTime = Date.now();
    try {
      this.logger.info('🎯 DISPATCH: Starting classification', {
        model: this.model,
        messageLength: userMessage.length,
        messagePreview: userMessage.substring(0, 100),
      });

      // Bridge AbortSignal to AbortController for SDK
      const abortController = new AbortController();
      if (abortSignal) {
        abortSignal.addEventListener('abort', () => {
          const elapsed = Date.now() - startTime;
          this.logger.warn(`⏱️ DISPATCH: Abort signal received after ${elapsed}ms`);
          abortController.abort();
        }, { once: true });
      }

      const responseText = await this.claudeHandler.dispatchOneShot(
        userMessage,
        this.dispatchPrompt,
        this.model,
        abortController
      );

      const elapsed = Date.now() - startTime;
      this.logger.info(`✅ DISPATCH: Got response in ${elapsed}ms`, {
        responseLength: responseText.length,
        responsePreview: responseText.substring(0, 100),
      });

      const result = this.parseResponse(responseText, userMessage);

      // Workflow dispatch log
      this.logger.info(`📍 DISPATCH → [${result.workflow}] "${result.title}" (${elapsed}ms)`, {
        workflow: result.workflow,
        title: result.title,
        rawResponse: responseText.substring(0, 200),
      });

      return result;
    } catch (error) {
      const elapsed = Date.now() - startTime;
      // Check if this was an abort
      if (abortSignal?.aborted) {
        this.logger.warn(`📍 DISPATCH → [default] (aborted after ${elapsed}ms)`);
      } else {
        this.logger.error(`📍 DISPATCH → [default] (error after ${elapsed}ms: ${(error as Error).message})`, error);
      }
      dispatchFallbackCount++;
      return {
        workflow: 'default',
        title: this.generateFallbackTitle(userMessage),
      };
    }
  }

  /**
   * Extract JSON object from text using brace balancing
   * Handles nested objects and strings containing braces
   */
  private extractJson(text: string): string | null {
    const start = text.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < text.length; i++) {
      const c = text[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (c === '\\' && inString) {
        escape = true;
        continue;
      }

      if (c === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (c === '{') depth++;
      if (c === '}') {
        depth--;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }

    return null;
  }

  /**
   * Parse dispatch response (JSON format)
   * @param text - The raw response text from the model
   * @param userMessage - Original user message for fallback title generation
   */
  private parseResponse(text: string, userMessage: string): DispatchResult {
    // Try to extract JSON using brace balancing (handles nested objects)
    const jsonStr = this.extractJson(text);
    if (jsonStr) {
      try {
        const parsed = JSON.parse(jsonStr);
        // Validate parsed fields
        if (typeof parsed.workflow !== 'string') {
          throw new Error('Invalid workflow field in response');
        }
        return {
          workflow: this.validateWorkflow(parsed.workflow),
          title: typeof parsed.title === 'string' ? this.sanitizeTitle(parsed.title) : this.generateFallbackTitle(userMessage),
        };
      } catch (jsonError) {
        this.logger.debug('JSON parse failed, trying XML fallback', { jsonError });
      }
    }

    // Fallback: try to parse legacy XML format
    try {
      const workflowMatch = text.match(/<workflow>([^<]+)<\/workflow>/);
      const titleMatch = text.match(/<title>([^<]+)<\/title>/);

      if (workflowMatch) {
        return {
          workflow: this.validateWorkflow(workflowMatch[1].trim()),
          title: titleMatch ? this.sanitizeTitle(titleMatch[1].trim()) : this.generateFallbackTitle(userMessage),
        };
      }
    } catch (xmlError) {
      this.logger.debug('XML parse failed', { xmlError });
    }

    // Final fallback
    this.logger.warn('Failed to parse dispatch response', {
      textPreview: text.substring(0, 100),
    });
    return {
      workflow: 'default',
      title: this.generateFallbackTitle(userMessage),
    };
  }

  /**
   * Validate workflow type
   */
  private validateWorkflow(workflow: string): WorkflowType {
    const validWorkflows: WorkflowType[] = [
      'jira-executive-summary',
      'jira-brainstorming',
      'jira-planning',
      'jira-create-pr',
      'pr-review',
      'pr-fix-and-update',
      'default',
    ];

    if (validWorkflows.includes(workflow as WorkflowType)) {
      return workflow as WorkflowType;
    }

    this.logger.warn('Invalid workflow, defaulting', { workflow });
    return 'default';
  }

  /**
   * Sanitize title to remove Slack special formatting
   * Prevents mention injection (<!channel>, <@U123>) and link formatting
   */
  private sanitizeTitle(title: string): string {
    return title
      .replace(/<[!@#][^>]*>/g, '') // Remove <!channel>, <@U123>, <#C123>
      .replace(/<[^|>]+\|([^>]+)>/g, '$1') // Convert <url|text> to text
      .replace(/<[^>]+>/g, '') // Remove remaining <url>
      .replace(/\s+/g, ' ')
      .trim() || 'New Session';
  }

  /**
   * Generate fallback title from message
   */
  private generateFallbackTitle(message: string): string {
    if (!message) return 'New Session';

    // Take first 50 chars, clean up
    const title = message
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 50);

    return title.length === 50 ? `${title}...` : title || 'New Session';
  }

  /**
   * Get current dispatch model
   */
  getModel(): string {
    return this.model;
  }
}

// Singleton instance
let dispatchServiceInstance: DispatchService | undefined;

/**
 * Get singleton DispatchService instance
 */
export function getDispatchService(): DispatchService {
  if (!dispatchServiceInstance) {
    dispatchServiceInstance = new DispatchService();
  }
  return dispatchServiceInstance;
}

/**
 * Initialize dispatch service with ClaudeHandler
 * Must be called once after ClaudeHandler is created
 */
export function initializeDispatchService(claudeHandler: ClaudeHandler): DispatchService {
  const service = getDispatchService();
  service.setClaudeHandler(claudeHandler);
  return service;
}
