/**
 * DispatchService - Routes user messages to appropriate workflows
 * Uses ClaudeHandler.dispatchOneShot for classification (unified auth path)
 */

import { WorkflowType, SessionLinks, SessionLink } from './types';
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
  links?: SessionLinks;
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
    let escapeNext = false;

    for (let i = start; i < text.length; i++) {
      const char = text[i];

      // Handle escape sequences in strings
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (char === '\\' && inString) {
        escapeNext = true;
        continue;
      }

      // Toggle string mode on quotes
      if (char === '"') {
        inString = !inString;
        continue;
      }

      // Skip brace counting inside strings
      if (inString) continue;

      // Track brace depth
      if (char === '{') depth++;
      if (char === '}') {
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
    // Extract links from the user message (always do this regardless of dispatch response)
    const extractedLinks = this.extractLinksFromText(userMessage);

    // Try to extract JSON using brace balancing (handles nested objects)
    const jsonStr = this.extractJson(text);
    if (jsonStr) {
      try {
        const parsed = JSON.parse(jsonStr);
        // Validate parsed fields
        if (typeof parsed.workflow !== 'string') {
          throw new Error('Invalid workflow field in response');
        }

        // Merge links from dispatch response with extracted links
        const dispatchLinks = this.parseDispatchLinks(parsed.links);
        const links = this.mergeLinks(extractedLinks, dispatchLinks);

        return {
          workflow: this.validateWorkflow(parsed.workflow),
          title: typeof parsed.title === 'string' ? this.sanitizeTitle(parsed.title) : this.generateFallbackTitle(userMessage),
          links: Object.keys(links).length > 0 ? links : undefined,
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
          links: Object.keys(extractedLinks).length > 0 ? extractedLinks : undefined,
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
      links: Object.keys(extractedLinks).length > 0 ? extractedLinks : undefined,
    };
  }

  /**
   * Extract links from user message text using URL patterns
   */
  private extractLinksFromText(text: string): SessionLinks {
    const links: SessionLinks = {};

    this.logger.debug('🔗 extractLinksFromText', {
      textLength: text.length,
      textPreview: text.substring(0, 150),
    });

    // Jira issue: atlassian.net/browse/XXX-123 or selectedIssue=XXX-123
    const jiraIssueMatch = text.match(/atlassian\.net\/browse\/(\w+-\d+)/) ||
      text.match(/selectedIssue=(\w+-\d+)/);
    if (jiraIssueMatch) {
      // Extract the full URL if present
      const urlMatch = text.match(/(https?:\/\/\S*atlassian\.net\S*(?:browse\/\w+-\d+|selectedIssue=\w+-\d+)\S*)/);
      links.issue = {
        url: urlMatch ? urlMatch[1].replace(/[>|].*$/, '') : `https://atlassian.net/browse/${jiraIssueMatch[1]}`,
        type: 'issue',
        provider: 'jira',
        label: jiraIssueMatch[1],
      };
    }

    // GitHub PR: github.com/owner/repo/pull/123
    const ghPrMatch = text.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
    if (ghPrMatch) {
      const urlMatch = text.match(/(https?:\/\/\S*github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\S*)/);
      links.pr = {
        url: urlMatch ? urlMatch[1].replace(/[>|].*$/, '') : `https://github.com/${ghPrMatch[1]}/${ghPrMatch[2]}/pull/${ghPrMatch[3]}`,
        type: 'pr',
        provider: 'github',
        label: `PR #${ghPrMatch[3]}`,
      };
    }

    // GitHub issue: github.com/owner/repo/issues/123 (only if no Jira issue)
    if (!links.issue) {
      const ghIssueMatch = text.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/);
      if (ghIssueMatch) {
        const urlMatch = text.match(/(https?:\/\/\S*github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+\S*)/);
        links.issue = {
          url: urlMatch ? urlMatch[1].replace(/[>|].*$/, '') : `https://github.com/${ghIssueMatch[1]}/${ghIssueMatch[2]}/issues/${ghIssueMatch[3]}`,
          type: 'issue',
          provider: 'github',
          label: `#${ghIssueMatch[3]}`,
        };
      }
    }

    // Confluence: atlassian.net/wiki/spaces/
    const confluenceMatch = text.match(/(https?:\/\/\S*atlassian\.net\/wiki\/spaces\/\S+)/);
    if (confluenceMatch) {
      links.doc = {
        url: confluenceMatch[1].replace(/[>|].*$/, ''),
        type: 'doc',
        provider: 'confluence',
        label: 'Confluence',
      };
    }

    // Linear issue: linear.app/team/issue/XXX-123
    if (!links.issue) {
      const linearMatch = text.match(/linear\.app\/([\w-]+)\/issue\/(\w+-\d+)/);
      if (linearMatch) {
        const urlMatch = text.match(/(https?:\/\/\S*linear\.app\/[\w-]+\/issue\/\w+-\d+\S*)/);
        links.issue = {
          url: urlMatch ? urlMatch[1].replace(/[>|].*$/, '') : `https://linear.app/${linearMatch[1]}/issue/${linearMatch[2]}`,
          type: 'issue',
          provider: 'linear',
          label: linearMatch[2],
        };
      }
    }

    const linkTypes = Object.keys(links);
    if (linkTypes.length > 0) {
      this.logger.info('🔗 extractLinksFromText: found links', {
        types: linkTypes,
        pr: links.pr?.url,
        issue: links.issue?.url,
        doc: links.doc?.url,
      });
    } else {
      this.logger.debug('🔗 extractLinksFromText: no links found', {
        textPreview: text.substring(0, 100),
      });
    }

    return links;
  }

  /**
   * Parse links from dispatch response JSON
   */
  private parseDispatchLinks(rawLinks: any): SessionLinks {
    if (!rawLinks || typeof rawLinks !== 'object') return {};
    const links: SessionLinks = {};

    // Handle simple URL strings from dispatch response
    if (typeof rawLinks.issue === 'string') {
      const parsed = this.extractLinksFromText(rawLinks.issue);
      if (parsed.issue) links.issue = parsed.issue;
    }
    if (typeof rawLinks.pr === 'string') {
      const parsed = this.extractLinksFromText(rawLinks.pr);
      if (parsed.pr) links.pr = parsed.pr;
    }
    if (typeof rawLinks.doc === 'string') {
      const parsed = this.extractLinksFromText(rawLinks.doc);
      if (parsed.doc) links.doc = parsed.doc;
    }

    return links;
  }

  /**
   * Merge two SessionLinks objects (dispatch links take priority)
   */
  private mergeLinks(extracted: SessionLinks, dispatch: SessionLinks): SessionLinks {
    return {
      ...extracted,
      ...dispatch,
    };
  }

  /**
   * Valid workflow types
   */
  private static readonly VALID_WORKFLOWS = new Set<WorkflowType>([
    'onboarding',
    'jira-executive-summary',
    'jira-brainstorming',
    'jira-planning',
    'jira-create-pr',
    'pr-review',
    'pr-fix-and-update',
    'pr-docs-confluence',
    'deploy',
    'default',
  ]);

  /**
   * Validate workflow type
   */
  private validateWorkflow(workflow: string): WorkflowType {
    if (DispatchService.VALID_WORKFLOWS.has(workflow as WorkflowType)) {
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
