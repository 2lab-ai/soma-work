/**
 * AgentInstance — Individual sub-agent (independent Slack Bot).
 *
 * Each instance owns:
 *  - A Slack Bolt App (separate bot/app token)
 *  - A ClaudeHandler with agent-specific PromptBuilder
 *  - An isolated SessionRegistry
 *
 * Trace: docs/multi-agent/trace.md, Scenarios 2, 3
 */

import { App } from '@slack/bolt';
import { Logger } from './logger';
import type { McpManager } from './mcp-manager';
import { PromptBuilder } from './prompt-builder';
import { SessionRegistry } from './session-registry';
import type { AgentConfig } from './types';

export interface AgentInfo {
  name: string;
  description?: string;
  model?: string;
  running: boolean;
}

export class AgentInstance {
  private logger: Logger;
  private app: App | null = null;
  private sessionRegistry: SessionRegistry;
  private promptBuilder: PromptBuilder;
  private _running = false;

  constructor(
    public readonly name: string,
    private config: AgentConfig,
    _mcpManager: McpManager,
  ) {
    this.logger = new Logger(`Agent:${name}`);
    this.sessionRegistry = new SessionRegistry();
    this.promptBuilder = new PromptBuilder({
      agentName: name,
      promptDir: config.promptDir,
    });
  }

  /**
   * Get the prompt directory for this agent (for testing).
   */
  getPromptDir(): string {
    return this.promptBuilder.getPromptDir();
  }

  /**
   * Get the session registry for this agent (for testing).
   */
  getSessionRegistry(): SessionRegistry {
    return this.sessionRegistry;
  }

  get running(): boolean {
    return this._running;
  }

  getInfo(): AgentInfo {
    return {
      name: this.name,
      description: this.config.description,
      model: this.config.model,
      running: this._running,
    };
  }

  /**
   * Start the agent's Slack App and set up event handlers.
   * Trace: docs/multi-agent/trace.md, Scenario 2, Section 3b
   */
  async start(): Promise<void> {
    if (this._running) {
      this.logger.warn(`Agent '${this.name}' is already running — skipping start`);
      return;
    }

    this.logger.info(`Starting agent '${this.name}'...`);

    const app = new App({
      token: this.config.slackBotToken,
      signingSecret: this.config.signingSecret,
      socketMode: true,
      appToken: this.config.slackAppToken,
    });

    // TODO: Wire up SlackHandler for this agent's App instance
    // For now, set up a basic message handler
    app.event('app_mention', async ({ event, say: _say }) => {
      this.logger.info(`Agent '${this.name}' received mention`, {
        user: event.user,
        channel: event.channel,
      });
      // Full SlackHandler integration will be wired in Phase 2
    });

    app.event('message', async ({ event, say: _say }) => {
      // Handle DMs to this agent
      if ('channel_type' in event && event.channel_type === 'im') {
        this.logger.info(`Agent '${this.name}' received DM`, {
          user: 'user' in event ? event.user : 'unknown',
        });
      }
    });

    try {
      await app.start();
    } catch (error) {
      // Clean up partially created App to prevent resource leak
      await app.stop().catch(() => {});
      throw error;
    }

    this.app = app;
    this._running = true;
    this.logger.info(`Agent '${this.name}' started`);
  }

  /**
   * Stop the agent's Slack App and clean up.
   * Trace: docs/multi-agent/trace.md, Scenario 7, Section 3b
   */
  async stop(): Promise<void> {
    this.logger.info(`Stopping agent '${this.name}'...`);
    try {
      if (this.app) {
        await this.app.stop();
      }
    } finally {
      this._running = false;
      this.app = null;
      this.logger.info(`Agent '${this.name}' stopped`);
    }
  }

  /**
   * Get the agent's PromptBuilder (for agent_chat MCP).
   */
  getPromptBuilder(): PromptBuilder {
    return this.promptBuilder;
  }

  /**
   * Get the agent's config.
   */
  getConfig(): AgentConfig {
    return { ...this.config };
  }
}
