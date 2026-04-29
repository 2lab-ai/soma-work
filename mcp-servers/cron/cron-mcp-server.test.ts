/**
 * cron-mcp-server — Characterization tests for handleCreate.
 *
 * These tests lock in the existing behaviour (validation branches, error
 * messages, success message format) before refactoring `handleCreate` into
 * smaller helpers. They MUST stay green across the refactor.
 *
 * Trace: issue #748 complexity hotspots
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the MCP SDK so importing the module under test does not pull in real
// stdio plumbing. The `if (require.main === module)` guard already prevents
// auto-start, but the imports themselves still need to resolve.
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class MockServer {
    constructor(_info: any, _opts?: any) {}
    setRequestHandler(_schema: any, _handler: any) {}
    connect() {}
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {},
}));

vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  CallToolRequestSchema: 'CallToolRequestSchema',
  ListToolsRequestSchema: 'ListToolsRequestSchema',
}));

vi.mock('somalib/stderr-logger.js', () => ({
  StderrLogger: class {
    debug() {}
    info() {}
    warn() {}
    error() {}
  },
}));

import { CronStorage } from 'somalib/cron/cron-storage';
import { handleCreate } from './cron-mcp-server';

const baseContext = { user: 'U_TEST', channel: 'C_DEFAULT' };

describe('handleCreate', () => {
  let storage: CronStorage;
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `cron-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    storage = new CronStorage(tmpFile);
  });

  afterEach(() => {
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
    try {
      fs.unlinkSync(tmpFile + '.tmp');
    } catch {}
    try {
      fs.unlinkSync(tmpFile.replace(/\.json$/, '-history.json'));
    } catch {}
  });

  // --- Validation: required args ---

  it('rejects missing name', () => {
    const r = handleCreate({ expression: '* * * * *', prompt: 'hi' }, baseContext, storage);
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Error: name, expression, and prompt are required');
  });

  it('rejects missing expression', () => {
    const r = handleCreate({ name: 'job', prompt: 'hi' }, baseContext, storage);
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Error: name, expression, and prompt are required');
  });

  it('rejects missing prompt', () => {
    const r = handleCreate({ name: 'job', expression: '* * * * *' }, baseContext, storage);
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Error: name, expression, and prompt are required');
  });

  // --- Validation: name ---

  it('rejects invalid cron name', () => {
    const r = handleCreate(
      { name: 'bad name!', expression: '* * * * *', prompt: 'hi' },
      baseContext,
      storage,
    );
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      "Error: Invalid cron name 'bad name!'. Use alphanumeric, hyphens, underscores (1-64 chars)",
    );
  });

  // --- Validation: expression ---

  it('rejects invalid cron expression', () => {
    const r = handleCreate(
      { name: 'job', expression: 'not-a-cron', prompt: 'hi' },
      baseContext,
      storage,
    );
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      "Error: Invalid cron expression 'not-a-cron'. Use 5-field format: min hour dom mon dow",
    );
  });

  // --- Validation: prompt ---

  it('rejects empty prompt', () => {
    const r = handleCreate(
      { name: 'job', expression: '* * * * *', prompt: '' },
      baseContext,
      storage,
    );
    // Empty string is falsy — caught by the missing-required check first.
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Error: name, expression, and prompt are required');
  });

  it('rejects oversize prompt (>4000 chars)', () => {
    const big = 'x'.repeat(4001);
    const r = handleCreate(
      { name: 'job', expression: '* * * * *', prompt: big },
      baseContext,
      storage,
    );
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Error: prompt must be a non-empty string (max 4000 chars)');
  });

  it('rejects non-string prompt', () => {
    const r = handleCreate(
      { name: 'job', expression: '* * * * *', prompt: 12345 },
      baseContext,
      storage,
    );
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Error: prompt must be a non-empty string (max 4000 chars)');
  });

  // --- Validation: channel ---

  it('rejects invalid channel (no prefix)', () => {
    const r = handleCreate(
      { name: 'job', expression: '* * * * *', prompt: 'hi', channel: 'badchan' },
      baseContext,
      storage,
    );
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Error: Invalid channel 'badchan'");
  });

  it('rejects when context channel is also invalid', () => {
    const r = handleCreate(
      { name: 'job', expression: '* * * * *', prompt: 'hi' },
      { user: 'U1', channel: 'unknown' },
      storage,
    );
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Error: Invalid channel 'unknown'");
  });

  // --- Validation: mode ---

  it('rejects invalid mode', () => {
    const r = handleCreate(
      { name: 'job', expression: '* * * * *', prompt: 'hi', channel: 'C123', mode: 'turbo' },
      baseContext,
      storage,
    );
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Error: Invalid mode 'turbo'. Use 'default' or 'fastlane'");
  });

  // --- Validation: target ---

  it('rejects invalid target', () => {
    const r = handleCreate(
      { name: 'job', expression: '* * * * *', prompt: 'hi', channel: 'C123', target: 'email' },
      baseContext,
      storage,
    );
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Error: Invalid target 'email'. Use 'channel', 'thread', or 'dm'");
  });

  it('rejects target=thread without threadTs', () => {
    const r = handleCreate(
      { name: 'job', expression: '* * * * *', prompt: 'hi', channel: 'C123', target: 'thread' },
      baseContext,
      storage,
    );
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Error: threadTs is required when target is "thread"');
  });

  // --- Validation: model_type ---

  it('rejects invalid model_type', () => {
    const r = handleCreate(
      {
        name: 'job',
        expression: '* * * * *',
        prompt: 'hi',
        channel: 'C123',
        model_type: 'wizard',
      },
      baseContext,
      storage,
    );
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Error: Invalid model_type 'wizard'. Use 'default', 'fast', or 'custom'");
  });

  it('rejects model_type=custom without model_name', () => {
    const r = handleCreate(
      {
        name: 'job',
        expression: '* * * * *',
        prompt: 'hi',
        channel: 'C123',
        model_type: 'custom',
      },
      baseContext,
      storage,
    );
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Error: model_name is required when model_type is "custom"');
  });

  // --- Storage: duplicate ---

  it('rejects duplicate name (DUPLICATE_NAME path)', () => {
    const args = {
      name: 'dup-job',
      expression: '* * * * *',
      prompt: 'first',
      channel: 'C123',
    };
    const first = handleCreate(args, baseContext, storage);
    expect(first.isError).toBe(false);

    const second = handleCreate({ ...args, prompt: 'second' }, baseContext, storage);
    expect(second.isError).toBe(true);
    expect(second.text).toBe("Error: Cron job 'dup-job' already exists for this user");
  });

  // --- Success paths ---

  it('creates job (default mode, default model, default target)', () => {
    const r = handleCreate(
      {
        name: 'simple',
        expression: '0 9 * * 1-5',
        prompt: 'standup',
        channel: 'C100',
      },
      baseContext,
      storage,
    );
    expect(r.isError).toBe(false);
    // Format: Cron job '${name}' created.\nID: ...\nExpression: ...\nChannel: ...${modeStr}${modelStr}${targetStr}\nPrompt: ...
    expect(r.text).toMatch(/^Cron job 'simple' created\.\nID: [^\n]+\nExpression: 0 9 \* \* 1-5\nChannel: C100\nPrompt: standup$/);
  });

  it('creates job with mode=fastlane (modeStr appears)', () => {
    const r = handleCreate(
      {
        name: 'fast',
        expression: '* * * * *',
        prompt: 'hi',
        channel: 'C100',
        mode: 'fastlane',
      },
      baseContext,
      storage,
    );
    expect(r.isError).toBe(false);
    expect(r.text).toContain(' | mode: fastlane');
    // Order: ...Channel: C100 | mode: fastlane\nPrompt: hi
    expect(r.text).toMatch(/Channel: C100 \| mode: fastlane\nPrompt: hi$/);
  });

  it('creates job with model_type=fast', () => {
    const r = handleCreate(
      {
        name: 'fast-model',
        expression: '* * * * *',
        prompt: 'hi',
        channel: 'C100',
        model_type: 'fast',
      },
      baseContext,
      storage,
    );
    expect(r.isError).toBe(false);
    expect(r.text).toContain(' | model: fast');
    expect(r.text).not.toContain(' | model: fast(');
  });

  it('creates job with model_type=custom + model_name (modelStr includes model)', () => {
    const r = handleCreate(
      {
        name: 'custom-model',
        expression: '* * * * *',
        prompt: 'hi',
        channel: 'C100',
        model_type: 'custom',
        model_name: 'claude-sonnet-4-20250514',
        reasoning_effort: 'high',
        fast_mode: true,
      },
      baseContext,
      storage,
    );
    expect(r.isError).toBe(false);
    expect(r.text).toContain(' | model: custom(claude-sonnet-4-20250514)');
  });

  it('creates job with model_type=default (no modelStr)', () => {
    const r = handleCreate(
      {
        name: 'default-model',
        expression: '* * * * *',
        prompt: 'hi',
        channel: 'C100',
        model_type: 'default',
      },
      baseContext,
      storage,
    );
    expect(r.isError).toBe(false);
    expect(r.text).not.toContain(' | model:');
  });

  it('creates job with target=dm (targetStr appears)', () => {
    const r = handleCreate(
      {
        name: 'dm-job',
        expression: '* * * * *',
        prompt: 'hi',
        channel: 'D100',
        target: 'dm',
      },
      baseContext,
      storage,
    );
    expect(r.isError).toBe(false);
    expect(r.text).toContain(' | target: dm');
    expect(r.text).toMatch(/Channel: D100 \| target: dm\nPrompt: hi$/);
  });

  it('creates job with target=thread + threadTs', () => {
    const r = handleCreate(
      {
        name: 'thread-job',
        expression: '* * * * *',
        prompt: 'hi',
        channel: 'C100',
        target: 'thread',
        threadTs: '1234.5678',
      },
      baseContext,
      storage,
    );
    expect(r.isError).toBe(false);
    expect(r.text).toContain(' | target: thread');
  });

  it('creates job with all optional segments combined (mode + model + target order)', () => {
    const r = handleCreate(
      {
        name: 'full-stack',
        expression: '* * * * *',
        prompt: 'hi',
        channel: 'C100',
        mode: 'fastlane',
        model_type: 'custom',
        model_name: 'claude-sonnet-4-20250514',
        target: 'thread',
        threadTs: '1.2',
      },
      baseContext,
      storage,
    );
    expect(r.isError).toBe(false);
    // Order is: Channel: ${channel}${modeStr}${modelStr}${targetStr}\nPrompt
    expect(r.text).toMatch(
      /Channel: C100 \| mode: fastlane \| model: custom\(claude-sonnet-4-20250514\) \| target: thread\nPrompt: hi$/,
    );
  });

  it('falls back to context.channel when args.channel omitted', () => {
    const r = handleCreate(
      { name: 'ctx-chan', expression: '* * * * *', prompt: 'hi' },
      { user: 'U1', channel: 'C_FROM_CTX' },
      storage,
    );
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Channel: C_FROM_CTX');
  });
});
