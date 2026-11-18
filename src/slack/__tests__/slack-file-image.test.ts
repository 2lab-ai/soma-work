/**
 * Image cards: upload a PNG privately, show it through `slack_file`, and never leave
 * the user without a card — Slack can reject a just-uploaded file (`invalid_blocks`)
 * until its index catches up, so the send is retried and then falls back to text blocks.
 */
import { describe, expect, it, vi } from 'vitest';
import { deliverImageCard, extractFileId, isInvalidBlocksError, slackImageUploader } from '../slack-file-image';

const invalidBlocks = () =>
  Object.assign(new Error('An API error occurred: invalid_blocks'), { data: { error: 'invalid_blocks' } });
const platform = (code: string) =>
  Object.assign(new Error(`An API error occurred: ${code}`), { data: { error: code } });
const noSleep = async () => {};
const card = { blocks: [{ type: 'image' }], fallbackBlocks: [{ type: 'section' }] };

describe('deliverImageCard', () => {
  it('sends once when there is no fallback (a text-only card behaves as before)', async () => {
    const send = vi.fn(async () => 'ok');
    await expect(deliverImageCard({ blocks: [{ type: 'section' }] }, send, { sleep: noSleep })).resolves.toBe('ok');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retries the image blocks while Slack answers invalid_blocks, then succeeds', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(invalidBlocks())
      .mockRejectedValueOnce(invalidBlocks())
      .mockResolvedValue('ok');
    await expect(deliverImageCard(card, send, { sleep: noSleep })).resolves.toBe('ok');
    expect(send).toHaveBeenCalledTimes(3);
    for (const [blocks] of send.mock.calls) expect(blocks).toBe(card.blocks);
  });

  it('falls back to the text blocks after the retries run out', async () => {
    const send = vi.fn(async (blocks: unknown[]) => {
      if (blocks === card.blocks) throw invalidBlocks();
      return 'text';
    });
    await expect(deliverImageCard(card, send, { sleep: noSleep })).resolves.toBe('text');
    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls[send.mock.calls.length - 1]?.[0]).toBe(card.fallbackBlocks);
  });

  it('falls back at once on another validation rejection (nothing was posted)', async () => {
    const send = vi.fn().mockRejectedValueOnce(platform('invalid_arguments')).mockResolvedValue('text');
    await expect(deliverImageCard(card, send, { sleep: noSleep })).resolves.toBe('text');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toBe(card.fallbackBlocks);
  });

  it('propagates a transport failure instead of posting a second message (the first may have landed)', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('socket hang up')).mockResolvedValue('text');
    await expect(deliverImageCard(card, send, { sleep: noSleep })).rejects.toThrow('socket hang up');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('propagates an ambiguous server error (internal_error may follow a posted message)', async () => {
    const send = vi.fn().mockRejectedValueOnce(platform('internal_error')).mockResolvedValue('text');
    await expect(deliverImageCard(card, send, { sleep: noSleep })).rejects.toThrow('internal_error');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('an in-place update may fall back after any failure (fallbackOn)', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('update did not land')).mockResolvedValue('text');
    await expect(deliverImageCard(card, send, { sleep: noSleep, fallbackOn: () => true })).resolves.toBe('text');
    expect(send.mock.calls[1][0]).toBe(card.fallbackBlocks);
  });

  it('throws when the fallback fails too', async () => {
    const send = vi.fn(async () => {
      throw platform('invalid_arguments');
    });
    await expect(deliverImageCard(card, send, { sleep: noSleep })).rejects.toThrow('invalid_arguments');
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('slackImageUploader', () => {
  it('uploads privately (no channel, no thread) and returns the file id', async () => {
    const filesUploadV2 = vi.fn(async () => ({ files: [{ files: [{ id: 'F123' }] }] }));
    const upload = slackImageUploader({ filesUploadV2 });
    await expect(upload(Buffer.from('png'), 'auth.png')).resolves.toBe('F123');
    const [args] = filesUploadV2.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(args.filename).toBe('auth.png');
    expect(args).not.toHaveProperty('channel_id');
    expect(args).not.toHaveProperty('thread_ts');
  });
});

describe('extractFileId / isInvalidBlocksError', () => {
  it('reads the nested, flat-list and single-file response shapes', () => {
    expect(extractFileId({ files: [{ files: [{ id: 'F1' }] }] })).toBe('F1');
    expect(extractFileId({ files: [{ id: 'F2' }] })).toBe('F2');
    expect(extractFileId({ file: { id: 'F3' } })).toBe('F3');
    expect(() => extractFileId({})).toThrow();
  });

  it('trusts only the structured error code', () => {
    expect(isInvalidBlocksError(invalidBlocks())).toBe(true);
    expect(isInvalidBlocksError(new Error('invalid_blocks'))).toBe(false);
  });
});

describe('slackImageUploader readiness wait', () => {
  it('polls files.info until Slack reports the image processed', async () => {
    const info = vi
      .fn()
      .mockResolvedValueOnce({ file: { id: 'F1' } })
      .mockResolvedValueOnce({ file: { id: 'F1', original_w: 2400 } });
    const sleep = vi.fn(async () => {});
    const upload = slackImageUploader(
      { filesUploadV2: async () => ({ files: [{ id: 'F1' }] }), files: { info } },
      sleep,
    );
    await expect(upload(Buffer.from('png'), 'a.png')).resolves.toBe('F1');
    expect(info).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('gives up quietly when files.info fails (the senders still retry)', async () => {
    const info = vi.fn(async () => {
      throw new Error('missing_scope');
    });
    const upload = slackImageUploader(
      { filesUploadV2: async () => ({ files: [{ id: 'F1' }] }), files: { info } },
      async () => {},
    );
    await expect(upload(Buffer.from('png'), 'a.png')).resolves.toBe('F1');
    expect(info).toHaveBeenCalledTimes(1);
  });
});
