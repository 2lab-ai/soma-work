#!/usr/bin/env node

/**
 * Codex Sub-Agent - Standalone Entry Point
 *
 * Runs the codex sub-agent as an independent process with:
 * - CodexService: wraps McpClient → codex mcp-server
 * - CodexHttpApi: exposes HTTP endpoints for main agent communication
 *
 * Usage:
 *   tsx src/sub-agents/codex/index.ts
 *   # or via npm script:
 *   npm run start:agent:codex
 *
 * Environment variables:
 *   CODEX_AGENT_PORT  - HTTP port (default: 9100)
 *   CODEX_AGENT_HOST  - HTTP host (default: 127.0.0.1)
 *   CODEX_DEFAULT_MODEL - Default model (default: gpt-5.3-codex)
 */

import { CodexService } from './codex-service';
import { CodexHttpApi } from './http-api';
import { Logger } from '../../logger';

const logger = new Logger('CodexAgent');

async function main() {
  const defaultModel = process.env.CODEX_DEFAULT_MODEL || 'gpt-5.3-codex';
  const port = parseInt(process.env.CODEX_AGENT_PORT || '9100', 10);
  const host = process.env.CODEX_AGENT_HOST || '127.0.0.1';

  logger.info('Starting Codex Sub-Agent', { defaultModel, port, host });

  // Initialize service
  const service = new CodexService(defaultModel);

  // Start codex MCP backend
  try {
    await service.start();
    logger.info('Codex MCP backend started');
  } catch (error) {
    logger.error('Failed to start codex backend', error);
    logger.warn('Codex backend will be started lazily on first request');
  }

  // Start HTTP API
  const api = new CodexHttpApi(service, { port, host });
  await api.start();

  logger.info(`⚡ Codex sub-agent running on http://${host}:${port}`);

  // Periodic session cleanup (every 30 minutes)
  const CLEANUP_INTERVAL = 30 * 60 * 1000;
  setInterval(() => {
    service.cleanupStaleSessions();
  }, CLEANUP_INTERVAL);

  // Graceful shutdown
  const cleanup = async () => {
    logger.info('Shutting down codex sub-agent...');
    await api.stop();
    await service.stop();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  process.on('uncaughtException', (error) => {
    console.error('CRASH: codex sub-agent uncaught exception', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('CRASH: codex sub-agent unhandled rejection', reason);
    process.exit(1);
  });
}

main().catch((error) => {
  logger.error('Failed to start codex sub-agent', error);
  process.exit(1);
});
