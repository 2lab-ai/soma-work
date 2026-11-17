import { describe, expect, it } from 'vitest';
import { buildCallSystemPrompt, formatPhoneNumber, isBareGreeting } from '../phone-prompt';

describe('buildCallSystemPrompt (.prd/30 D5)', () => {
  const now = new Date('2026-11-17T06:30:00Z');

  it('layers the phone rules, the environment instruction and this call', () => {
    const p = buildCallSystemPrompt({
      direction: 'outbound',
      peerNumber: '01012345678',
      ourNumber: '07012345678',
      title: '반품 재통화',
      purpose: '반품을 접수하고 접수 번호를 받는다.',
      scenario: '거절하면 소비자법 근거를 말한다.',
      envPrompt: '너는 소마의 전화 비서다.',
      requester: 'U0TESTUSER',
      maxMinutes: 5,
      now,
    });
    const order = ['[통화 규칙]', '[환경 지시]', '[이번 통화]', '[목적]', '[대화 시나리오]'].map((h) => p.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(p).toContain('우리가 건 전화 (우리 번호 070-1234-5678 → 상대 010-1234-5678)');
    expect(p).toContain('hang_up');
    expect(p).toContain('AI 비서라고 사실대로');
    expect(p).toContain('통화 시간 한도: 5분');
    expect(p).toContain('2026년 11월 17일');
  });

  it('describes an inbound call and leaves out empty layers', () => {
    const p = buildCallSystemPrompt({
      direction: 'inbound',
      peerNumber: '0212345678',
      ourNumber: '07012345678',
      maxMinutes: 3,
      now,
    });
    expect(p).toContain('걸려 온 전화 (상대 02-1234-5678 → 우리 번호 070-1234-5678)');
    expect(p).not.toContain('[환경 지시]');
    expect(p).not.toContain('[목적]');
  });
});

describe('formatPhoneNumber', () => {
  it('reads numbers in groups', () => {
    expect(formatPhoneNumber('01012345678')).toBe('010-1234-5678');
    expect(formatPhoneNumber('15446486')).toBe('1544-6486');
    expect(formatPhoneNumber('021234567')).toBe('02-123-4567');
  });
});

describe('isBareGreeting', () => {
  it('knows a hello from a real first sentence', () => {
    expect(isBareGreeting('여보세요?')).toBe(true);
    expect(isBareGreeting('네.')).toBe(true);
    expect(isBareGreeting('네, 누구세요?')).toBe(false);
  });
});
