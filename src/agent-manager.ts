/**
 * AgentManager — Manages lifecycle of all sub-agent instances.
 *
 * Responsibilities:
 *  - Start/stop all agents
 *  - Provide agent lookup for agent_chat/agent_reply MCP
 *  - Error isolation: one agent failure doesn't affect others
 *
 * Trace: docs/multi-agent/trace.md, Scenarios 2, 4, 5, 7
 */

import type { AgentConfig } from './types';
import { AgentInstance, AgentInfo } from './agent-instance';
import { McpManager } from './mcp-manager';
import { Logger } from './logger';

export interface AgentQueryResult {
  sessionId: string;
  content: string;
  agentName: string;
  model: string;
}

export class AgentManager {
  private logger = new Logger('AgentManager');
  private agents = new Map<string, AgentInstance>();
  private agentConfigs: Record<string, AgentConfig>;

  constructor(
    agentConfigs: Record<string, AgentConfig>,
    private mcpManager: McpManager,
  ) {
    this.agentConfigs = agentConfigs;

    // Pre-create instances (not started yet)
    for (const [name, config] of Object.entries(agentConfigs)) {
      this.agents.set(name, new AgentInstance(name, config, mcpManager));
    }
  }

  /**
   * Start all configured agents.
   * Failures are isolated — one agent failing doesn't block others.
   * Trace: docs/multi-agent/trace.md, Scenario 2
   */
  async startAll(): Promise<void> {
    const total = this.agents.size;
    if (total === 0) {
      this.logger.info('AgentManager: no agents configured');
      return;
    }

    let started = 0;
    const errors: string[] = [];
    const failedNames: string[] = [];

    for (const [name, instance] of this.agents) {
      try {
        await instance.start();
        started++;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        failedNames.push(name);
        errors.push(`${name}: ${msg}`);
        this.logger.error(`Agent '${name}' failed to start: ${msg}`);
      }
    }

    // Remove failed agents after iteration (never mutate Map during for...of)
    for (const name of failedNames) {
      this.agents.delete(name);
    }

    this.logger.info(`AgentManager: ${started}/${total} agents started successfully`);
    if (errors.length > 0) {
      this.logger.warn('Failed agents:', { errors });
    }
  }

  /**
   * Stop all running agents.
   * Failures are isolated.
   * Trace: docs/multi-agent/trace.md, Scenario 7
   */
  async stopAll(): Promise<void> {
    for (const [name, instance] of this.agents) {
      try {
        await instance.stop();
        this.logger.info(`Agent '${name}' stopped`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Agent '${name}' failed to stop: ${msg}`);
        // Continue stopping others
      }
    }
    this.logger.info('AgentManager: all agents stopped');
  }

  /**
   * Get a specific agent instance.
   */
  getAgent(name: string): AgentInstance | undefined {
    return this.agents.get(name);
  }

  /**
   * List all agents with their status.
   */
  listAgents(): AgentInfo[] {
    return Array.from(this.agents.values()).map(a => a.getInfo());
  }

  /**
   * Check if an agent exists.
   */
  hasAgent(name: string): boolean {
    return this.agents.has(name);
  }

  /**
   * Get agent config (for MCP server to access).
   */
  getAgentConfig(name: string): AgentConfig | undefined {
    return this.agentConfigs[name];
  }

  /**
   * Get all agent configs (for MCP server env injection).
   */
  getAllAgentConfigs(): Record<string, AgentConfig> {
    return { ...this.agentConfigs };
  }
}
