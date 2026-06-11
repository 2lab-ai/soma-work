import { describe, expect, it, vi } from 'vitest';
import { determineTurnCategory, getCategoryColor, TurnNotifier } from '../turn-notifier';

// Contract tests — Scenario 1: TurnNotifier core + Block Kit
// Trace: docs/turn-notification/trace.md

describe('TurnNotifier', () => {
  describe('Category Classification', () => {
    it('categorizes waiting state as UIUserAskQuestion', () => {
      // Trace: Scenario 1, Section 3a
      expect(determineTurnCategory({ hasPendingChoice: true, isError: false })).toBe('UIUserAskQuestion');
    });

    it('categorizes idle state as WorkflowComplete', () => {
      // Trace: Scenario 1, Section 3a
      expect(determineTurnCategory({ hasPendingChoice: false, isError: false })).toBe('WorkflowComplete');
    });

    it('categorizes error as Exception', () => {
      // Trace: Scenario 1, Section 3a
      expect(determineTurnCategory({ hasPendingChoice: false, isError: true })).toBe('Exception');
    });

    // Per the user's invariant (turn-notifier.ts TurnCategory JSDoc):
    // timeout fire is a CODE BUG signal, NOT an immediate model/SDK
    // error — it gets its own `Stalled` category (⚫, black). The
    // `isStalled` flag takes precedence over `isError` because the
    // catch-site sees stall-timeout as an AbortError (looks like an
    // error) but must be classified separately.
    it('categorizes idle-timeout as Stalled (NOT Exception)', () => {
      expect(determineTurnCategory({ hasPendingChoice: false, isError: false, isStalled: true })).toBe('Stalled');
    });

    it('Stalled takes precedence over Exception when both signals fire', () => {
      // Stall-timeout catch-site sets `isError=true` (AbortError) but
      // `isStalled=true` overrides — we want the investigation card,
      // not the immediate-error card.
      expect(determineTurnCategory({ hasPendingChoice: false, isError: true, isStalled: true })).toBe('Stalled');
    });
  });

  describe('Channel Dispatch', () => {
    it('sends to all enabled channels', async () => {
      // Trace: Scenario 1, Section 3b
      const channel1 = {
        name: 'test1',
        isEnabled: vi.fn().mockResolvedValue(true),
        send: vi.fn().mockResolvedValue(undefined),
      };
      const channel2 = {
        name: 'test2',
        isEnabled: vi.fn().mockResolvedValue(true),
        send: vi.fn().mockResolvedValue(undefined),
      };
      const notifier = new TurnNotifier([channel1, channel2]);

      await notifier.notify({
        category: 'WorkflowComplete',
        userId: 'U123',
        channel: 'C123',
        threadTs: '123.456',
        durationMs: 5000,
      });

      expect(channel1.send).toHaveBeenCalledOnce();
      expect(channel2.send).toHaveBeenCalledOnce();
    });

    it('skips disabled categories', async () => {
      // Trace: Scenario 1, Section 3b
      const channel = { name: 'test', isEnabled: vi.fn().mockResolvedValue(false), send: vi.fn() };
      const notifier = new TurnNotifier([channel]);

      await notifier.notify({
        category: 'WorkflowComplete',
        userId: 'U123',
        channel: 'C123',
        threadTs: '123.456',
        durationMs: 5000,
      });

      expect(channel.send).not.toHaveBeenCalled();
    });

    it('does not block on channel failure', async () => {
      // Trace: Scenario 1, Section 5
      const failChannel = {
        name: 'fail',
        isEnabled: vi.fn().mockResolvedValue(true),
        send: vi.fn().mockRejectedValue(new Error('boom')),
      };
      const okChannel = {
        name: 'ok',
        isEnabled: vi.fn().mockResolvedValue(true),
        send: vi.fn().mockResolvedValue(undefined),
      };
      const notifier = new TurnNotifier([failChannel, okChannel]);

      await expect(
        notifier.notify({
          category: 'WorkflowComplete',
          userId: 'U123',
          channel: 'C123',
          threadTs: '123.456',
          durationMs: 5000,
        }),
      ).resolves.toBeUndefined();

      expect(okChannel.send).toHaveBeenCalledOnce();
    });
  });

  describe('Color Mapping', () => {
    it('maps category to correct Block Kit color', () => {
      // Trace: Scenario 1, Section 3b→3c
      expect(getCategoryColor('UIUserAskQuestion')).toBe('#FF9500');
      expect(getCategoryColor('WorkflowComplete')).toBe('#36B37E');
      expect(getCategoryColor('Exception')).toBe('#FF5630');
      // Stalled is intentionally near-black — visually distinct from
      // Exception's red so operators recognize it as the investigation
      // queue. Pure #000 reads as missing-style; #1F1F1F is the safest
      // dark in Slack attachment rails.
      expect(getCategoryColor('Stalled')).toBe('#1F1F1F');
    });
  });

  // -------------------------------------------------------------------------
  // P5 (#667) — excludeChannelNames filter
  // -------------------------------------------------------------------------
  describe('excludeChannelNames (#667 P5)', () => {
    function makeEvent() {
      return {
        category: 'WorkflowComplete' as const,
        userId: 'U1',
        channel: 'C1',
        threadTs: '123.456',
        durationMs: 1000,
      };
    }

    it('notify(evt) — no opts — all enabled channels send (default unchanged)', async () => {
      const slackBlock = {
        name: 'slack-block-kit',
        isEnabled: vi.fn().mockResolvedValue(true),
        send: vi.fn().mockResolvedValue(undefined),
      };
      const dm = {
        name: 'slack-dm',
        isEnabled: vi.fn().mockResolvedValue(true),
        send: vi.fn().mockResolvedValue(undefined),
      };
      const notifier = new TurnNotifier([slackBlock, dm]);

      await notifier.notify(makeEvent());

      expect(slackBlock.send).toHaveBeenCalledOnce();
      expect(dm.send).toHaveBeenCalledOnce();
    });

    it('notify(evt, { excludeChannelNames: ["slack-block-kit"] }) — skips slack-block-kit, others sent', async () => {
      const slackBlock = {
        name: 'slack-block-kit',
        isEnabled: vi.fn().mockResolvedValue(true),
        send: vi.fn().mockResolvedValue(undefined),
      };
      const dm = {
        name: 'slack-dm',
        isEnabled: vi.fn().mockResolvedValue(true),
        send: vi.fn().mockResolvedValue(undefined),
      };
      const webhook = {
        name: 'webhook',
        isEnabled: vi.fn().mockResolvedValue(true),
        send: vi.fn().mockResolvedValue(undefined),
      };
      const notifier = new TurnNotifier([slackBlock, dm, webhook]);

      await notifier.notify(makeEvent(), { excludeChannelNames: ['slack-block-kit'] });

      expect(slackBlock.send).not.toHaveBeenCalled();
      expect(dm.send).toHaveBeenCalledOnce();
      expect(webhook.send).toHaveBeenCalledOnce();
    });

    it('notify(evt, { excludeChannelNames: [] }) — empty filter behaves like no opts', async () => {
      const slackBlock = {
        name: 'slack-block-kit',
        isEnabled: vi.fn().mockResolvedValue(true),
        send: vi.fn().mockResolvedValue(undefined),
      };
      const dm = {
        name: 'slack-dm',
        isEnabled: vi.fn().mockResolvedValue(true),
        send: vi.fn().mockResolvedValue(undefined),
      };
      const notifier = new TurnNotifier([slackBlock, dm]);

      await notifier.notify(makeEvent(), { excludeChannelNames: [] });

      expect(slackBlock.send).toHaveBeenCalledOnce();
      expect(dm.send).toHaveBeenCalledOnce();
    });

    it('notify(evt, { excludeChannelNames: ["unknown-name"] }) — unknown name is a no-op filter', async () => {
      const slackBlock = {
        name: 'slack-block-kit',
        isEnabled: vi.fn().mockResolvedValue(true),
        send: vi.fn().mockResolvedValue(undefined),
      };
      const dm = {
        name: 'slack-dm',
        isEnabled: vi.fn().mockResolvedValue(true),
        send: vi.fn().mockResolvedValue(undefined),
      };
      const notifier = new TurnNotifier([slackBlock, dm]);

      await notifier.notify(makeEvent(), { excludeChannelNames: ['does-not-exist'] });

      expect(slackBlock.send).toHaveBeenCalledOnce();
      expect(dm.send).toHaveBeenCalledOnce();
    });

    it('disabled channels stay not-sent even if their name is in excludeChannelNames (filter does not re-enable)', async () => {
      const slackBlock = {
        name: 'slack-block-kit',
        isEnabled: vi.fn().mockResolvedValue(false),
        send: vi.fn().mockResolvedValue(undefined),
      };
      const dm = {
        name: 'slack-dm',
        isEnabled: vi.fn().mockResolvedValue(true),
        send: vi.fn().mockResolvedValue(undefined),
      };
      const notifier = new TurnNotifier([slackBlock, dm]);

      // Exclusion list includes slack-block-kit (already disabled) AND slack-dm.
      // Expectation: both get skipped — exclusion does NOT override isEnabled=false
      // (slack-block-kit would never have sent anyway), and slack-dm is excluded.
      await notifier.notify(makeEvent(), { excludeChannelNames: ['slack-block-kit', 'slack-dm'] });

      expect(slackBlock.send).not.toHaveBeenCalled();
      expect(dm.send).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Turn-end surface guarantee — B-3 (zero-enabled-channels visibility)
  //
  // Pre-fix behavior: when every registered channel returned
  // `isEnabled() === false` (or no channels were registered), `notify()`
  // returned silently with NO log line. Operators triaging "where did my
  // turn-end card go?" had no breadcrumb at all. The hole bit production
  // when a misconfigured workspace ended up with all channels disabled —
  // the turn ended cleanly, the user saw nothing.
  //
  // Fix: emit a `logger.warn` with the userId + category before the silent
  // return so the gap is at least observable in logs.
  // -------------------------------------------------------------------------
  describe('Zero-enabled-channels visibility (B-3)', () => {
    // The Logger emits warn via `console.warn`. Spying on console.warn is the
    // most robust seam — it avoids vite/cjs module-identity quirks where
    // `vi.spyOn(Logger.prototype, 'warn')` may target a different prototype
    // than the one the dist bundle ends up using.
    it('logs a warn when no channels are enabled (empty channels list)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const notifier = new TurnNotifier([]);
        await notifier.notify({
          category: 'Exception',
          userId: 'U_OWNER',
          channel: 'C123',
          threadTs: 't1',
          durationMs: 0,
        });

        // RED gate: pre-fix code returns silently with no warn.
        expect(warnSpy).toHaveBeenCalled();
        const call = warnSpy.mock.calls.find((c) => typeof c[0] === 'string' && /no enabled channels/i.test(c[0]));
        expect(call).toBeDefined();
        // Operator-triage context (userId + category) must appear in the
        // formatted output. We check the rendered string rather than a
        // structured arg because Logger formats data into the message body.
        expect(String(call?.[0])).toMatch(/U_OWNER/);
        expect(String(call?.[0])).toMatch(/Exception/);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('logs a warn when all channels report isEnabled=false', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const disabled = {
          name: 'slack-disabled',
          isEnabled: vi.fn().mockResolvedValue(false),
          send: vi.fn(),
        };
        const notifier = new TurnNotifier([disabled]);
        await notifier.notify({
          category: 'WorkflowComplete',
          userId: 'U_OWNER',
          channel: 'C123',
          threadTs: 't1',
          durationMs: 0,
        });

        expect(disabled.send).not.toHaveBeenCalled();
        const call = warnSpy.mock.calls.find((c) => typeof c[0] === 'string' && /no enabled channels/i.test(c[0]));
        expect(call).toBeDefined();
      } finally {
        warnSpy.mockRestore();
      }
    });

    // P5 path: when `excludeChannelNames` is passed, the excluded channel
    // (slack-block-kit) has ALREADY surfaced the B5 terminal card via
    // TurnSurface.end — zero remaining enabled channels just means the user
    // has no opt-in fan-out channels (slack-dm / webhook / telegram). The
    // §B-3 warn ("terminal card not surfaced") is factually wrong in that
    // case and caused a real misdiagnosis during the #1079 invalid_blocks
    // incident triage. Expected: debug-level breadcrumb, NO warn.
    it('does NOT warn when zero channels remain because of excludeChannelNames (card surfaced upstream)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const slackBlock = {
          name: 'slack-block-kit',
          isEnabled: vi.fn().mockResolvedValue(true),
          send: vi.fn().mockResolvedValue(undefined),
        };
        const dmOptOut = {
          name: 'slack-dm',
          isEnabled: vi.fn().mockResolvedValue(false),
          send: vi.fn(),
        };
        const notifier = new TurnNotifier([slackBlock, dmOptOut]);

        await notifier.notify(
          {
            category: 'WorkflowComplete',
            userId: 'U_OWNER',
            channel: 'C123',
            threadTs: 't1',
            durationMs: 0,
          },
          { excludeChannelNames: ['slack-block-kit'] },
        );

        expect(slackBlock.send).not.toHaveBeenCalled();
        expect(dmOptOut.send).not.toHaveBeenCalled();
        const misleading = warnSpy.mock.calls.find(
          (c) => typeof c[0] === 'string' && /no enabled channels/i.test(c[0]),
        );
        expect(misleading).toBeUndefined();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('still warns when zero channels are enabled WITHOUT an exclusion filter (§B-3 preserved)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const disabled = {
          name: 'slack-block-kit',
          isEnabled: vi.fn().mockResolvedValue(false),
          send: vi.fn(),
        };
        const notifier = new TurnNotifier([disabled]);

        await notifier.notify({
          category: 'Exception',
          userId: 'U_OWNER',
          channel: 'C123',
          threadTs: 't1',
          durationMs: 0,
        });

        const call = warnSpy.mock.calls.find((c) => typeof c[0] === 'string' && /no enabled channels/i.test(c[0]));
        expect(call).toBeDefined();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
