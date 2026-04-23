/**
 * Tests for the Bolt Assistant container factory (#666 Part 1/2).
 *
 * Tests exercise `buildAssistantConfig(deps)` directly against the raw
 * `AssistantConfig` object so we do not need to mock the `Assistant`
 * constructor. See docs/slack-ui-phase4.md (§Tests) for rationale.
 */
import { Assistant } from '@slack/bolt';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASSISTANT_VIEW_TITLE,
  buildAssistantConfig,
  createAssistantContainer,
  SUGGESTED_PROMPTS_PLACEHOLDER,
} from './assistant-container';

const createDeps = () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
  const handleMessage = vi.fn().mockResolvedValue(undefined);
  return { logger, handleMessage };
};

describe('assistant-container — buildAssistantConfig', () => {
  let deps: ReturnType<typeof createDeps>;
  beforeEach(() => {
    deps = createDeps();
  });

  // Case 1
  it('returns an object with required threadStarted and userMessage functions', () => {
    const cfg = buildAssistantConfig(deps);
    expect(typeof cfg.threadStarted).toBe('function');
    expect(typeof cfg.userMessage).toBe('function');
  });

  // Case 2 — Bolt default context store
  it('does not define threadContextChanged (Bolt default store in use)', () => {
    const cfg = buildAssistantConfig(deps);
    expect('threadContextChanged' in cfg).toBe(false);
  });

  // Case 3 — happy-path prompts dispatch
  it('threadStarted calls setSuggestedPrompts once with 4 placeholder prompts and the expected title', async () => {
    const cfg = buildAssistantConfig(deps);
    const setSuggestedPrompts = vi.fn().mockResolvedValue(undefined);
    const middlewareArgs = { setSuggestedPrompts } as any;

    await (cfg.threadStarted as any)(middlewareArgs);

    expect(setSuggestedPrompts).toHaveBeenCalledTimes(1);
    const payload = setSuggestedPrompts.mock.calls[0][0];
    expect(payload.title).toBe(ASSISTANT_VIEW_TITLE);
    expect(payload.prompts).toHaveLength(4);
    expect(payload.prompts).toEqual(SUGGESTED_PROMPTS_PLACEHOLDER);
  });

  // Case 4 — scope-missing failure does not throw
  it('threadStarted swallows setSuggestedPrompts failures with a warn log', async () => {
    const cfg = buildAssistantConfig(deps);
    const setSuggestedPrompts = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope' } }));
    const middlewareArgs = { setSuggestedPrompts } as any;

    await expect((cfg.threadStarted as any)(middlewareArgs)).resolves.toBeUndefined();

    expect(deps.logger.warn).toHaveBeenCalledTimes(1);
    const [msg, meta] = deps.logger.warn.mock.calls[0];
    expect(msg).toContain('setSuggestedPrompts');
    expect(meta?.error).toContain('missing_scope');
  });

  // Case 5 — delegate to handleMessage
  it('userMessage delegates to deps.handleMessage with original message and say', async () => {
    const cfg = buildAssistantConfig(deps);
    const message = { channel: 'D123', user: 'U1', ts: '1.0', text: 'hi' } as any;
    const say = vi.fn().mockResolvedValue({ ts: 'msg123' });
    const middlewareArgs = { message, say } as any;

    await (cfg.userMessage as any)(middlewareArgs);

    expect(deps.handleMessage).toHaveBeenCalledTimes(1);
    expect(deps.handleMessage).toHaveBeenCalledWith(message, say);
  });

  // Case 6 — propagate handleMessage errors
  it('userMessage propagates handleMessage rejections (global error handler takes over)', async () => {
    deps.handleMessage.mockRejectedValueOnce(new Error('boom'));
    const cfg = buildAssistantConfig(deps);
    const middlewareArgs = { message: {}, say: vi.fn() } as any;

    await expect((cfg.userMessage as any)(middlewareArgs)).rejects.toThrow('boom');
  });

  // Case 7 — placeholder constants invariants
  it('SUGGESTED_PROMPTS_PLACEHOLDER has 4 non-empty prompts', () => {
    expect(SUGGESTED_PROMPTS_PLACEHOLDER).toHaveLength(4);
    for (const p of SUGGESTED_PROMPTS_PLACEHOLDER) {
      expect(p.title).toBeTruthy();
      expect(p.message).toBeTruthy();
      expect(typeof p.title).toBe('string');
      expect(typeof p.message).toBe('string');
    }
  });
});

describe('assistant-container — createAssistantContainer', () => {
  // Case 8
  it('returns an instanceof Bolt Assistant', () => {
    const deps = createDeps();
    const instance = createAssistantContainer(deps);
    expect(instance).toBeInstanceOf(Assistant);
  });
});
