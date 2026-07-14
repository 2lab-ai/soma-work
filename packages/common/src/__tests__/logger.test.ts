import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger, safeJsonStringify } from '../logger';

describe('safeJsonStringify', () => {
  it('is byte-identical to JSON.stringify for serializable payloads', () => {
    const data = { a: 1, b: 'x', c: [1, 2], d: { e: null }, f: new Date(0) };
    expect(safeJsonStringify(data)).toBe(JSON.stringify(data));
    expect(safeJsonStringify(data, 2)).toBe(JSON.stringify(data, null, 2));
  });

  it('does not throw on circular structures and marks the cycle', () => {
    // Regression: 2026-07-10 — options.mcpServers carried an in-process SDK
    // MCP server instance whose ajv SchemaEnv has `root: this`. The raw
    // JSON.stringify in formatMessage threw and killed every Slack turn.
    const env: Record<string, unknown> = { schema: {} };
    env.root = env; // ajv SchemaEnv shape: `this.root = $.root || this`
    const options = { model: 'x', mcpServers: { 'permission-prompt': { instance: { env } } } };
    const out = safeJsonStringify(options);
    expect(out).toContain('[Circular]');
    expect(out).toContain('"model":"x"');
  });

  it('does not throw on BigInt', () => {
    expect(safeJsonStringify({ n: 10n })).toContain('"10n"');
  });

  it('stringifies undefined-producing inputs instead of returning undefined', () => {
    expect(typeof safeJsonStringify(undefined)).toBe('string');
  });
});

describe('Logger with circular data', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('info() with a circular payload logs instead of throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.root = circular;
    const logger = new Logger('Test');
    expect(() => logger.info('circular payload', circular)).not.toThrow();
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0][0])).toContain('[Circular]');
  });
});
