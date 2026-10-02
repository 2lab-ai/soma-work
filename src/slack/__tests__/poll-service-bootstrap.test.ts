import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getActivePollService, setActivePollService } from '@soma/slack/poll/poll-service';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensurePollService } from '../poll-service-bootstrap';

const slackApi = { getClient: () => ({}), getBotUserId: async () => 'UBOT' } as any;

describe('ensurePollService', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-bootstrap-'));
    setActivePollService(undefined);
  });

  afterEach(() => {
    setActivePollService(undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('builds the singleton once over DATA_DIR/polls.json and reuses it', () => {
    const file = path.join(dir, 'polls.json');
    const first = ensurePollService(slackApi, file);
    expect(first).toBeDefined();
    expect(getActivePollService()).toBe(first);
    expect(ensurePollService(slackApi, file)).toBe(first);
  });

  it('an unreadable poll store (live + .bak corrupt) never takes the bot down — the feature is just unavailable', () => {
    const file = path.join(dir, 'polls.json');
    fs.writeFileSync(file, '{not json');
    fs.writeFileSync(`${file}.bak`, '{also not json');
    expect(() => ensurePollService(slackApi, file)).not.toThrow();
    expect(ensurePollService(slackApi, file)).toBeUndefined();
    expect(getActivePollService()).toBeUndefined();
  });
});
