/**
 * RED (autoz): Auto-mode safety classifier (SSOT-4).
 *
 * Auto mode consults a classifier "subagent" for the ambiguous middle (a
 * dangerous-rule hit) instead of escalating straight to the user. The
 * classifier returns `allow` (auto-approve) or `ask` (escalate to the human).
 * It MUST fail closed: any backend error / timeout / unparseable answer →
 * `ask`, so auto mode can never be *less* safe than asking.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  LlmSafetyClassifier,
  parseSafetyVerdict,
  type SafetyClassifyRequest,
  StaticSafetyClassifier,
} from '../safety-classifier';

const REQ: SafetyClassifyRequest = {
  toolName: 'Bash',
  command: 'rm -rf /tmp/U1/build/cache',
  toolInput: { command: 'rm -rf /tmp/U1/build/cache' },
  matchedRuleIds: ['rm-recursive'],
  cwd: '/tmp/U1/repo',
  user: 'U1',
};

describe('parseSafetyVerdict', () => {
  it('parses a clean allow JSON', () => {
    expect(parseSafetyVerdict('{"verdict":"allow","reason":"scoped to user tmp"}').verdict).toBe('allow');
  });

  it('parses a clean ask JSON', () => {
    expect(parseSafetyVerdict('{"verdict":"ask","reason":"targets root"}').verdict).toBe('ask');
  });

  it('parses JSON embedded in prose / code fences', () => {
    const raw = 'Sure:\n```json\n{"verdict":"allow","reason":"ok"}\n```';
    expect(parseSafetyVerdict(raw).verdict).toBe('allow');
  });

  it('fails closed to ask on garbage', () => {
    expect(parseSafetyVerdict('lol idk').verdict).toBe('ask');
    expect(parseSafetyVerdict('').verdict).toBe('ask');
  });
});

describe('LlmSafetyClassifier', () => {
  it('returns allow when the backend says allow', async () => {
    const chat = vi.fn().mockResolvedValue('{"verdict":"allow","reason":"sandboxed tmp"}');
    const c = new LlmSafetyClassifier(chat, { timeoutMs: 5000 });
    const v = await c.classify(REQ);
    expect(v.verdict).toBe('allow');
    expect(chat).toHaveBeenCalledOnce();
    // the prompt must carry the concrete command + matched rule for context
    const prompt = chat.mock.calls[0][0] as string;
    expect(prompt).toContain('rm -rf /tmp/U1/build/cache');
    expect(prompt).toContain('rm-recursive');
  });

  it('escalates (ask) when the backend says ask', async () => {
    const chat = vi.fn().mockResolvedValue('{"verdict":"ask","reason":"unscoped"}');
    const v = await new LlmSafetyClassifier(chat).classify(REQ);
    expect(v.verdict).toBe('ask');
  });

  it('fails closed to ask when the backend throws', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('timeout'));
    const v = await new LlmSafetyClassifier(chat).classify(REQ);
    expect(v.verdict).toBe('ask');
  });

  it('fails closed to ask on unparseable backend output', async () => {
    const chat = vi.fn().mockResolvedValue('no idea');
    const v = await new LlmSafetyClassifier(chat).classify(REQ);
    expect(v.verdict).toBe('ask');
  });
});

describe('StaticSafetyClassifier', () => {
  it('always escalates to ask (no-LLM fallback == old bypass behaviour)', async () => {
    const v = await new StaticSafetyClassifier().classify(REQ);
    expect(v.verdict).toBe('ask');
  });
});
