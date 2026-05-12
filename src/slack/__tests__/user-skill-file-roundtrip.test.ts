import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSession } from '../../types';
import {
  type ConsumeUploadDeps,
  consumePendingSkillUpload,
  EDIT_UPLOAD_TTL_MS,
  SKILL_FILE_NAME,
  uploadSkillFile,
} from '../user-skill-file-roundtrip';

/**
 * Pure-logic tests for the SKILL.md file roundtrip helper.
 *
 * The action-handler (`user-skill-menu-action-handler.test.ts`) covers the
 * outbound upload + marker-arming side via the integration mock. This file
 * exercises `consumePendingSkillUpload` in isolation — every guard, every
 * outcome — so the event-router glue can stay a thin wrapper.
 */
describe('consumePendingSkillUpload', () => {
  // Test-time deps: in-memory readCurrentContent / hash / applyUpdate +
  // injectable downloadFile so we never touch the network or the real
  // user-skill-store.
  let deps: ConsumeUploadDeps;
  let applyUpdate: ReturnType<typeof vi.fn>;
  let downloadFile: ReturnType<typeof vi.fn>;
  let session: ConversationSession;

  const makeSession = (
    overrides?: Partial<NonNullable<ConversationSession['pendingSkillUpload']>>,
  ): ConversationSession => {
    const marker = {
      skillName: 'autoz',
      requesterId: 'U1',
      baselineHash: 'baseline-hash',
      expiresAt: Date.now() + EDIT_UPLOAD_TTL_MS,
      ...overrides,
    };
    return { pendingSkillUpload: marker } as unknown as ConversationSession;
  };

  beforeEach(() => {
    applyUpdate = vi.fn().mockReturnValue({ ok: true, message: 'Skill "autoz" updated.' });
    downloadFile = vi.fn().mockResolvedValue({ ok: true, content: 'NEW BYTES' });
    deps = {
      readCurrentContent: vi.fn().mockReturnValue('CURRENT BYTES') as ConsumeUploadDeps['readCurrentContent'],
      hashContent: vi.fn().mockReturnValue('baseline-hash') as ConsumeUploadDeps['hashContent'],
      applyUpdate: applyUpdate as unknown as ConsumeUploadDeps['applyUpdate'],
      downloadFile: downloadFile as unknown as ConsumeUploadDeps['downloadFile'],
    };
    session = makeSession();
  });

  // ---------- early-exit guards (consumed=false) ----------

  it('falls through with reason=no_marker when no pendingSkillUpload is set', async () => {
    session = makeSession();
    session.pendingSkillUpload = undefined;

    const r = await consumePendingSkillUpload({
      session,
      uploaderId: 'U1',
      files: [{ name: SKILL_FILE_NAME, url_private_download: 'https://x' }],
      deps,
    });

    expect(r).toEqual({ consumed: false, reason: 'no_marker' });
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('consumes the event with a TTL-expired notice when the marker is past expiresAt and the user uploaded a SKILL.md', async () => {
    // Expired-marker UX: a user who took >TTL to upload their edit MUST get
    // a clear "TTL expired" signal — the previous "fall through" behavior
    // routed their SKILL.md straight into Claude as a regular prompt
    // attachment with zero feedback, which is a silent data-loss bug.
    session = makeSession({ expiresAt: Date.now() - 1000 });

    const r = await consumePendingSkillUpload({
      session,
      uploaderId: 'U1',
      files: [{ name: SKILL_FILE_NAME, url_private_download: 'https://x' }],
      deps,
    });

    expect(r.consumed).toBe(true);
    if (!r.consumed) throw new Error('unreachable');
    expect(r.clearMarker).toBe(true);
    expect(r.message).toMatch(/만료|TTL/);
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('still falls through (no consume) when the marker is expired AND no SKILL.md is in the upload', async () => {
    // Non-SKILL.md uploads must NOT be eaten by a stale marker — they are
    // unrelated to the abandoned edit roundtrip.
    session = makeSession({ expiresAt: Date.now() - 1000 });

    const r = await consumePendingSkillUpload({
      session,
      uploaderId: 'U1',
      files: [{ name: 'screenshot.png', url_private_download: 'https://x' }],
      deps,
    });

    expect(r.consumed).toBe(false);
    if (r.consumed) throw new Error('unreachable');
    expect(r.reason).toBe('no_skill_md_file');
  });

  it('falls through with reason=uploader_mismatch when uploader is not the requester', async () => {
    const r = await consumePendingSkillUpload({
      session,
      uploaderId: 'U-other',
      files: [{ name: SKILL_FILE_NAME, url_private_download: 'https://x' }],
      deps,
    });

    expect(r.consumed).toBe(false);
    if (r.consumed) throw new Error('unreachable');
    expect(r.reason).toBe('uploader_mismatch');
    // Marker survives — original requester can still complete.
    expect(r.clearMarker).toBeUndefined();
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('falls through with reason=no_skill_md_file when no .md file is in the upload', async () => {
    const r = await consumePendingSkillUpload({
      session,
      uploaderId: 'U1',
      files: [
        { name: 'screenshot.png', url_private_download: 'https://x' },
        { name: 'notes.txt', url_private_download: 'https://x' },
      ],
      deps,
    });

    expect(r.consumed).toBe(false);
    if (r.consumed) throw new Error('unreachable');
    expect(r.reason).toBe('no_skill_md_file');
    expect(downloadFile).not.toHaveBeenCalled();
  });

  // ---------- consumed=true outcomes ----------

  it('rejects with outcome=rejected_missing when the skill was deleted after the marker was armed', async () => {
    (deps.readCurrentContent as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const r = await consumePendingSkillUpload({
      session,
      uploaderId: 'U1',
      files: [{ name: SKILL_FILE_NAME, url_private_download: 'https://x' }],
      deps,
    });

    expect(r.consumed).toBe(true);
    if (!r.consumed) throw new Error('unreachable');
    expect(r.outcome).toBe('rejected_missing');
    expect(r.clearMarker).toBe(true);
    expect(r.message).toMatch(/존재하지 않/);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(applyUpdate).not.toHaveBeenCalled();
  });

  it('rejects with outcome=rejected_stale when on-disk SKILL.md changed since the baseline', async () => {
    (deps.hashContent as ReturnType<typeof vi.fn>).mockReturnValue('different-hash');

    const r = await consumePendingSkillUpload({
      session,
      uploaderId: 'U1',
      files: [{ name: SKILL_FILE_NAME, url_private_download: 'https://x' }],
      deps,
    });

    expect(r.consumed).toBe(true);
    if (!r.consumed) throw new Error('unreachable');
    expect(r.outcome).toBe('rejected_stale');
    expect(r.clearMarker).toBe(true);
    expect(r.message).toMatch(/변경되었/);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(applyUpdate).not.toHaveBeenCalled();
  });

  it('rejects with outcome=rejected_download (no clearMarker) when downloadFile fails', async () => {
    downloadFile.mockResolvedValueOnce({ ok: false, error: 'HTTP 500' });

    const r = await consumePendingSkillUpload({
      session,
      uploaderId: 'U1',
      files: [{ name: SKILL_FILE_NAME, url_private_download: 'https://x' }],
      deps,
    });

    expect(r.consumed).toBe(true);
    if (!r.consumed) throw new Error('unreachable');
    expect(r.outcome).toBe('rejected_download');
    // Marker survives so user can retry within TTL.
    expect(r.clearMarker).toBe(false);
    expect(r.message).toMatch(/HTTP 500/);
    expect(applyUpdate).not.toHaveBeenCalled();
  });

  it('rejects with outcome=rejected_update (no clearMarker) when applyUpdate fails validation', async () => {
    applyUpdate.mockReturnValue({ ok: false, message: 'Skill exceeds max size (10KB).' });

    const r = await consumePendingSkillUpload({
      session,
      uploaderId: 'U1',
      files: [{ name: SKILL_FILE_NAME, url_private_download: 'https://x' }],
      deps,
    });

    expect(r.consumed).toBe(true);
    if (!r.consumed) throw new Error('unreachable');
    expect(r.outcome).toBe('rejected_update');
    expect(r.clearMarker).toBe(false);
    expect(r.message).toMatch(/exceeds max size/);
    expect(applyUpdate).toHaveBeenCalledWith('U1', 'autoz', 'NEW BYTES');
  });

  it('applies the SKILL.md update on the happy path with outcome=applied + clearMarker', async () => {
    const r = await consumePendingSkillUpload({
      session,
      uploaderId: 'U1',
      files: [{ name: SKILL_FILE_NAME, url_private_download: 'https://x' }],
      deps,
    });

    expect(r.consumed).toBe(true);
    if (!r.consumed) throw new Error('unreachable');
    expect(r.outcome).toBe('applied');
    expect(r.clearMarker).toBe(true);
    expect(r.message).toMatch(/업데이트되었습니다/);
    expect(applyUpdate).toHaveBeenCalledWith('U1', 'autoz', 'NEW BYTES');
  });

  it('uses the injected now for expiry comparisons (deterministic for tests)', async () => {
    session = makeSession({ expiresAt: 1000 });

    const r = await consumePendingSkillUpload({
      session,
      uploaderId: 'U1',
      files: [{ name: SKILL_FILE_NAME, url_private_download: 'https://x' }],
      now: 2000,
      deps,
    });

    expect(r.consumed).toBe(true);
    if (!r.consumed) throw new Error('unreachable');
    expect(r.clearMarker).toBe(true);
    expect(r.message).toMatch(/만료/);
  });

  it('matches SKILL.md filename case-insensitively (skill.md / Skill.MD / SKILL.md all accepted)', async () => {
    for (const name of ['skill.md', 'Skill.MD', 'SKILL.md']) {
      session = makeSession();
      const r = await consumePendingSkillUpload({
        session,
        uploaderId: 'U1',
        files: [{ name, url_private_download: 'https://x' }],
        deps,
      });
      expect(r.consumed).toBe(true);
      if (!r.consumed) throw new Error('unreachable');
      expect(r.outcome).toBe('applied');
    }
  });

  it('rejects oversize uploads via Slack-reported `size` before downloading (pre-fetch gate)', async () => {
    // Bot must not spend bandwidth on bytes the persistence layer would
    // reject anyway. The gate uses the file event's `size` field, which
    // Slack populates before bot acks the event.
    const r = await consumePendingSkillUpload({
      session,
      uploaderId: 'U1',
      files: [{ name: SKILL_FILE_NAME, url_private_download: 'https://x', size: 99999 }],
      maxBytes: 1024,
      deps,
    });

    expect(r.consumed).toBe(true);
    if (!r.consumed) throw new Error('unreachable');
    expect(r.outcome).toBe('rejected_update');
    expect(r.clearMarker).toBe(false);
    expect(r.message).toMatch(/너무 큽니다|99999/);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(applyUpdate).not.toHaveBeenCalled();
  });
});

describe('uploadSkillFile', () => {
  it('omits thread_ts from the filesUploadV2 call when caller did not supply one', async () => {
    // Slack's TS overload for `FileThreadDestinationArgument` types
    // `thread_ts` as required `string`; passing `undefined` would not
    // compile and surprisingly does not silently no-op at runtime either.
    // The helper must spread the field only when set.
    const filesUploadV2 = vi.fn().mockResolvedValue({ ok: true });
    const client = { filesUploadV2 } as any;

    const r = await uploadSkillFile({
      client,
      channelId: 'C1',
      skillName: 'a',
      content: 'BODY',
      title: 'T',
    });

    expect(r).toEqual({ ok: true });
    expect(filesUploadV2).toHaveBeenCalledTimes(1);
    const call = filesUploadV2.mock.calls[0][0];
    expect(call.thread_ts).toBeUndefined();
    expect(call.filename).toBe('SKILL.md');
    expect(call.content).toBe('BODY');
    expect(call.channel_id).toBe('C1');
  });

  it('forwards thread_ts when supplied', async () => {
    const filesUploadV2 = vi.fn().mockResolvedValue({ ok: true });
    const client = { filesUploadV2 } as any;

    await uploadSkillFile({
      client,
      channelId: 'C1',
      threadTs: 'T1',
      skillName: 'a',
      content: 'BODY',
      title: 'T',
    });

    expect(filesUploadV2.mock.calls[0][0].thread_ts).toBe('T1');
  });

  it('returns ok=false with the error message when filesUploadV2 rejects', async () => {
    const filesUploadV2 = vi.fn().mockRejectedValue(new Error('rate-limited'));
    const client = { filesUploadV2 } as any;

    const r = await uploadSkillFile({
      client,
      channelId: 'C1',
      skillName: 'a',
      content: 'BODY',
      title: 'T',
    });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/rate-limited/);
  });
});
