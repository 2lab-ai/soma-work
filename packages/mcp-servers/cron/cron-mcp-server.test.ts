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

vi.mock('@soma/process-shared/stderr-logger.js', () => ({
  StderrLogger: class {
    debug() {}
    info() {}
    warn() {}
    error() {}
  },
}));

import { CronStorage } from '@soma/process-shared/cron/cron-storage';
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
    const r = handleCreate({ name: 'bad name!', expression: '* * * * *', prompt: 'hi' }, baseContext, storage);
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Error: Invalid cron name 'bad name!'. Use alphanumeric, hyphens, underscores (1-64 chars)");
  });

  // --- Validation: expression ---

  it('rejects invalid cron expression', () => {
    const r = handleCreate({ name: 'job', expression: 'not-a-cron', prompt: 'hi' }, baseContext, storage);
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Error: Invalid cron expression 'not-a-cron'. Use 5-field format: min hour dom mon dow");
  });

  // --- Validation: prompt ---

  it('rejects empty prompt', () => {
    const r = handleCreate({ name: 'job', expression: '* * * * *', prompt: '' }, baseContext, storage);
    // Empty string is falsy — caught by the missing-required check first.
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Error: name, expression, and prompt are required');
  });

  it('rejects oversize prompt (>4000 chars)', () => {
    const big = 'x'.repeat(4001);
    const r = handleCreate({ name: 'job', expression: '* * * * *', prompt: big }, baseContext, storage);
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Error: prompt must be a non-empty string (max 4000 chars)');
  });

  it('rejects non-string prompt', () => {
    const r = handleCreate({ name: 'job', expression: '* * * * *', prompt: 12345 }, baseContext, storage);
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
    expect(r.text).toMatch(
      /^Cron job 'simple' created\.\nID: [^\n]+\nExpression: 0 9 \* \* 1-5\nChannel: C100\nPrompt: standup$/,
    );
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

// ---------------------------------------------------------------------------
// cron manage UI (cron/schedule keyword flow) — handleUpdate / handleList /
// handleDelete admin scoping. Trace: session goal "cron 스케줄러 관리 UI"
// ---------------------------------------------------------------------------

import { handleDelete, handleList, handleUpdate } from './cron-mcp-server';

const ownerContext = { user: 'U_OWNER', channel: 'C_DEFAULT' };
const otherContext = { user: 'U_OTHER', channel: 'C_DEFAULT' };
const adminContext = { user: 'U_ADMIN', channel: 'C_DEFAULT', isAdmin: true };

function freshStorage(): { storage: CronStorage; cleanup: () => void } {
  const file = path.join(os.tmpdir(), `cron-mcp-mgmt-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const storage = new CronStorage(file);
  return {
    storage,
    cleanup: () => {
      for (const f of [file, file + '.tmp', file.replace(/\.json$/, '-history.json')]) {
        try {
          fs.unlinkSync(f);
        } catch {}
      }
    },
  };
}

function seedJob(storage: CronStorage, over: Record<string, any> = {}) {
  return storage.addJob({
    name: 'daily',
    expression: '0 9 * * *',
    prompt: 'standup',
    owner: 'U_OWNER',
    channel: 'C111',
    threadTs: null,
    ...over,
  });
}

describe('handleUpdate', () => {
  let storage: CronStorage;
  let cleanup: () => void;

  beforeEach(() => {
    ({ storage, cleanup } = freshStorage());
  });
  afterEach(() => cleanup());

  it('rejects missing name', () => {
    const r = handleUpdate({}, ownerContext, storage);
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Error: name is required');
  });

  it('rejects unknown job', () => {
    const r = handleUpdate({ name: 'nope', prompt: 'x' }, ownerContext, storage);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Cron job 'nope' not found");
  });

  it('rejects empty patch (nothing to update)', () => {
    seedJob(storage);
    const r = handleUpdate({ name: 'daily' }, ownerContext, storage);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('nothing to update');
  });

  it('changes model to a specific model (model_type=custom)', () => {
    seedJob(storage);
    const r = handleUpdate({ name: 'daily', model_type: 'custom', model_name: 'gpt-5.5' }, ownerContext, storage);
    expect(r.isError).toBe(false);
    expect(storage.getJobsByOwner('U_OWNER')[0].modelConfig).toEqual({ type: 'custom', model: 'gpt-5.5' });
  });

  it('model_type=default clears override → creator current model at fire time', () => {
    seedJob(storage, { modelConfig: { type: 'custom', model: 'gpt-5.5' } });
    const r = handleUpdate({ name: 'daily', model_type: 'default' }, ownerContext, storage);
    expect(r.isError).toBe(false);
    expect(storage.getJobsByOwner('U_OWNER')[0].modelConfig).toBeUndefined();
  });

  it('rejects model_type=custom without model_name', () => {
    seedJob(storage);
    const r = handleUpdate({ name: 'daily', model_type: 'custom' }, ownerContext, storage);
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Error: model_name is required when model_type is "custom"');
  });

  it('changes target to dm and clears threadTs', () => {
    seedJob(storage, { target: 'thread', threadTs: '1.2' });
    const r = handleUpdate({ name: 'daily', target: 'dm' }, ownerContext, storage);
    expect(r.isError).toBe(false);
    const job = storage.getJobsByOwner('U_OWNER')[0];
    expect(job.target).toBe('dm');
    expect(job.threadTs).toBeNull();
  });

  it('changes target to channel: clears target key and threadTs', () => {
    seedJob(storage, { target: 'dm', threadTs: '1.2' });
    const r = handleUpdate({ name: 'daily', target: 'channel' }, ownerContext, storage);
    expect(r.isError).toBe(false);
    const job = storage.getJobsByOwner('U_OWNER')[0];
    expect(job.target).toBeUndefined();
    expect(job.threadTs).toBeNull();
  });

  it('target=thread requires a threadTs (arg or existing)', () => {
    seedJob(storage);
    const r = handleUpdate({ name: 'daily', target: 'thread' }, ownerContext, storage);
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Error: threadTs is required when target is "thread"');

    const ok = handleUpdate({ name: 'daily', target: 'thread', threadTs: '9.9' }, ownerContext, storage);
    expect(ok.isError).toBe(false);
    const job = storage.getJobsByOwner('U_OWNER')[0];
    expect(job.target).toBe('thread');
    expect(job.threadTs).toBe('9.9');
  });

  it('rejects invalid expression', () => {
    seedJob(storage);
    const r = handleUpdate({ name: 'daily', expression: 'nope' }, ownerContext, storage);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Invalid cron expression');
  });

  it('rejects invalid channel', () => {
    seedJob(storage);
    const r = handleUpdate({ name: 'daily', channel: 'bad' }, ownerContext, storage);
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Error: Invalid channel 'bad'");
  });

  it('non-admin cannot pass owner to touch another user job', () => {
    seedJob(storage);
    const r = handleUpdate({ name: 'daily', owner: 'U_OWNER', prompt: 'x' }, otherContext, storage);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('admin');
  });

  it('admin updates another user job via owner param', () => {
    seedJob(storage);
    const r = handleUpdate({ name: 'daily', owner: 'U_OWNER', model_type: 'fast' }, adminContext, storage);
    expect(r.isError).toBe(false);
    expect(storage.getJobsByOwner('U_OWNER')[0].modelConfig).toEqual({ type: 'fast' });
  });

  it('admin without owner param does not silently edit others — requires owner', () => {
    seedJob(storage);
    const r = handleUpdate({ name: 'daily', prompt: 'x' }, adminContext, storage);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('owner');
  });
});

describe('handleList admin scoping', () => {
  let storage: CronStorage;
  let cleanup: () => void;

  beforeEach(() => {
    ({ storage, cleanup } = freshStorage());
    seedJob(storage); // U_OWNER
    seedJob(storage, {
      name: 'other-job',
      owner: 'U_OTHER',
      target: 'dm',
      modelConfig: { type: 'custom', model: 'gpt-5.5' },
    });
  });
  afterEach(() => cleanup());

  it('non-admin sees only own jobs, without owner column', () => {
    const r = handleList(ownerContext, storage);
    expect(r.isError).toBe(false);
    expect(r.text).toContain('daily');
    expect(r.text).not.toContain('other-job');
    expect(r.text).not.toContain('owner:');
  });

  it('admin sees all jobs with owner shown', () => {
    const r = handleList(adminContext, storage);
    expect(r.isError).toBe(false);
    expect(r.text).toContain('daily');
    expect(r.text).toContain('other-job');
    expect(r.text).toContain('owner:<@U_OWNER>');
    expect(r.text).toContain('owner:<@U_OTHER>');
  });

  it('renders model and output target explicitly, including defaults', () => {
    const r = handleList(ownerContext, storage);
    // default model = creator's current model at fire time
    expect(r.text).toContain('model:default(creator current model)');
    expect(r.text).toContain('target:channel');
    const rAdmin = handleList(adminContext, storage);
    expect(rAdmin.text).toContain('model:custom(gpt-5.5)');
    expect(rAdmin.text).toContain('target:dm');
  });
});

describe('handleDelete admin scoping', () => {
  let storage: CronStorage;
  let cleanup: () => void;

  beforeEach(() => {
    ({ storage, cleanup } = freshStorage());
    seedJob(storage);
  });
  afterEach(() => cleanup());

  it('non-admin cannot delete another user job via owner param', () => {
    const r = handleDelete({ name: 'daily', owner: 'U_OWNER' }, otherContext, storage);
    expect(r.isError).toBe(true);
    expect(storage.getJobsByOwner('U_OWNER')).toHaveLength(1);
  });

  it('admin deletes another user job via owner param', () => {
    const r = handleDelete({ name: 'daily', owner: 'U_OWNER' }, adminContext, storage);
    expect(r.isError).toBe(false);
    expect(storage.getJobsByOwner('U_OWNER')).toHaveLength(0);
  });
});
