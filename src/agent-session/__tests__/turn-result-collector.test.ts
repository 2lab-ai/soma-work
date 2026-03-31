import { beforeEach, describe, expect, it } from 'vitest';
import type { EndTurnInfo, ModelCommandResult } from '../agent-session-types.js';
import { TurnResultCollector } from '../turn-result-collector.js';

describe('TurnResultCollector', () => {
  let collector: TurnResultCollector;

  beforeEach(() => {
    collector = new TurnResultCollector();
  });

  // ─── 기본 동작 ─────────────────────────────────────

  it('should return empty result when no events', () => {
    const result = collector.getResult();
    expect(result.messages).toEqual([]);
    expect(result.toolCalls).toEqual([]);
    expect(result.modelCommandResults).toEqual([]);
    expect(result.askUserQuestions).toEqual([]);
    expect(result.hasPendingChoice).toBe(false);
    expect(result.continuation).toBeNull();
    expect(result.endTurn.reason).toBe('end_turn');
  });

  // ─── 도구 이벤트 ───────────────────────────────────

  it('should collect tool start events', () => {
    collector.onToolStart('Read', 'tool-1');
    collector.onToolStart('Edit', 'tool-2');

    const result = collector.getResult();
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].toolName).toBe('Read');
    expect(result.toolCalls[0].toolUseId).toBe('tool-1');
    expect(result.toolCalls[1].toolName).toBe('Edit');
  });

  it('should record tool duration on end', () => {
    collector.onToolStart('Read', 'tool-1');
    collector.onToolEnd('Read', 'tool-1', 150);

    const result = collector.getResult();
    expect(result.toolCalls[0].duration).toBe(150);
  });

  it('should handle tool end for unknown toolUseId gracefully', () => {
    collector.onToolEnd('Read', 'nonexistent', 100);
    const result = collector.getResult();
    expect(result.toolCalls).toHaveLength(0);
  });

  // ─── 텍스트 수집 ───────────────────────────────────

  it('should collect text messages', () => {
    collector.onText('Hello');
    collector.onText('World');

    const result = collector.getResult();
    expect(result.messages).toEqual(['Hello', 'World']);
  });

  it('should ignore empty/whitespace text', () => {
    collector.onText('');
    collector.onText('   ');
    collector.onText('\n');

    const result = collector.getResult();
    expect(result.messages).toEqual([]);
  });

  // ─── Phase 변경 ────────────────────────────────────

  it('should track phase changes', () => {
    expect(collector.phase).toBe('생각 중');

    collector.onPhaseChange('도구 실행 중');
    expect(collector.phase).toBe('도구 실행 중');

    collector.onPhaseChange('결과 반영 중');
    expect(collector.phase).toBe('결과 반영 중');
  });

  it('should set hasPendingChoice when phase is 입력 대기', () => {
    collector.onPhaseChange('입력 대기');
    const result = collector.getResult();
    expect(result.hasPendingChoice).toBe(true);
  });

  // ─── EndTurn ───────────────────────────────────────

  it('should record endTurn info', () => {
    const info: EndTurnInfo = {
      reason: 'end_turn',
      timestamp: 1234567890,
    };
    collector.onEndTurn(info);

    expect(collector.endTurn).toEqual(info);
    const result = collector.getResult();
    expect(result.endTurn).toEqual(info);
  });

  it('should record endTurn with tool_use reason and lastToolUse', () => {
    const info: EndTurnInfo = {
      reason: 'tool_use',
      timestamp: 1234567890,
      lastToolUse: 'mcp__github__create_pr',
    };
    collector.onEndTurn(info);

    const result = collector.getResult();
    expect(result.endTurn.reason).toBe('tool_use');
    expect(result.endTurn.lastToolUse).toBe('mcp__github__create_pr');
  });

  it('should record endTurn with max_tokens reason', () => {
    const info: EndTurnInfo = {
      reason: 'max_tokens',
      timestamp: Date.now(),
    };
    collector.onEndTurn(info);
    expect(collector.getResult().endTurn.reason).toBe('max_tokens');
  });

  // ─── Model Command 결과 ────────────────────────────

  it('should collect model command results', () => {
    const mcr: ModelCommandResult = {
      commandId: 'UPDATE_SESSION',
      ok: true,
      payload: { request: {} },
    };
    collector.onModelCommandResult(mcr);

    const result = collector.getResult();
    expect(result.modelCommandResults).toHaveLength(1);
    expect(result.modelCommandResults[0].commandId).toBe('UPDATE_SESSION');
  });

  it('should auto-extract ASK_USER_QUESTION to askUserQuestions', () => {
    const question = {
      type: 'user_choice' as const,
      question: 'Which option?',
      choices: [
        { id: '1', label: 'Option A' },
        { id: '2', label: 'Option B' },
      ],
    };
    collector.onModelCommandResult({
      commandId: 'ASK_USER_QUESTION',
      ok: true,
      payload: { question },
    });

    const result = collector.getResult();
    expect(result.askUserQuestions).toHaveLength(1);
    expect(result.askUserQuestions[0].question).toBe('Which option?');
    expect(result.hasPendingChoice).toBe(true);
  });

  it('should capture CONTINUE_SESSION as continuation', () => {
    const continuation = { prompt: 'continue...', resetSession: false };
    collector.onModelCommandResult({
      commandId: 'CONTINUE_SESSION',
      ok: true,
      payload: continuation,
    });

    const result = collector.getResult();
    expect(result.continuation).toEqual(continuation);
  });

  it('should collect error model command results', () => {
    collector.onModelCommandResult({
      commandId: 'ASK_USER_QUESTION',
      ok: false,
      error: { code: 'INVALID_ARGS', message: 'bad params' },
    });

    const result = collector.getResult();
    expect(result.modelCommandResults).toHaveLength(1);
    expect(result.modelCommandResults[0].ok).toBe(false);
    // should NOT add to askUserQuestions when not ok
    expect(result.askUserQuestions).toHaveLength(0);
  });

  // ─── 외부 설정 ─────────────────────────────────────

  it('setContinuation should override continuation', () => {
    const c1 = { prompt: 'first' };
    const c2 = { prompt: 'second' };
    collector.setContinuation(c1);
    expect(collector.getResult().continuation).toEqual(c1);
    collector.setContinuation(c2);
    expect(collector.getResult().continuation).toEqual(c2);
  });

  it('setHasPendingChoice should override pending state', () => {
    expect(collector.getResult().hasPendingChoice).toBe(false);
    collector.setHasPendingChoice(true);
    expect(collector.getResult().hasPendingChoice).toBe(true);
  });

  // ─── Usage (Trace: Scenario 5) ────────────────────

  // Trace: S5, Section 3b — setUsage included in result
  it('setUsage() should include usage in getResult()', () => {
    collector.setUsage({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 });
    const result = collector.getResult();
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 });
  });

  // Trace: S5, Section 5 — no usage returns undefined
  it('getResult() returns undefined usage when setUsage not called', () => {
    const result = collector.getResult();
    expect(result.usage).toBeUndefined();
  });

  // Trace: S5, Section 3a — AgentTurnResult has usage and durationMs fields
  it('AgentTurnResult shape includes optional usage and durationMs', () => {
    collector.setUsage({ inputTokens: 10, outputTokens: 5 });
    const result = collector.getResult();
    // usage is set
    expect(result.usage).toBeDefined();
    // durationMs is NOT set by collector (set by V1QueryAdapter)
    expect(result.durationMs).toBeUndefined();
  });

  // ─── 결과 불변성 ───────────────────────────────────

  it('getResult should return a snapshot (not live reference)', () => {
    collector.onText('before');
    const result1 = collector.getResult();

    collector.onText('after');
    const result2 = collector.getResult();

    expect(result1.messages).toHaveLength(1);
    expect(result2.messages).toHaveLength(2);
  });

  // ─── 통합 시나리오 ─────────────────────────────────

  it('full turn lifecycle: start → tools → text → endTurn', () => {
    // 1. Tool execution
    collector.onPhaseChange('도구 실행 중');
    collector.onToolStart('Read', 't1');
    collector.onToolEnd('Read', 't1', 50);

    // 2. Model command
    collector.onPhaseChange('결과 반영 중');
    collector.onModelCommandResult({
      commandId: 'UPDATE_SESSION',
      ok: true,
      payload: {},
    });

    // 3. Text response
    collector.onText('Here is the answer.');

    // 4. End turn
    collector.onEndTurn({ reason: 'end_turn', timestamp: Date.now() });

    const result = collector.getResult();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].duration).toBe(50);
    expect(result.modelCommandResults).toHaveLength(1);
    expect(result.messages).toEqual(['Here is the answer.']);
    expect(result.endTurn.reason).toBe('end_turn');
    expect(result.hasPendingChoice).toBe(false);
    expect(result.continuation).toBeNull();
  });
});
