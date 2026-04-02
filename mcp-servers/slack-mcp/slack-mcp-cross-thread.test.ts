import { describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * RED Contract Tests for slack-mcp cross-thread access
 *
 * These tests verify the contract defined in docs/slack-mcp-cross-thread/trace.md.
 * All tests should FAIL (RED) until implementation is complete.
 */

// ── Scenario 1: Context passes both threads ─────────────────

describe('Scenario 1: Context passes both threads', () => {
  // Trace: S1, Section 3a — mcp-config-builder passes both thread references
  it('SLACK_MCP_CONTEXT includes work threadTs as primary (not sourceThreadTs)', async () => {
    const configBuilder = await fs.readFile(
      path.resolve(__dirname, '..', '..', 'src', 'mcp-config-builder.ts'),
      'utf-8'
    );
    // After change: threadTs should be slackContext.threadTs (work thread),
    // NOT sourceThreadTs || threadTs (which collapses to source)
    // The buildSlackMcpServer should NOT collapse source into threadTs
    expect(configBuilder).not.toMatch(
      /const threadTs\s*=\s*slackContext\.sourceThreadTs\s*\|\|\s*slackContext\.threadTs/
    );
  });

  // Trace: S1, Section 3a — context includes sourceThreadTs field
  it('SLACK_MCP_CONTEXT passes sourceThreadTs to MCP server', async () => {
    const configBuilder = await fs.readFile(
      path.resolve(__dirname, '..', '..', 'src', 'mcp-config-builder.ts'),
      'utf-8'
    );
    // threadContext object must include sourceThreadTs
    expect(configBuilder).toMatch(/sourceThreadTs.*slackContext\.sourceThreadTs/);
  });

  // Trace: S1, Section 3a — context includes sourceChannel field
  it('SLACK_MCP_CONTEXT passes sourceChannel to MCP server', async () => {
    const configBuilder = await fs.readFile(
      path.resolve(__dirname, '..', '..', 'src', 'mcp-config-builder.ts'),
      'utf-8'
    );
    expect(configBuilder).toMatch(/sourceChannel.*slackContext\.sourceChannel/);
  });
});

// ── Scenario 2: Read source thread messages ─────────────────

describe('Scenario 2: Read source thread messages', () => {
  // Trace: S2, Section 2 — get_thread_messages has thread parameter
  it('get_thread_messages tool definition includes thread parameter', async () => {
    const serverPath = path.resolve(__dirname, 'slack-mcp-server.ts');
    const source = await fs.readFile(serverPath, 'utf-8');
    // Tool input schema must have a "thread" property
    expect(source).toMatch(/get_thread_messages[\s\S]*?thread[\s\S]*?source.*work/);
  });

  // Trace: S2, Section 3a — resolveThread helper exists
  it('resolveThread private method exists', async () => {
    const serverPath = path.resolve(__dirname, 'slack-mcp-server.ts');
    const source = await fs.readFile(serverPath, 'utf-8');
    expect(source).toContain('resolveThread');
  });

  // Trace: S2, Section 3a — resolveThread uses sourceThreadTs for "source"
  it('resolveThread returns sourceThreadTs when thread is "source"', async () => {
    const serverPath = path.resolve(__dirname, 'slack-mcp-server.ts');
    const source = await fs.readFile(serverPath, 'utf-8');
    expect(source).toMatch(/resolveThread[\s\S]*?source[\s\S]*?sourceThreadTs/);
  });
});

// ── Scenario 3: Read work thread messages (backward compat) ──

describe('Scenario 3: Read work thread messages (backward compat)', () => {
  // Trace: S3, Section 3a — default thread is "work"
  it('get_thread_messages defaults to work thread when no thread param', async () => {
    const serverPath = path.resolve(__dirname, 'slack-mcp-server.ts');
    const source = await fs.readFile(serverPath, 'utf-8');
    // resolveThread should return work thread (this.context.channel/threadTs) when no param
    expect(source).toMatch(/resolveThread[\s\S]*?this\.context\.channel[\s\S]*?this\.context\.threadTs/);
  });
});

// ── Scenario 4: Send message to source thread ───────────────

describe('Scenario 4: Send message to source thread', () => {
  // Trace: S4, Section 3a — send_thread_message tool exists
  it('send_thread_message tool is registered', async () => {
    const serverPath = path.resolve(__dirname, 'slack-mcp-server.ts');
    const source = await fs.readFile(serverPath, 'utf-8');
    expect(source).toContain("name: 'send_thread_message'");
  });

  // Trace: S4, Section 2 — text is required
  it('send_thread_message requires text parameter', async () => {
    const serverPath = path.resolve(__dirname, 'slack-mcp-server.ts');
    const source = await fs.readFile(serverPath, 'utf-8');
    expect(source).toMatch(/send_thread_message[\s\S]*?required.*text/);
  });

  // Trace: S4, Section 3b — uses chat.postMessage
  it('send_thread_message uses chat.postMessage', async () => {
    const serverPath = path.resolve(__dirname, 'slack-mcp-server.ts');
    const source = await fs.readFile(serverPath, 'utf-8');
    expect(source).toContain('chat.postMessage');
  });

  // Trace: S4, Section 3a — has thread parameter for source/work selection
  it('send_thread_message has thread parameter', async () => {
    const serverPath = path.resolve(__dirname, 'slack-mcp-server.ts');
    const source = await fs.readFile(serverPath, 'utf-8');
    expect(source).toMatch(/send_thread_message[\s\S]*?thread[\s\S]*?source.*work/);
  });
});

// ── Scenario 5: Source thread unavailable error ──────────────

describe('Scenario 5: Source thread unavailable error', () => {
  // Trace: S5, Section 3a — resolveThread throws when source unavailable
  it('resolveThread throws error when sourceThreadTs is absent and thread is "source"', async () => {
    const serverPath = path.resolve(__dirname, 'slack-mcp-server.ts');
    const source = await fs.readFile(serverPath, 'utf-8');
    expect(source).toMatch(/No source thread available/);
  });

  // Trace: S5, Section 2 — types include optional source fields
  it('SlackMcpContext type includes sourceThreadTs field', async () => {
    const typesPath = path.resolve(__dirname, 'types.ts');
    const source = await fs.readFile(typesPath, 'utf-8');
    expect(source).toContain('sourceThreadTs');
  });

  // Trace: S5, Section 2 — types include optional source channel
  it('SlackMcpContext type includes sourceChannel field', async () => {
    const typesPath = path.resolve(__dirname, 'types.ts');
    const source = await fs.readFile(typesPath, 'utf-8');
    expect(source).toContain('sourceChannel');
  });
});

// ── Cross-cutting: Version bump ──────────────────────────────

describe('Cross-cutting: Version bump', () => {
  // Trace: Auto-Decision — version bump to 4.0.0
  it('server version is 4.0.0', async () => {
    const serverPath = path.resolve(__dirname, 'slack-mcp-server.ts');
    const source = await fs.readFile(serverPath, 'utf-8');
    expect(source).toContain("'4.0.0'");
  });
});
