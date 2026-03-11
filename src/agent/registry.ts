/**
 * AgentRegistry - Manages sub-agent registration, discovery, and health monitoring.
 *
 * Starts with static configuration (config.json) and can evolve to
 * dynamic registration. Runs periodic health checks against registered agents.
 */

import { Logger } from '../logger';
import {
  AgentDescriptor,
  AgentHealthCheck,
  AgentHealthStatus,
  AgentConfig,
} from './types';
import { AgentClient } from './agent-client';

const DEFAULT_HEALTH_CHECK_INTERVAL = 30_000; // 30 seconds

export class AgentRegistry {
  private logger = new Logger('AgentRegistry');
  private agents = new Map<string, AgentDescriptor>();
  private health = new Map<string, AgentHealthCheck>();
  private clients = new Map<string, AgentClient>();
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private healthCheckIntervalMs: number;

  constructor(config?: AgentConfig) {
    this.healthCheckIntervalMs = config?.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL;

    if (config?.agents) {
      for (const agent of config.agents) {
        this.register(agent);
      }
    }
  }

  // ── Registration ──────────────────────────────────────────

  /**
   * Register a new agent
   */
  register(descriptor: AgentDescriptor): void {
    if (this.agents.has(descriptor.id)) {
      this.logger.warn('Agent already registered, updating', { agentId: descriptor.id });
    }

    this.agents.set(descriptor.id, descriptor);
    this.health.set(descriptor.id, {
      agentId: descriptor.id,
      status: 'unknown',
      latencyMs: 0,
      checkedAt: 0,
    });

    // Create HTTP client for sub-agents
    if (descriptor.role === 'sub') {
      this.clients.set(
        descriptor.id,
        new AgentClient(descriptor),
      );
    }

    this.logger.info('Agent registered', {
      agentId: descriptor.id,
      role: descriptor.role,
      capabilities: descriptor.capabilities,
      transport: descriptor.transport.baseUrl,
    });
  }

  /**
   * Unregister an agent
   */
  unregister(agentId: string): boolean {
    const existed = this.agents.delete(agentId);
    this.health.delete(agentId);
    this.clients.delete(agentId);

    if (existed) {
      this.logger.info('Agent unregistered', { agentId });
    }
    return existed;
  }

  // ── Discovery ─────────────────────────────────────────────

  /**
   * Get agent by ID
   */
  get(agentId: string): AgentDescriptor | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Get HTTP client for an agent
   */
  getClient(agentId: string): AgentClient | undefined {
    return this.clients.get(agentId);
  }

  /**
   * Find agents with a specific capability
   */
  findByCapability(capability: string): AgentDescriptor[] {
    return Array.from(this.agents.values())
      .filter(a => a.capabilities.includes(capability));
  }

  /**
   * Get all registered agents
   */
  getAll(): AgentDescriptor[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get all sub-agents (excluding main)
   */
  getSubAgents(): AgentDescriptor[] {
    return this.getAll().filter(a => a.role === 'sub');
  }

  // ── Health Monitoring ─────────────────────────────────────

  /**
   * Get health status for an agent
   */
  getHealth(agentId: string): AgentHealthCheck | undefined {
    return this.health.get(agentId);
  }

  /**
   * Get health status for all agents
   */
  getAllHealth(): AgentHealthCheck[] {
    return Array.from(this.health.values());
  }

  /**
   * Check health of a specific agent
   */
  async checkHealth(agentId: string): Promise<AgentHealthCheck> {
    const client = this.clients.get(agentId);
    if (!client) {
      const check: AgentHealthCheck = {
        agentId,
        status: 'unknown',
        latencyMs: 0,
        checkedAt: Date.now(),
        error: 'No client available',
      };
      this.health.set(agentId, check);
      return check;
    }

    const start = Date.now();
    try {
      const response = await client.healthCheck();
      const latencyMs = Date.now() - start;

      const check: AgentHealthCheck = {
        agentId,
        status: response.status,
        latencyMs,
        checkedAt: Date.now(),
        details: {
          activeSessions: response.activeSessions,
          uptime: response.uptime,
          version: response.version,
        },
      };

      this.health.set(agentId, check);
      return check;
    } catch (error) {
      const latencyMs = Date.now() - start;
      const check: AgentHealthCheck = {
        agentId,
        status: 'unhealthy',
        latencyMs,
        checkedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      };
      this.health.set(agentId, check);
      return check;
    }
  }

  /**
   * Check health of all registered sub-agents
   */
  async checkAllHealth(): Promise<AgentHealthCheck[]> {
    const subAgents = this.getSubAgents();
    const results = await Promise.allSettled(
      subAgents.map(a => this.checkHealth(a.id)),
    );

    return results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      return {
        agentId: subAgents[i].id,
        status: 'unhealthy' as AgentHealthStatus,
        latencyMs: 0,
        checkedAt: Date.now(),
        error: r.reason?.message || 'Health check failed',
      };
    });
  }

  /**
   * Start periodic health checks
   */
  startHealthChecks(): void {
    if (this.healthCheckTimer) return;

    this.logger.info('Starting periodic health checks', {
      intervalMs: this.healthCheckIntervalMs,
      agentCount: this.getSubAgents().length,
    });

    this.healthCheckTimer = setInterval(async () => {
      try {
        const results = await this.checkAllHealth();
        const unhealthy = results.filter(r => r.status === 'unhealthy');
        if (unhealthy.length > 0) {
          this.logger.warn('Unhealthy agents detected', {
            unhealthy: unhealthy.map(r => ({ id: r.agentId, error: r.error })),
          });
        }
      } catch (error) {
        this.logger.error('Health check cycle failed', error);
      }
    }, this.healthCheckIntervalMs);
  }

  /**
   * Stop periodic health checks
   */
  stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
      this.logger.info('Stopped periodic health checks');
    }
  }

  /**
   * Format registry state for display (Slack)
   */
  formatForDisplay(): string {
    const agents = this.getAll();
    if (agents.length === 0) {
      return '_No agents registered._';
    }

    const lines: string[] = [];
    for (const agent of agents) {
      const health = this.health.get(agent.id);
      const statusEmoji = this.statusEmoji(health?.status ?? 'unknown');
      lines.push(`${statusEmoji} *${agent.id}* (${agent.role})`);
      lines.push(`  Capabilities: ${agent.capabilities.join(', ')}`);
      lines.push(`  Transport: ${agent.transport.baseUrl}`);
      if (health?.latencyMs) {
        lines.push(`  Latency: ${health.latencyMs}ms`);
      }
      if (health?.error) {
        lines.push(`  Error: ${health.error}`);
      }
      lines.push('');
    }

    return lines.join('\n').trimEnd();
  }

  private statusEmoji(status: AgentHealthStatus): string {
    switch (status) {
      case 'healthy': return '🟢';
      case 'degraded': return '🟡';
      case 'unhealthy': return '🔴';
      default: return '⚪';
    }
  }
}
