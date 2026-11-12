/**
 * The model the session-end "dreaming" pass runs on.
 *
 * Call path: session-registry fireSessionConsolidate → consolidateUserMemory →
 * runConsolidationQuery. Dreaming is a `sonnet`-tier aux call made for ONE user:
 * the tier follows that user's default model's provider (Claude → `sonnet`,
 * Codex → `terra`, Grok → `grok` at effort medium), resolved through the alias
 * table at call time. `SUMMARY_MODEL` stays a hard operator override.
 *
 * The real `config` is used (the vitest setup strips SUMMARY_MODEL), so this
 * also pins that the config default no longer pins a Claude Sonnet id.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HierarchicalMemoryFileStore } from 'somalib/model-commands/hierarchical-memory-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../credentials-manager', () => {
  class FakeNoHealthySlotError extends Error {}
  const lease = { slotId: 's', accessToken: 't', kind: 'setup_token' as const, release: vi.fn(async () => {}) };
  return { ensureActiveSlotAuth: vi.fn(async () => lease), NoHealthySlotError: FakeNoHealthySlotError };
});
vi.mock('../token-manager', () => ({ getTokenManager: vi.fn(() => ({})) }));
vi.mock('../auth/llmux-tenant-keys', () => ({ ensureTenantKey: vi.fn(async () => null) }));
vi.mock('../auth/query-env-builder', () => ({ buildQueryEnv: vi.fn(() => ({ env: { FAKE: '1' } })) }));

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

import { config } from '../config';
import { consolidateUserMemory } from '../memory-auto-capture';
import { AVAILABLE_MODELS, MODEL_ALIASES, userSettingsStore } from '../user-settings-store';

const USER = 'U_dream_model';

/** The SDK options of the single dreaming query. */
function dreamingOptions(): { model?: string; effort?: string } {
  expect(queryMock).toHaveBeenCalledTimes(1);
  return (queryMock.mock.calls[0][0] as { options: { model?: string; effort?: string } }).options;
}

describe('dreaming (consolidateUserMemory) model', () => {
  let dataDir: string;
  let store: HierarchicalMemoryFileStore;
  const originalSummaryModel = config.conversation.summaryModel;

  async function dream(): Promise<boolean> {
    return consolidateUserMemory(USER, {
      store,
      l1Load: () => ({ entries: [] }),
      l1ReplaceAll: () => ({ ok: true }),
      dataDir,
    });
  }

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-model-'));
    store = new HierarchicalMemoryFileStore(dataDir);
    store.appendEpisodic(USER, 'Repo builds with bun not npm.');
    queryMock.mockReset();
    queryMock.mockImplementation(() =>
      (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: '{"memory":["m"],"user":["u"]}' }] } };
      })(),
    );
  });

  afterEach(() => {
    config.conversation.summaryModel = originalSummaryModel;
    vi.restoreAllMocks();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('SUMMARY_MODEL unset → the config carries no pinned summary model', () => {
    expect(config.conversation.summaryModel).toBeUndefined();
  });

  it("a Claude user's dreaming runs the `sonnet` alias (resolved), not a pinned Sonnet id", async () => {
    vi.spyOn(userSettingsStore, 'getUserDefaultModel').mockReturnValue('claude-opus-5-5[1m]');
    expect(await dream()).toBe(true);
    expect(dreamingOptions().model).toBe(MODEL_ALIASES.sonnet);
    expect(dreamingOptions().effort).toBeUndefined();
  });

  it("a Codex user's dreaming runs the `terra` alias", async () => {
    vi.spyOn(userSettingsStore, 'getUserDefaultModel').mockReturnValue('gpt-6.1-sol[1m]');
    expect(await dream()).toBe(true);
    expect(dreamingOptions().model).toBe(MODEL_ALIASES.terra);
  });

  it("a Grok user's dreaming runs grok at effort medium", async () => {
    vi.spyOn(userSettingsStore, 'getUserDefaultModel').mockReturnValue('grok-4.7');
    expect(await dream()).toBe(true);
    const opts = dreamingOptions();
    expect(AVAILABLE_MODELS as readonly string[]).toContain(opts.model);
    expect(opts.model).toMatch(/^grok-/);
    expect(opts.effort).toBe('medium');
  });

  it('the main model is the dreaming user’s own default', async () => {
    const spy = vi.spyOn(userSettingsStore, 'getUserDefaultModel').mockReturnValue('claude-opus-5-5[1m]');
    await dream();
    expect(spy).toHaveBeenCalledWith(USER);
  });

  it('SUMMARY_MODEL (operator override) still wins as-is', async () => {
    vi.spyOn(userSettingsStore, 'getUserDefaultModel').mockReturnValue('gpt-6.1-sol[1m]');
    config.conversation.summaryModel = 'claude-sonnet-4-6';
    expect(await dream()).toBe(true);
    expect(dreamingOptions().model).toBe('claude-sonnet-4-6');
    expect(dreamingOptions().effort).toBeUndefined();
  });
});
