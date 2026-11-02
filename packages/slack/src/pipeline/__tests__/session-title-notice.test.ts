/**
 * Voice / image-only first message → the dashboard card is stuck on the
 * host stand-in title ("New Session") because intake had no text to title
 * from. The host cannot read a voice memo or an image; the model can. So on
 * every real user turn while the stand-in persists, the host tells the model
 * to resolve the user's intent (SSOT) and write the title itself through
 * UPDATE_SESSION { title, titleFillOnly: true }.
 *
 * This file fences the gate (when the notice is injected) and the notice
 * contract (what it asks for).
 */

import {
  SESSION_TITLE_NOTICE_MAX_TURNS,
  SESSION_TITLE_PENDING_NOTICE,
  shouldInjectSessionTitleNotice,
} from '@soma/slack/pipeline/session-title-notice';
import { describe, expect, it } from 'vitest';

const eligible = {
  title: 'New Session',
  isUserInput: true,
  isSlashCommand: false,
  noticeCount: 0,
};

describe('shouldInjectSessionTitleNotice — gate', () => {
  it('injects on a real user turn while the stand-in title persists', () => {
    expect(shouldInjectSessionTitleNotice(eligible)).toBe(true);
    expect(shouldInjectSessionTitleNotice({ ...eligible, title: 'Session Reset' })).toBe(true);
    expect(shouldInjectSessionTitleNotice({ ...eligible, title: 'Direct (skipDispatch)' })).toBe(true);
    expect(shouldInjectSessionTitleNotice({ ...eligible, noticeCount: undefined })).toBe(true);
  });

  it('stops once the session has a real title (self-terminating)', () => {
    expect(shouldInjectSessionTitleNotice({ ...eligible, title: '대시보드 제목 자동 갱신' })).toBe(false);
  });

  it('leaves empty titles to the per-turn summary fallback', () => {
    expect(shouldInjectSessionTitleNotice({ ...eligible, title: undefined })).toBe(false);
    expect(shouldInjectSessionTitleNotice({ ...eligible, title: '' })).toBe(false);
  });

  it('never fires on synthetic turns (auto-resume, cron, continuation, renew)', () => {
    expect(shouldInjectSessionTitleNotice({ ...eligible, isUserInput: false })).toBe(false);
    // `undefined` is not proof of a human turn — only an explicit true is.
    expect(shouldInjectSessionTitleNotice({ ...eligible, isUserInput: undefined })).toBe(false);
  });

  it('never fires on SDK local slash commands (the prompt must start with "/")', () => {
    expect(shouldInjectSessionTitleNotice({ ...eligible, isSlashCommand: true })).toBe(false);
  });

  it('gives up after the cap so a model that ignores it does not pay every turn', () => {
    expect(SESSION_TITLE_NOTICE_MAX_TURNS).toBe(3);
    expect(shouldInjectSessionTitleNotice({ ...eligible, noticeCount: SESSION_TITLE_NOTICE_MAX_TURNS - 1 })).toBe(true);
    expect(shouldInjectSessionTitleNotice({ ...eligible, noticeCount: SESSION_TITLE_NOTICE_MAX_TURNS })).toBe(false);
  });
});

describe('SESSION_TITLE_PENDING_NOTICE — contract', () => {
  it('is a single tagged block', () => {
    expect(SESSION_TITLE_PENDING_NOTICE.startsWith('<session-title-pending>')).toBe(true);
    expect(SESSION_TITLE_PENDING_NOTICE.trimEnd().endsWith('</session-title-pending>')).toBe(true);
  });

  it('asks the model to resolve the SSOT first, then write the title with the fill-only guard', () => {
    expect(SESSION_TITLE_PENDING_NOTICE).toContain('SSOT');
    expect(SESSION_TITLE_PENDING_NOTICE).toContain('UPDATE_SESSION');
    expect(SESSION_TITLE_PENDING_NOTICE).toContain('"titleFillOnly": true');
    expect(SESSION_TITLE_PENDING_NOTICE.indexOf('SSOT')).toBeLessThan(
      SESSION_TITLE_PENDING_NOTICE.indexOf('UPDATE_SESSION'),
    );
  });

  it('says the title is temporary without claiming why (forced workflows also produce it)', () => {
    expect(SESSION_TITLE_PENDING_NOTICE).toContain('temporary title');
  });

  it('treats attachment content as evidence, not naming instructions', () => {
    expect(SESSION_TITLE_PENDING_NOTICE).toContain('evidence');
  });

  it('is static host text — no interpolation slots', () => {
    expect(SESSION_TITLE_PENDING_NOTICE).not.toMatch(/\$\{|\{\{/);
  });
});
