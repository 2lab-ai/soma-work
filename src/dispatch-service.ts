/**
 * DispatchService - Routes user messages to appropriate workflows
 * Uses a fast model (Haiku) to classify user intent
 */

import Anthropic from '@anthropic-ai/sdk';
import { WorkflowType } from './types';
import { Logger } from './logger';
import * as fs from 'fs';
import * as path from 'path';

// Default dispatch model - fast and cheap for classification
const DEFAULT_DISPATCH_MODEL = 'claude-3-haiku-20240307';

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
 */
export class DispatchService {
  private logger = new Logger('DispatchService');
  private client: Anthropic;
  private model: string;
  private dispatchPrompt: string | undefined;
  private isConfigured: boolean = false;

  constructor() {
    this.client = new Anthropic();
    this.model = process.env.DISPATCH_MODEL || DEFAULT_DISPATCH_MODEL;
    this.loadDispatchPrompt();
    this.validateConfiguration();
  }

  private loadDispatchPrompt(): void {
    try {
      if (fs.existsSync(DISPATCH_PROMPT_PATH)) {
        this.dispatchPrompt = fs.readFileSync(DISPATCH_PROMPT_PATH, 'utf-8');
        this.logger.info('Loaded dispatch prompt', { path: DISPATCH_PROMPT_PATH });
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

    if (!process.env.ANTHROPIC_API_KEY) {
      this.logger.error('DISPATCH CONFIG ERROR: ANTHROPIC_API_KEY not set. Dispatch will fail.');
      this.isConfigured = false;
      return;
    }

    this.isConfigured = true;
    this.logger.info('Dispatch service configured', {
      model: this.model,
      promptLength: this.dispatchPrompt.length,
    });
  }

  /**
   * Check if dispatch service is properly configured
   */
  isReady(): boolean {
    return this.isConfigured;
  }

  /**
   * Get current fallback count for monitoring
   */
  static getFallbackCount(): number {
    return dispatchFallbackCount;
  }

  /**
   * Classify user message and determine workflow
   * @param userMessage - The user's message to classify
   * @param abortSignal - Optional AbortSignal for cancellation
   */
  async dispatch(userMessage: string, abortSignal?: AbortSignal): Promise<DispatchResult> {
    if (!this.dispatchPrompt) {
      this.logger.warn('No dispatch prompt, defaulting to default workflow');
      dispatchFallbackCount++;
      return {
        workflow: 'default',
        title: this.generateFallbackTitle(userMessage),
      };
    }

    try {
      this.logger.debug('Dispatching message', {
        model: this.model,
        messageLength: userMessage.length,
      });

      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: 256,
          temperature: 0, // Deterministic output for consistent classification
          system: this.dispatchPrompt,
          messages: [
            {
              role: 'user',
              content: userMessage,
            },
          ],
        },
        {
          signal: abortSignal, // Pass abort signal for cancellation
        }
      );

      // Extract text from response
      const textContent = response.content.find((c: { type: string }) => c.type === 'text');
      if (!textContent || textContent.type !== 'text') {
        throw new Error('No text content in response');
      }

      const result = this.parseResponse(textContent.text, userMessage);
      this.logger.info('Dispatch result', {
        workflow: result.workflow,
        title: result.title,
      });

      return result;
    } catch (error) {
      // Check if this was an abort
      if (abortSignal?.aborted) {
        this.logger.debug('Dispatch aborted');
      } else {
        this.logger.error('Dispatch failed, using fallback', error);
      }
      dispatchFallbackCount++;
      return {
        workflow: 'default',
        title: this.generateFallbackTitle(userMessage),
      };
    }
  }

  /**
   * Parse dispatch response (JSON format)
   * @param text - The raw response text from the model
   * @param userMessage - Original user message for fallback title generation
   */
  private parseResponse(text: string, userMessage: string): DispatchResult {
    try {
      // Try to extract JSON from response (non-greedy to get first JSON object)
      const jsonMatch = text.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        // Validate parsed fields
        if (typeof parsed.workflow !== 'string') {
          throw new Error('Invalid workflow field in response');
        }
        return {
          workflow: this.validateWorkflow(parsed.workflow),
          title: typeof parsed.title === 'string' ? parsed.title : this.generateFallbackTitle(userMessage),
        };
      }

      // Fallback: try to parse legacy XML format
      const workflowMatch = text.match(/<workflow>([^<]+)<\/workflow>/);
      const titleMatch = text.match(/<title>([^<]+)<\/title>/);

      if (workflowMatch) {
        return {
          workflow: this.validateWorkflow(workflowMatch[1].trim()),
          title: titleMatch ? titleMatch[1].trim() : this.generateFallbackTitle(userMessage),
        };
      }

      throw new Error('Could not parse dispatch response');
    } catch (error) {
      // Truncate text to prevent logging sensitive data
      this.logger.warn('Failed to parse dispatch response', {
        textPreview: text.substring(0, 100),
        error,
      });
      return {
        workflow: 'default',
        title: this.generateFallbackTitle(userMessage),
      };
    }
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
