import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusReporter } from '../status-reporter';

describe('StatusReporter', () => {
  let slackApi: {
    postMessage: ReturnType<typeof vi.fn>;
    updateMessage: ReturnType<typeof vi.fn>;
  };
  let reporter: StatusReporter;

  beforeEach(() => {
    slackApi = {
      postMessage: vi.fn(),
      updateMessage: vi.fn(),
    };
    reporter = new StatusReporter(slackApi as any);
  });

  it('createStatusMessage uses slackApi.postMessage and stores ts', async () => {
    slackApi.postMessage.mockResolvedValue({ ts: '111.222', channel: 'C123' });

    const result = await reporter.createStatusMessage('C123', '999.888', 'session-1', 'working', '[tag] ');

    expect(slackApi.postMessage).toHaveBeenCalledWith('C123', '[tag] ⚙️ *Working...*', { threadTs: '999.888' });
    expect(result).toBe('111.222');
    expect(reporter.getStatusMessage('session-1')).toEqual({
      channel: 'C123',
      ts: '111.222',
    });
  });

  it('updateStatus uses slackApi.updateMessage for cached session message', async () => {
    slackApi.updateMessage.mockResolvedValue(undefined);
    (reporter as any).statusMessages.set('session-1', {
      channel: 'C123',
      ts: '111.222',
    });

    await reporter.updateStatus('session-1', 'completed');

    expect(slackApi.updateMessage).toHaveBeenCalledWith('C123', '111.222', '✅ *Task completed*');
  });

  it('updateStatusDirect uses slackApi.updateMessage with explicit ts', async () => {
    slackApi.updateMessage.mockResolvedValue(undefined);

    await reporter.updateStatusDirect('C123', '111.222', 'error', '[tag] ');

    expect(slackApi.updateMessage).toHaveBeenCalledWith('C123', '111.222', '[tag] ❌ *Error occurred*');
  });
});
