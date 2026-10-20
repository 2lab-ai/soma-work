/**
 * Regression: the production barrel must wire the Jira-info provider.
 *
 * `src/slack-handler.ts` builds `InputProcessor` from `./slack/pipeline`
 * (this directory's `index.ts`). The package default for
 * `updateUserJiraInfo` is a no-op, and only `../input-processor.ts` (the src
 * shim) injects the real `userSettingsStore.updateUserJiraInfo`. If the
 * barrel re-exports `InputProcessor` straight from `@soma/slack/pipeline`,
 * the shim is never loaded and the per-message Slack→Jira sync silently
 * stops (regression from 167b99f2).
 *
 * This test deliberately imports the barrel (not the shim) and does NOT mock
 * `user-settings-store`, so it fails if the wiring is bypassed.
 */

import type { MessageEvent } from '@soma/slack/pipeline/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { userSettingsStore } from '../../../user-settings-store';
import { InputProcessor } from '../index';

describe('InputProcessor via production barrel — Jira sync wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('processFiles calls userSettingsStore.updateUserJiraInfo for the event user', async () => {
    const spy = vi.spyOn(userSettingsStore, 'updateUserJiraInfo').mockReturnValue(false);
    const processor = new InputProcessor({
      fileHandler: { downloadAndProcessFiles: vi.fn().mockResolvedValue([]) },
      commandRouter: { route: vi.fn().mockResolvedValue({ handled: false }) },
    });
    const event = {
      type: 'message',
      channel: 'C1',
      thread_ts: 'T1',
      user: 'U1',
      ts: '171.0',
      text: 'hello',
    } as unknown as MessageEvent;

    const result = await processor.processFiles(event, vi.fn() as any);

    expect(result.shouldContinue).toBe(true);
    expect(spy).toHaveBeenCalledWith('U1');
  });
});
