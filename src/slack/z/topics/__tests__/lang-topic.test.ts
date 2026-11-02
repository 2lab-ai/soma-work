/**
 * #772 — `lang ko` / `lang en` (and `/z lang`): one display language per
 * user, Korean by default. The same setting as the dashboard's top-right
 * en / ko toggle. Only an accepted user can change it (a store setter would
 * otherwise create the record as accepted and skip the new-user gate).
 */
import { describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  users: {} as Record<string, { accepted?: boolean; displayLanguage?: 'ko' | 'en' }>,
  fail: false,
}));

vi.mock('../../../../user-settings-store', () => ({
  userSettingsStore: {
    getUserSettings: (u: string) => store.users[u],
    getUserDisplayLanguage: (u: string) => store.users[u]?.displayLanguage ?? 'ko',
    setUserDisplayLanguage: (u: string, v: 'ko' | 'en') => {
      if (store.fail) throw new Error('disk full');
      store.users[u] = { ...(store.users[u] ?? { accepted: true }), displayLanguage: v };
    },
  },
}));

import { LangHandler } from '../../../commands/lang-handler';
import { applyLang, createLangTopicBinding, renderLangCard } from '../lang-topic';

function actionIds(blocks: any[]): string[] {
  const out: string[] = [];
  for (const b of blocks) if (b.type === 'actions') for (const e of b.elements) out.push(e.action_id);
  return out;
}

describe('lang topic', () => {
  it('the card shows the current language with ko / en buttons', async () => {
    store.users = { U1: { accepted: true } };
    const ko = await renderLangCard({ userId: 'U1', issuedAt: 1 });
    expect(ko.text).toContain('한국어');
    expect(actionIds(ko.blocks)).toEqual(expect.arrayContaining(['z_setting_lang_set_ko', 'z_setting_lang_set_en']));
    store.users.U1.displayLanguage = 'en';
    expect((await renderLangCard({ userId: 'U1', issuedAt: 2 })).text).toContain('English');
  });

  it('an accepted user switches to en and back; the answer is in the new language', async () => {
    store.users = { U1: { accepted: true } };
    const en = await applyLang({ userId: 'U1', value: 'en' });
    expect(en).toMatchObject({ ok: true });
    expect(en.summary).toContain('English');
    expect(en.summary).not.toMatch(/[가-힣]/);
    expect(store.users.U1.displayLanguage).toBe('en');
    const ko = await applyLang({ userId: 'U1', value: 'ko' });
    expect(ko.summary).toContain('한국어');
    expect(store.users.U1.displayLanguage).toBe('ko');
  });

  it('takes the names people type', async () => {
    store.users = { U1: { accepted: true } };
    await applyLang({ userId: 'U1', value: 'English' });
    expect(store.users.U1.displayLanguage).toBe('en');
    await applyLang({ userId: 'U1', value: '한국어' });
    expect(store.users.U1.displayLanguage).toBe('ko');
  });

  it('an unknown or pending user is refused and no record is made', async () => {
    store.users = { UP: { accepted: false } };
    expect(await applyLang({ userId: 'UNEW', value: 'en' })).toMatchObject({ ok: false });
    expect(store.users.UNEW).toBeUndefined();
    expect(await applyLang({ userId: 'UP', value: 'en' })).toMatchObject({ ok: false });
    expect(store.users.UP.displayLanguage).toBeUndefined();
  });

  it('a bad value is refused with the choices; a failed save is reported', async () => {
    store.users = { U1: { accepted: true } };
    const bad = await applyLang({ userId: 'U1', value: 'fr' });
    expect(bad).toMatchObject({ ok: false });
    expect(`${bad.summary} ${bad.description ?? ''}`).toMatch(/ko.*en/);
    store.fail = true;
    try {
      expect(await applyLang({ userId: 'U1', value: 'en' })).toMatchObject({ ok: false, description: 'disk full' });
    } finally {
      store.fail = false;
    }
  });

  it('the binding is the lang topic', () => {
    expect(createLangTopicBinding().topic).toBe('lang');
  });
});

describe('LangHandler — `lang ko|en`', () => {
  const h = new LangHandler();
  const ctx = (text: string) =>
    ({ user: 'U1', text, threadTs: '1.1', channel: 'C1', say: vi.fn(async () => ({})) }) as any;

  it('takes lang, its status, a language and the `/z` set form — nothing else', () => {
    for (const t of [
      'lang',
      'lang status',
      'lang ko',
      'lang en',
      'LANG EN',
      '/lang en',
      'lang set en',
      'language en',
    ]) {
      expect(h.canHandle(t), t).toBe(true);
    }
    for (const t of ['lang en please', 'languages', 'the lang en', 'language model 비교해줘']) {
      expect(h.canHandle(t), t).toBe(false);
    }
  });

  it('`lang en` saves and acks in English; bare shows the card', async () => {
    store.users = { U1: { accepted: true } };
    const en = ctx('lang en');
    expect(await h.execute(en)).toEqual({ handled: true });
    expect(store.users.U1.displayLanguage).toBe('en');
    expect(en.say).toHaveBeenCalledWith({ text: expect.stringContaining('English'), thread_ts: '1.1' });
    const bare = ctx('lang');
    await h.execute(bare);
    expect(bare.say.mock.calls[0][0].blocks.length).toBeGreaterThan(0);
  });

  it('a refusal is said, nothing saved', async () => {
    store.users = {};
    const c = ctx('lang en');
    await h.execute(c);
    expect(store.users.U1).toBeUndefined();
    expect(c.say).toHaveBeenCalledWith({ text: expect.stringContaining('관리자 승인'), thread_ts: '1.1' });
  });
});
