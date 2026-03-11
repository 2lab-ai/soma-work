/**
 * Agent module - Multi-Agent Architecture
 *
 * Exports core types, registry, and client for agent management.
 */

export type {
  AgentRole,
  AgentTransportType,
  AgentTransport,
  AgentDescriptor,
  AgentHealthStatus,
  AgentHealthCheck,
  AgentTaskType,
  AgentTaskPayload,
  AgentTaskRequest,
  AgentTaskResult,
  AgentConfig,
  AgentHealthResponse,
  AgentExecuteRequest,
  AgentExecuteResponse,
} from './types';

export { AgentRegistry } from './registry';
export { AgentClient } from './agent-client';
