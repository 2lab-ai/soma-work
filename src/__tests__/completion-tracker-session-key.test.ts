/**
 * CompletionMessageTracker — one session-key format across every component.
 *
 * The tracker is shared by components that WRITE entries and components that
 * READ/SWEEP them:
 *   - write: `SlackBlockKitChannel.send()` (track), `protectMessageTs()`
 *     (protect), `TurnDismissActionHandler` (untrack);
 *   - sweep: `StreamExecutor` / `ChoiceActionHandler` (`deleteAll`) and
 *     `ThreadSurface` (`protect` / `clearProtection`), which all key by the
 *     session-registry key (`SessionRegistry.getSessionKey` →
 *     `buildWorkSessionKey`, `work:<channel>:<thread>` since Step 4d).
 *
 * If the writers build a different key than the registry, `deleteAll` never
 * finds a tracked card (S7/S8 cleanup is a silent no-op) and protections
 * registered by one side are invisible to the other. Each test here crosses
 * a writer with a registry-keyed reader — no hand-built key strings.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../user-settings-store', () => ({
  userSettingsStore: {
    getUserSessionTheme: vi.fn().mockReturnValue('default'),
  },
}));

import { encodeDismissValue } from '@soma/slack/turn-feedback-block-builder';
import { SlackBlockKitChannel } from '../notification-channels/slack-block-kit-channel';
import { SessionRegistry } from '../session-registry';
import { TurnDismissActionHandler } from '../slack/actions/turn-dismiss-action-handler';
import { CompletionMessageTracker } from '../slack/completion-message-tracker';
import type { TurnCompletionEvent } from '../turn-notifier';

const CHANNEL = 'C0AKY7W2UGZ';
const THREAD_TS = '1792391797.292769';
const CARD_TS = '1792391800.000100';

function makeEvent(overrides: Partial<TurnCompletionEvent> = {}): TurnCompletionEvent {
  return {
    category: 'WorkflowComplete',
    userId: 'Uowner',
    channel: CHANNEL,
    threadTs: THREAD_TS,
    durationMs: 1000,
    ...overrides,
  } as TurnCompletionEvent;
}

describe('CompletionMessageTracker session key — writers agree with the session registry', () => {
  let tracker: CompletionMessageTracker;
  let channel: SlackBlockKitChannel;
  let registryKey: string;

  beforeEach(() => {
    tracker = new CompletionMessageTracker();
    channel = new SlackBlockKitChannel({ postMessage: vi.fn().mockResolvedValue({ ts: CARD_TS }) }, tracker);
    // The key StreamExecutor/ChoiceActionHandler/ThreadSurface use.
    registryKey = new SessionRegistry().getSessionKey(CHANNEL, THREAD_TS);
  });

  it('a card tracked by SlackBlockKitChannel.send() is swept by deleteAll(registry key)', async () => {
    await channel.send(makeEvent());

    const deleted: string[] = [];
    await tracker.deleteAll(
      registryKey,
      async (_ch, ts) => {
        deleted.push(ts);
      },
      CHANNEL,
    );

    expect(deleted).toEqual([CARD_TS]);
  });

  it('protectMessageTs() registers under the registry key (stream answer survives the sweep)', () => {
    channel.protectMessageTs(makeEvent(), 'stream-ts-1');

    expect(tracker.isProtected(registryKey, 'stream-ts-1')).toBe(true);
  });

  it('a ThreadSurface protection (registry key) stops the channel from tracking that ts', async () => {
    const postMessage = vi.fn().mockResolvedValueOnce({ ts: 'root-ts' }).mockResolvedValueOnce({ ts: CARD_TS });
    channel = new SlackBlockKitChannel({ postMessage }, tracker);
    // ThreadSurface.initialize protects the bot-initiated thread root under the registry key.
    tracker.protect(registryKey, 'root-ts');

    await channel.send(makeEvent()); // posted ts is the protected root → must not be tracked
    await channel.send(makeEvent()); // ordinary card → tracked

    const deleted: string[] = [];
    await tracker.deleteAll(
      registryKey,
      async (_ch, ts) => {
        deleted.push(ts);
      },
      CHANNEL,
    );
    expect(deleted).toEqual([CARD_TS]);
  });

  it('turn_dismiss_v1 untracks the card the channel tracked', async () => {
    await channel.send(makeEvent({ turnId: 'turn-1' }));
    expect(tracker.count(registryKey)).toBe(1);

    const dismiss = new TurnDismissActionHandler({
      slackApi: { deleteMessage: vi.fn().mockResolvedValue(undefined) } as any,
      completionMessageTracker: tracker,
    });
    await dismiss.handleDismiss(
      {
        user: { id: 'Uowner' },
        channel: { id: CHANNEL },
        message: { ts: CARD_TS, thread_ts: THREAD_TS },
        actions: [{ action_id: 'turn_dismiss_v1', value: encodeDismissValue('turn-1', 'Uowner') }],
      },
      vi.fn(),
    );

    expect(tracker.count(registryKey)).toBe(0);
  });
});
