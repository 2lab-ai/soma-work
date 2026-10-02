import * as path from 'node:path';
import { getActivePollService, PollService, setActivePollService } from '@soma/slack/poll/poll-service';
import { PollStore } from '@soma/slack/poll/poll-store';
import { DATA_DIR } from '../env-paths';
import { Logger } from '../logger';
import { createPollSlackApi } from './poll-slack-adapter';

const logger = new Logger('PollServiceBootstrap');

/**
 * Build (once) the process-wide poll service over `DATA_DIR/polls.json`.
 *
 * The store owns the file; the scheduler and POLL_CREATE host-apply reach the
 * service through `getActivePollService()`. Only the main bot's SlackHandler
 * builds action delegates today (secondary AgentInstances are not wired yet),
 * so the first slackApi wins.
 *
 * Polls are not critical to the bot: when the store cannot be read (live file
 * and `.bak` both unusable — `readJsonWithBackup` throws rather than report an
 * empty store) the error is logged and `undefined` is returned, leaving the
 * damaged file untouched for inspection. Every poll entrypoint already answers
 * "투표 기능을 사용할 수 없습니다" when the service is absent; the bot itself keeps
 * starting. Same stance as the follow-up queue store in `slack-handler.ts`.
 */
export function ensurePollService(
  slackApi: any,
  filePath = path.join(DATA_DIR, 'polls.json'),
): PollService | undefined {
  const existing = getActivePollService();
  if (existing) return existing;
  try {
    const store = new PollStore(filePath);
    store.load();
    const service = new PollService({ store, slack: createPollSlackApi(slackApi) });
    setActivePollService(service);
    return service;
  } catch (error) {
    logger.error('Poll store unreadable — native polls disabled until it is repaired', {
      filePath,
      error: (error as Error)?.message ?? String(error),
    });
    return undefined;
  }
}
