/**
 * Multi-Agent Architecture - Core Type Definitions
 *
 * Defines the contracts for agent registration, task delegation,
 * inter-agent communication, and health monitoring.
 *
 * Design: Main Agent orchestrates Sub Agents via typed RPC (HTTP).
 * Slack is ingress/egress only — agent-to-agent uses these types.
 */

// ── Agent Identity & Registration ──────────────────────────

export type AgentRole = 'main' | 'sub';

export type AgentTransportType = 'http';

export interface AgentTransport {
  type: AgentTransportType;
  baseUrl: string;
  /** Request timeout in ms (default: 600_000 for LLM calls) */
  timeoutMs: number;
}

/**
 * Describes a registered agent's identity and capabilities.
 * Used by the registry to route tasks to the correct agent.
 */
export interface AgentDescriptor {
  /** Unique agent identifier (e.g., "codex", "gemini", "reviewer") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Agent role in the hierarchy */
  role: AgentRole;
  /** What this agent can do (e.g., ["llm_chat", "code_review"]) */
  capabilities: string[];
  /** How to reach this agent */
  transport: AgentTransport;
  /** Optional: default LLM model for this agent */
  defaultModel?: string;
  /** Optional: additional metadata */
  metadata?: Record<string, unknown>;
}

// ── Agent Health ───────────────────────────────────────────

export type AgentHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface AgentHealthCheck {
  agentId: string;
  status: AgentHealthStatus;
  /** Latency of health check in ms */
  latencyMs: number;
  /** Last time health was checked */
  checkedAt: number;
  /** Error message if unhealthy */
  error?: string;
  /** Agent-reported details (e.g., active sessions, memory usage) */
  details?: Record<string, unknown>;
}

// ── Task Protocol ──────────────────────────────────────────

export type AgentTaskType = 'llm_chat' | 'llm_chat_reply' | 'health_check';

export interface AgentTaskPayload {
  type: AgentTaskType;
  /** For llm_chat: the prompt to send */
  prompt?: string;
  /** For llm_chat: model to use */
  model?: string;
  /** For llm_chat: working directory */
  cwd?: string;
  /** For llm_chat: config overrides */
  config?: Record<string, unknown>;
  /** For llm_chat_reply: session ID from previous chat */
  sessionId?: string;
}

/**
 * A task request sent from main agent to sub agent
 */
export interface AgentTaskRequest {
  /** Unique request ID for tracking/correlation */
  requestId: string;
  /** Source context (where the request originated) */
  source: {
    channel: string;
    threadTs?: string;
    userId: string;
  };
  /** Target agent ID */
  targetAgentId: string;
  /** Task payload */
  task: AgentTaskPayload;
  /** Request timestamp */
  requestedAt: number;
}

/**
 * A task result returned from sub agent to main agent
 */
export interface AgentTaskResult {
  /** Correlation ID matching the request */
  requestId: string;
  /** Agent that processed the task */
  agentId: string;
  /** Whether the task succeeded */
  ok: boolean;
  /** Response content (for llm_chat) */
  content?: string;
  /** Session ID for follow-up (for llm_chat) */
  sessionId?: string;
  /** Model used */
  model?: string;
  /** Backend used */
  backend?: string;
  /** Processing time in ms */
  durationMs?: number;
  /** Error details if not ok */
  error?: {
    code: string;
    message: string;
    retriable: boolean;
  };
}

// ── Registry Configuration ─────────────────────────────────

/**
 * Agent configuration in config.json
 */
export interface AgentConfig {
  /** Agent definitions */
  agents: AgentDescriptor[];
  /** Health check interval in ms (default: 30_000) */
  healthCheckIntervalMs?: number;
  /** Max retries for failed tasks */
  maxRetries?: number;
}

// ── HTTP API Types ─────────────────────────────────────────

/**
 * Health check response from sub-agent HTTP API
 */
export interface AgentHealthResponse {
  agentId: string;
  status: AgentHealthStatus;
  uptime: number;
  activeSessions: number;
  version: string;
}

/**
 * Task execution request body for sub-agent HTTP API
 */
export interface AgentExecuteRequest {
  requestId: string;
  task: AgentTaskPayload;
  source?: {
    channel: string;
    threadTs?: string;
    userId: string;
  };
}

/**
 * Task execution response from sub-agent HTTP API
 */
export interface AgentExecuteResponse {
  requestId: string;
  ok: boolean;
  content?: string;
  sessionId?: string;
  model?: string;
  backend?: string;
  durationMs?: number;
  error?: {
    code: string;
    message: string;
    retriable: boolean;
  };
}
