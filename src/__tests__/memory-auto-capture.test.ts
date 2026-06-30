/**
 * Deterministic tests for the session-end "dreaming" consolidation
 * (`consolidateUserMemory`). The only piece needing live auth — the LLM call —
 * is injected, so the full orchestration (episodic read → prompt assembly →
 * JSON parse → L1 apply → dream-state write) is verified end-to-end.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HierarchicalMemoryFileStore, memoryRoot } from 'somalib/model-commands/hierarchical-memory-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ConsolidationDeps, consolidateUserMemory } from '../memory-auto-capture';

describe('consolidateUserMemory (session-end dreaming)', () => {
  let dataDir: string;
  let store: HierarchicalMemoryFileStore;
  const user = 'U_dream';

  // In-memory L1 so we can assert what the consolidation wrote.
  let l1: { memory: string[]; user: string[] };
  let replaceCalls: Array<{ target: string; entries: string[]; expectedOld?: string[] }>;

  function makeDeps(runQuery: ConsolidationDeps['runQuery']): Partial<ConsolidationDeps> {
    return {
      store,
      l1Load: (_u, target) => ({ entries: l1[target] }),
      l1ReplaceAll: (_u, target, entries, expectedOld) => {
        replaceCalls.push({ target, entries, expectedOld });
        l1[target] = entries;
        return { ok: true };
      },
      runQuery,
      dataDir,
    };
  }

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dreaming-'));
    store = new HierarchicalMemoryFileStore(dataDir);
    l1 = { memory: ['existing memory fact'], user: [] };
    replaceCalls = [];
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('reads episodic, calls the LLM, applies L1, and writes dream-state', async () => {
    store.appendEpisodic(user, 'User prefers KRW price tables.');
    store.appendEpisodic(user, 'Repo builds with bun not npm.');

    const runQuery = vi.fn(async (_prompt: string) =>
      JSON.stringify({
        memory: ['Repo builds with bun, not npm.'],
        user: ['Prefers concise KRW price tables.'],
      }),
    );

    const ran = await consolidateUserMemory(user, makeDeps(runQuery));
    expect(ran).toBe(true);

    // LLM was invoked with a prompt carrying the episodic observations + L1.
    expect(runQuery).toHaveBeenCalledTimes(1);
    const prompt = runQuery.mock.calls[0][0];
    expect(prompt).toContain('Repo builds with bun not npm.');
    expect(prompt).toContain('existing memory fact');

    // L1 was rewritten from the parsed LLM output.
    expect(l1.memory).toEqual(['Repo builds with bun, not npm.']);
    expect(l1.user).toEqual(['Prefers concise KRW price tables.']);
    expect(replaceCalls.map((c) => c.target).sort()).toEqual(['memory', 'user']);

    // CAS: the pre-LLM snapshot is passed as expectedOld so a concurrent
    // SAVE_MEMORY during the (multi-second) LLM call is not silently clobbered.
    const memCall = replaceCalls.find((c) => c.target === 'memory');
    expect(memCall?.expectedOld).toEqual(['existing memory fact']);

    // dream-state recorded.
    const dreamState = JSON.parse(fs.readFileSync(path.join(memoryRoot(dataDir, user), '.dream-state.json'), 'utf-8'));
    expect(dreamState.lastDreamAt).toBeGreaterThan(0);
  });

  it('returns false and skips the LLM when there is no episodic memory', async () => {
    const runQuery = vi.fn(async () => '{}');
    const ran = await consolidateUserMemory(user, makeDeps(runQuery));
    expect(ran).toBe(false);
    expect(runQuery).not.toHaveBeenCalled();
    expect(replaceCalls).toEqual([]);
  });

  it('still completes (dream-state written, no throw) when LLM output is unparseable', async () => {
    store.appendEpisodic(user, 'some observation');
    const runQuery = vi.fn(async () => 'not json at all');

    const ran = await consolidateUserMemory(user, makeDeps(runQuery));
    expect(ran).toBe(true);
    expect(replaceCalls).toEqual([]); // L1 untouched
    expect(fs.existsSync(path.join(memoryRoot(dataDir, user), '.dream-state.json'))).toBe(true);
  });

  it('returns false (never throws) when the LLM query throws', async () => {
    store.appendEpisodic(user, 'obs');
    const runQuery = vi.fn(async () => {
      throw new Error('auth slot unavailable');
    });
    const ran = await consolidateUserMemory(user, makeDeps(runQuery));
    expect(ran).toBe(false);
    expect(replaceCalls).toEqual([]);
  });

  it('ignores non-array / empty LLM fields without error', async () => {
    store.appendEpisodic(user, 'obs');
    const runQuery = vi.fn(async () => JSON.stringify({ memory: 'oops-not-array', user: [] }));
    const ran = await consolidateUserMemory(user, makeDeps(runQuery));
    expect(ran).toBe(true);
    expect(replaceCalls).toEqual([]); // neither field applied
  });
});
