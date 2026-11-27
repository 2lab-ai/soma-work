import { describe, expect, it } from 'vitest';
import { withoutHostOnlyFields } from '../event-router';

/**
 * A field only the host sets (the dashboard launcher) is never trusted on a Slack event: the router
 * drops it before the pipeline sees the event. `botThreadRoot` makes a new session bot-initiated on
 * the thread root — on a user's own message that would leave the session with a panel it cannot
 * update (#952 review, fable P2).
 */
describe('withoutHostOnlyFields', () => {
  it('drops botThreadRoot from a Slack event, with the other host-only switches', () => {
    const event = {
      user: 'U1',
      channel: 'C1',
      ts: '1.1',
      text: 'hi',
      botThreadRoot: true,
      planModeOverride: true,
      epicOverride: true,
      // SSOT 2026-11-12 — a Slack event cannot link itself to someone's source thread.
      sourceThreadLink: { channel: 'C9', threadTs: '9.9' },
      // #1474 — a Slack event cannot pass itself off as the owner's answer to the model's question.
      questionAnswer: true,
    };
    const clean = withoutHostOnlyFields(event) as Record<string, unknown>;
    expect(clean).toEqual({ user: 'U1', channel: 'C1', ts: '1.1', text: 'hi' });
    expect(event.botThreadRoot).toBe(true); // the caller's object is not mutated
  });

  // Z 2026-11-27 (review R1) — the 관리자 모드 flag lets an admin's message skip the owner's approval: host-only.
  it('drops the 관리자 모드 route flag a Slack event claims, keeping the rest of its route context', () => {
    const event = {
      user: 'U_ADMIN',
      channel: 'C1',
      ts: '1.1',
      text: 'hi',
      routeContext: { adminModeInstruction: true, verbatimPrompt: true },
    };
    const clean = withoutHostOnlyFields(event) as Record<string, any>;
    expect(clean.routeContext).toEqual({ verbatimPrompt: true });
    expect(event.routeContext.adminModeInstruction).toBe(true); // the caller's object is not mutated
    const onlyFlag = withoutHostOnlyFields({ ...event, routeContext: { adminModeInstruction: true } }) as any;
    expect(onlyFlag.routeContext).toEqual({});
    const untouched = { user: 'U1', channel: 'C1', ts: '1.1', routeContext: { verbatimPrompt: true } };
    expect(withoutHostOnlyFields(untouched)).toBe(untouched);
  });

  it('an event with none of them is returned as is', () => {
    const event = { user: 'U1', channel: 'C1', ts: '1.1', text: 'hi' };
    expect(withoutHostOnlyFields(event)).toBe(event);
  });
});
