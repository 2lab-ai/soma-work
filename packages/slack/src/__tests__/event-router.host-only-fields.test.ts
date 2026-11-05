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
    };
    const clean = withoutHostOnlyFields(event) as Record<string, unknown>;
    expect(clean).toEqual({ user: 'U1', channel: 'C1', ts: '1.1', text: 'hi' });
    expect(event.botThreadRoot).toBe(true); // the caller's object is not mutated
  });

  it('an event with none of them is returned as is', () => {
    const event = { user: 'U1', channel: 'C1', ts: '1.1', text: 'hi' };
    expect(withoutHostOnlyFields(event)).toBe(event);
  });
});
