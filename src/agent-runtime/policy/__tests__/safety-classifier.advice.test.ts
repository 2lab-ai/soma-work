/**
 * SSOT 2026-11-02 T2 — every permission prompt the user sees carries the
 * auto-mode guardian's advice: what the call does, why it is risky, and
 * whether to accept it (`approve` | `deny`).
 *
 * The guardian already judges the escalated call; it now answers with the
 * advice in the same JSON, so a prompt costs no second model call.
 */

import { describe, expect, it, vi } from 'vitest';
import { LlmSafetyClassifier, parseSafetyVerdict, type SafetyClassifyRequest } from '../safety-classifier';

const REQ: SafetyClassifyRequest = {
  toolName: 'Bash',
  command: 'rm -rf ./build',
  toolInput: { command: 'rm -rf ./build' },
  matchedRuleIds: ['rm-recursive'],
  cwd: '/tmp/U1/repo',
  user: 'U1',
};

describe('parseSafetyVerdict — advice (T2)', () => {
  it('reads the advice next to the verdict', () => {
    const v = parseSafetyVerdict(
      '{"verdict":"ask","recommendation":"deny","summary":"저장소 전체를 지웁니다","risk":"되돌릴 수 없습니다","reason":"broad delete"}',
    );
    expect(v.verdict).toBe('ask');
    expect(v.advice).toEqual({ recommendation: 'deny', summary: '저장소 전체를 지웁니다', risk: '되돌릴 수 없습니다' });
  });

  it('reads an approve recommendation', () => {
    const v = parseSafetyVerdict(
      '{"verdict":"ask","recommendation":"approve","summary":"빌드 폴더를 지웁니다","risk":"빌드 산출물만 사라집니다"}',
    );
    expect(v.advice?.recommendation).toBe('approve');
  });

  it('has no advice when the recommendation is missing or not one of approve / deny', () => {
    expect(parseSafetyVerdict('{"verdict":"ask","reason":"x"}').advice).toBeUndefined();
    expect(
      parseSafetyVerdict('{"verdict":"ask","recommendation":"maybe","summary":"a","risk":"b"}').advice,
    ).toBeUndefined();
  });

  it('cuts long advice text', () => {
    const long = 'x'.repeat(5000);
    const v = parseSafetyVerdict(JSON.stringify({ verdict: 'ask', recommendation: 'deny', summary: long, risk: long }));
    expect(v.advice?.summary.length).toBeLessThanOrEqual(400);
    expect(v.advice?.risk.length).toBeLessThanOrEqual(400);
  });

  it('still fails closed to ask, with no advice, on garbage', () => {
    const v = parseSafetyVerdict('not json');
    expect(v.verdict).toBe('ask');
    expect(v.advice).toBeUndefined();
  });
});

describe('LlmSafetyClassifier — the prompt asks for the advice (T2)', () => {
  it('asks what the call does, why it is risky, and approve or deny', async () => {
    const chat = vi
      .fn()
      .mockResolvedValue('{"verdict":"ask","recommendation":"deny","summary":"s","risk":"r","reason":"x"}');
    const v = await new LlmSafetyClassifier(chat, { timeoutMs: 5000 }).classify(REQ);
    const prompt = chat.mock.calls[0][0] as string;
    expect(prompt).toContain('"recommendation"');
    expect(prompt).toContain('"summary"');
    expect(prompt).toContain('"risk"');
    expect(v.advice).toEqual({ recommendation: 'deny', summary: 's', risk: 'r' });
  });

  it('says no static rule flagged the call when none did (a prompt with no dangerous-rule hit)', async () => {
    const chat = vi.fn().mockResolvedValue('{"verdict":"ask","recommendation":"approve","summary":"s","risk":"r"}');
    await new LlmSafetyClassifier(chat, { timeoutMs: 5000 }).classify({
      ...REQ,
      toolName: 'Write',
      command: '',
      toolInput: { file_path: '/tmp/U1/repo/a.txt', content: 'hello' },
      matchedRuleIds: [],
    });
    const prompt = chat.mock.calls[0][0] as string;
    expect(prompt).not.toContain('A static rule already flagged');
    // A non-Bash call is shown by its input.
    expect(prompt).toContain('/tmp/U1/repo/a.txt');
  });
});
