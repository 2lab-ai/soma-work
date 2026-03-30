import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ReportPublisher } from './report-publisher';

// Contract tests — Scenario 5: ReportPublisher
// Trace: docs/daily-weekly-report/trace.md

describe('ReportPublisher', () => {
  let publisher: ReportPublisher;
  let mockSlackApi: { postMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockSlackApi = { postMessage: vi.fn().mockResolvedValue({ ts: '123.456' }) };
    publisher = new ReportPublisher(mockSlackApi as any);
  });

  // Trace: Scenario 5, Section 3c — calls Slack postMessage
  it('publish_callsSlackPostMessage', async () => {
    const blocks = [{ type: 'header', text: { type: 'plain_text', text: 'Test' } }];
    await publisher.publish('C123', blocks, 'fallback text');

    expect(mockSlackApi.postMessage).toHaveBeenCalledWith(
      'C123',
      'fallback text',
      expect.objectContaining({ blocks })
    );
  });

  // Trace: Scenario 5, Section 5 — skips when no channel configured
  it('publish_skipsWhenNoChannelConfigured', async () => {
    await publisher.publish('', [], 'text');

    expect(mockSlackApi.postMessage).not.toHaveBeenCalled();
  });
});
