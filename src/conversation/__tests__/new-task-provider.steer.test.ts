/**
 * The panel composer's files on the Slack leg (T1.5, #488) — the uploader
 * `injectDashboardMessage` uses, against a Slack client double:
 * each file is uploaded once into the session thread, read back in the shape
 * the message pipeline downloads from (`event.files`), and a retry after a
 * failed read never uploads the file again.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSlackSteerUploader } from '../new-task-provider';

function slackDouble(opts: { infoFailsOnce?: boolean; host?: string } = {}) {
  let n = 0;
  let failed = false;
  const uploaded: Array<{ channel_id: string; thread_ts: string; filename: string; bytes: string }> = [];
  const client = {
    filesUploadV2: vi.fn(async (args: any) => {
      const files = args.file_uploads.map((u: any) => {
        uploaded.push({
          channel_id: args.channel_id,
          thread_ts: args.thread_ts,
          filename: u.filename,
          bytes: Buffer.from(u.file).toString(),
        });
        return { id: `F${++n}`, name: u.filename };
      });
      return { ok: true, files: [{ ok: true, files }] };
    }),
    files: {
      info: vi.fn(async ({ file }: { file: string }) => {
        if (opts.infoFailsOnce && !failed) {
          failed = true;
          throw new Error('ratelimited');
        }
        const u = uploaded[Number(file.slice(1)) - 1];
        return {
          ok: true,
          file: {
            id: file,
            name: u.filename,
            mimetype: u.filename.endsWith('.webm') ? 'audio/webm' : 'text/plain',
            filetype: u.filename.split('.').pop(),
            url_private_download: `https://${opts.host ?? 'files.slack.com'}/files-pri/T1-${file}/download/${u.filename}`,
            size: u.bytes.length,
          },
        };
      }),
    },
  };
  return { client: client as any, uploaded };
}

const voice = { name: 'voice-1.webm', mimetype: 'audio/webm', data: Buffer.from('opus-bytes') };
const notes = { name: 'notes.txt', mimetype: 'text/plain', data: Buffer.from('메모 내용') };

describe('createSlackSteerUploader — the composer files on the Slack leg', () => {
  it('uploads each file once into the session thread and returns the pipeline event files', async () => {
    const { client, uploaded } = slackDouble();
    const files = await createSlackSteerUploader(client)('C1', '1700000000.000100', [voice, notes]);
    expect(client.filesUploadV2).toHaveBeenCalledTimes(2);
    expect(uploaded).toEqual([
      { channel_id: 'C1', thread_ts: '1700000000.000100', filename: 'voice-1.webm', bytes: 'opus-bytes' },
      { channel_id: 'C1', thread_ts: '1700000000.000100', filename: 'notes.txt', bytes: '메모 내용' },
    ]);
    expect(files.map((f) => [f.id, f.name, f.mimetype])).toEqual([
      ['F1', 'voice-1.webm', 'audio/webm'],
      ['F2', 'notes.txt', 'text/plain'],
    ]);
    for (const f of files) expect(f.url_private_download).toMatch(/^https:\/\/files\.slack\.com\//);
  });

  it('a retry after a failed read reads the file again and never uploads it twice', async () => {
    const { client } = slackDouble({ infoFailsOnce: true });
    const upload = createSlackSteerUploader(client);
    await expect(upload('C1', 't1', [voice])).rejects.toThrow('ratelimited');
    const files = await upload('C1', 't1', [voice]);
    expect(client.filesUploadV2).toHaveBeenCalledTimes(1);
    expect(client.files.info).toHaveBeenCalledTimes(2);
    expect(files[0].id).toBe('F1');
  });

  it('refuses a download URL off Slack (the pipeline fetches it with the bot token)', async () => {
    const { client } = slackDouble({ host: 'evil.example' });
    await expect(createSlackSteerUploader(client)('C1', 't1', [notes])).rejects.toThrow(/non-Slack download URL/);
  });
});
