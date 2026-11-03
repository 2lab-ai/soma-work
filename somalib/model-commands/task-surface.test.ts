/**
 * SSOT 2026-11-03 — a dashboard task gets the model-command server
 * (`surface: 'task'`). SET_GOAL, session links/title, memory and skills work
 * there; the three commands only a Slack thread can carry out are not offered
 * and, if called anyway, are refused with what to do instead.
 */
import { describe, expect, it } from 'vitest';
import { getDefaultSessionSnapshot, listModelCommands, runModelCommand, surfaceRefusal } from './catalog';
import type { ModelCommandContext } from './types';
import { TASK_UNAVAILABLE_COMMANDS } from './types';

const task: ModelCommandContext = { user: 'U1', surface: 'task', session: getDefaultSessionSnapshot() };
const slack: ModelCommandContext = { channel: 'C1', threadTs: '1.2', user: 'U1', session: getDefaultSessionSnapshot() };

describe('model commands on a dashboard task', () => {
  it('lists SET_GOAL, UPDATE_SESSION, GET_SESSION, MEMORY — and none of the thread-only commands', () => {
    const ids = listModelCommands({ ...task, renewState: 'pending_save' }).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['GET_SESSION', 'UPDATE_SESSION', 'SET_GOAL', 'MEMORY', 'SAVE_MEMORY']));
    for (const id of TASK_UNAVAILABLE_COMMANDS) expect(ids).not.toContain(id);
  });

  it('a Slack thread still lists ASK_USER_QUESTION and CONTINUE_SESSION', () => {
    const ids = listModelCommands(slack).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['ASK_USER_QUESTION', 'CONTINUE_SESSION', 'SET_GOAL']));
  });

  it('refuses ASK_USER_QUESTION on a task and says how to ask instead', () => {
    const result = runModelCommand(
      { commandId: 'ASK_USER_QUESTION', params: { question: { question: 'q?', choices: [] } } } as never,
      task,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONTEXT_ERROR');
    expect(result.error.message).toMatch(/not available on a dashboard task/);
    expect(result.error.message).toMatch(/user_choice/);
  });

  it('runs SET_GOAL on a task (the host applies it)', () => {
    const result = runModelCommand(
      { commandId: 'SET_GOAL', params: { objective: 'ship it', userRequestEvidence: 'set goal 해줘' } },
      task,
    );
    expect(result.ok).toBe(true);
  });

  it('surfaceRefusal is silent on a Slack thread', () => {
    expect(surfaceRefusal('CONTINUE_SESSION', slack)).toBeUndefined();
    expect(surfaceRefusal('CONTINUE_SESSION', task)?.ok).toBe(false);
  });
});
