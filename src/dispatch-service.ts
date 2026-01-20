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

  constructor() {
    this.client = new Anthropic();
    this.model = process.env.DISPATCH_MODEL || DEFAULT_DISPATCH_MODEL;
    this.loadDispatchPrompt();
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
   * Classify user message and determine workflow
   */
  async dispatch(userMessage: string): Promise<DispatchResult> {
    if (!this.dispatchPrompt) {
      this.logger.warn('No dispatch prompt, defaulting to default workflow');
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

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 256,
        system: this.dispatchPrompt,
        messages: [
          {
            role: 'user',
            content: userMessage,
          },
        ],
      });

      // Extract text from response
      const textContent = response.content.find((c: { type: string }) => c.type === 'text');
      if (!textContent || textContent.type !== 'text') {
        throw new Error('No text content in response');
      }

      const result = this.parseResponse(textContent.text);
      this.logger.info('Dispatch result', {
        workflow: result.workflow,
        title: result.title,
      });

      return result;
    } catch (error) {
      this.logger.error('Dispatch failed, using fallback', error);
      return {
        workflow: 'default',
        title: this.generateFallbackTitle(userMessage),
      };
    }
  }

  /**
   * Parse dispatch response (JSON format)
   */
  private parseResponse(text: string): DispatchResult {
    try {
      // Try to extract JSON from response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          workflow: this.validateWorkflow(parsed.workflow),
          title: parsed.title || this.generateFallbackTitle(''),
        };
      }

      // Fallback: try to parse legacy XML format
      const workflowMatch = text.match(/<workflow>([^<]+)<\/workflow>/);
      const titleMatch = text.match(/<title>([^<]+)<\/title>/);

      if (workflowMatch) {
        return {
          workflow: this.validateWorkflow(workflowMatch[1].trim()),
          title: titleMatch ? titleMatch[1].trim() : this.generateFallbackTitle(''),
        };
      }

      throw new Error('Could not parse dispatch response');
    } catch (error) {
      this.logger.warn('Failed to parse dispatch response', { text, error });
      return {
        workflow: 'default',
        title: this.generateFallbackTitle(''),
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
