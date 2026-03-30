#!/usr/bin/env node

/**
 * Agent MCP Server — agent_chat / agent_reply tools.
 *
 * Mirrors the llm-mcp-server pattern:
 *  - chat: Start a new conversation with a named sub-agent
 *  - chat-reply: Continue an existing agent conversation
 *
 * The server receives agent configurations via SOMA_AGENT_CONFIGS env var
 * and creates per-agent Claude queries using the agent's system prompt.
 *
 * Trace: docs/multi-agent/trace.md, Scenarios 4, 5
 */

import { BaseMcpServer } from '../_shared/base-mcp-server.js';
import type { ToolDefinition, ToolResult } from '../_shared/base-mcp-server.js';
import { randomUUID } from 'crypto';

// ── Types ──────────────────────────────────────────────────

interface AgentConfigEntry {
  promptDir?: string;
  persona?: string;
  description?: string;
  model?: string;
}

interface AgentSession {
  agentName: string;
  sessionId: string;
  model: string;
  // Future: Claude SDK session ID for continuity
  claudeSessionId?: string;
}

// ── Config ─────────────────────────────────────────────────

function loadAgentConfigs(): Record<string, AgentConfigEntry> {
  const raw = process.env.SOMA_AGENT_CONFIGS;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ── Server ─────────────────────────────────────────────────

export class AgentMCPServer extends BaseMcpServer {
  private agentConfigs: Record<string, AgentConfigEntry>;
  private sessions = new Map<string, AgentSession>();

  constructor() {
    super('agent-mcp-server');
    this.agentConfigs = loadAgentConfigs();
  }

  defineTools(): ToolDefinition[] {
    return [
      {
        name: 'chat',
        description: 'Start a new chat session with a named sub-agent. The agent has its own system prompt and persona.',
        inputSchema: {
          type: 'object',
          properties: {
            agent: {
              type: 'string',
              description: 'Agent name (e.g., "jangbi", "gwanu"). Must match a configured agent.',
            },
            prompt: {
              type: 'string',
              description: 'The prompt to send to the agent.',
            },
            config: {
              type: 'object',
              description: 'Optional configuration overrides.',
              additionalProperties: true,
            },
          },
          required: ['agent', 'prompt'],
        },
      },
      {
        name: 'chat-reply',
        description: 'Continue an existing agent chat session.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              description: 'The session ID from a previous agent chat call.',
            },
            prompt: {
              type: 'string',
              description: 'The prompt to continue the conversation.',
            },
          },
          required: ['sessionId', 'prompt'],
        },
      },
    ];
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'chat':
        return await this.handleChat(args);
      case 'chat-reply':
        return await this.handleChatReply(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /**
   * Handle agent_chat: start a new conversation with a sub-agent.
   * Trace: docs/multi-agent/trace.md, Scenario 4
   */
  private async handleChat(args: Record<string, unknown>): Promise<ToolResult> {
    const agentName = args.agent as string;
    const prompt = args.prompt as string;

    // Validate agent exists
    if (!agentName || !this.agentConfigs[agentName]) {
      throw new Error(`Unknown agent: '${agentName}'. Available agents: [${Object.keys(this.agentConfigs).join(', ')}]`);
    }

    // Validate prompt
    if (!prompt || prompt.trim().length === 0) {
      throw new Error('Prompt is required and must not be empty.');
    }

    const agentConfig = this.agentConfigs[agentName];
    const model = agentConfig.model || 'claude-sonnet-4-20250514';

    this.logger.info(`agent_chat: routing to agent '${agentName}'`, { model });

    // Create a new session
    const sessionId = randomUUID();

    // TODO: In full implementation, create a Claude SDK query() with the agent's
    // system prompt. For now, return a placeholder response indicating the agent
    // was reached. The actual Claude query integration requires wiring up
    // ClaudeHandler in the MCP server context.
    const content = `[Agent '${agentName}'] Received prompt. Agent query integration pending full wiring.`;

    // Store session
    const session: AgentSession = {
      agentName,
      sessionId,
      model,
    };
    this.sessions.set(sessionId, session);

    this.logger.info(`agent_chat: query complete`, { sessionId, agentName });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          sessionId,
          content,
          agentName,
          model,
        }),
      }],
    };
  }

  /**
   * Handle agent_reply: continue an existing agent conversation.
   * Trace: docs/multi-agent/trace.md, Scenario 5
   */
  private async handleChatReply(args: Record<string, unknown>): Promise<ToolResult> {
    const sessionId = args.sessionId as string;
    const prompt = args.prompt as string;

    // Validate session exists
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) {
      throw new Error(`Unknown session: '${sessionId}'. Use 'chat' first to start a session.`);
    }

    // Validate prompt
    if (!prompt || prompt.trim().length === 0) {
      throw new Error('Prompt is required and must not be empty.');
    }

    this.logger.info(`agent_reply: continuing session ${sessionId} with agent '${session.agentName}'`);

    // TODO: Continue Claude SDK query with stored session context
    const content = `[Agent '${session.agentName}'] Reply received. Continuation integration pending.`;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          sessionId,
          content,
          agentName: session.agentName,
        }),
      }],
    };
  }
}

// ── Main ───────────────────────────────────────────────────

const server = new AgentMCPServer();
server.run().catch((error) => {
  console.error('Failed to start Agent MCP Server', error);
  process.exit(1);
});
