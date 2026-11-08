/**
 * llmux save mode — dashboard client half. Executes the shipped client code cut
 * out of renderDashboardPage()'s template (harness of
 * dashboard-cron-capacity-client.test.ts): the top-bar chip (admins only, its
 * state from the capacity view), the dialog's default cutoff (the next Monday
 * 15:00), the cutoff input, and the PUT that turns the mode on or off.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function assertUnique(name: string) {
  const re = new RegExp(`^(?:async function|function|var|let|const) ${name}\\b`, 'gm');
  const n = (TEMPLATE.match(re) ?? []).length;
  if (n > 1) throw new Error(`client ${name} is declared ${n} times`);
}
function clientFn(name: string): string {
  assertUnique(name);
  const plain = TEMPLATE.indexOf(`\nfunction ${name}(`);
  const start = plain >= 0 ? plain : TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function load<T>(fns: string[], inject: Record<string, unknown> = {}, extra = ''): T {
  const names = Object.keys(inject);
  const body = `${fns.map(clientFn).join('\n')}\n${extra}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const pad2 = (n: number) => (n < 10 ? '0' : '') + n;
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe('save mode — pure helpers', () => {
  const h = load<{
    saveModeDefaultUntil(nowMs: number): number;
    saveModeInputValue(sec: number): string;
    saveModeFromInput(value: string, nowMs: number): { ok: boolean; until?: number; error?: string };
    saveModeChip(sm: unknown, nowMs: number, lang: string): { on: boolean; label: string; title: string } | null;
  }>(['saveModeDefaultUntil', 'saveModeInputValue', 'saveModeFromInput', 'saveModeChip'], { pad2 });

  it('the default cutoff is the next Monday 15:00 local', () => {
    // Friday 2026-11-06 21:40 → Monday 2026-11-09 15:00
    expect(h.saveModeDefaultUntil(local(2026, 11, 6, 21, 40))).toBe(local(2026, 11, 9, 15) / 1000);
    // Sunday → the next day
    expect(h.saveModeDefaultUntil(local(2026, 11, 8, 12))).toBe(local(2026, 11, 9, 15) / 1000);
    // Monday morning → today 15:00; Monday 15:00 or later → next week
    expect(h.saveModeDefaultUntil(local(2026, 11, 9, 9))).toBe(local(2026, 11, 9, 15) / 1000);
    expect(h.saveModeDefaultUntil(local(2026, 11, 9, 15))).toBe(local(2026, 11, 16, 15) / 1000);
  });

  it('the input value and the cutoff round-trip in local time', () => {
    const sec = local(2026, 11, 9, 15) / 1000;
    expect(h.saveModeInputValue(sec)).toBe('2026-11-09T15:00');
    const now = local(2026, 11, 6, 21, 40);
    expect(h.saveModeFromInput('2026-11-09T15:00', now)).toEqual({ ok: true, until: sec });
  });

  it('refuses an empty, past or far cutoff with a reason', () => {
    const now = local(2026, 11, 6, 21, 40);
    expect(h.saveModeFromInput('', now).ok).toBe(false);
    expect(h.saveModeFromInput('2026-11-06T21:00', now).ok).toBe(false);
    expect(h.saveModeFromInput('2026-12-31T15:00', now).ok).toBe(false);
    for (const v of ['', '2026-11-06T21:00', '2026-12-31T15:00'])
      expect(h.saveModeFromInput(v, now).error).toBeTruthy();
  });

  it('a wall time a DST jump skips is refused, not shifted an hour', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const now = new Date(2027, 2, 12, 12, 0).getTime(); // Friday before the jump
      const r = h.saveModeFromInput('2027-03-14T02:30', now); // 02:00–03:00 does not exist
      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();
      expect(h.saveModeFromInput('2027-03-14T03:30', now).ok).toBe(true);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it('the chip: hidden without save mode, off, or on with the cutoff', () => {
    const now = local(2026, 11, 6, 21, 40);
    const until = local(2026, 11, 9, 15) / 1000;
    expect(h.saveModeChip(undefined, now, 'ko')).toBeNull();
    expect(h.saveModeChip({ until: null, active: false, held: 0 }, now, 'ko')).toMatchObject({ on: false });
    // A cutoff that has passed reads off even when llmux has not polled since.
    expect(h.saveModeChip({ until: now / 1000 - 60, active: true, held: 2 }, now, 'ko')).toMatchObject({ on: false });
    const on = h.saveModeChip({ until, active: true, held: 3 }, now, 'ko');
    expect(on?.on).toBe(true);
    expect(on?.label).toContain('15:00');
    expect(on?.title).toContain('3');
  });
});

describe('save mode — the chip and the PUT', () => {
  function el() {
    const attrs: Record<string, string> = {};
    return {
      style: { display: '' },
      hidden: false,
      title: '',
      textContent: '',
      value: '',
      setAttribute: (k: string, v: string) => {
        attrs[k] = v;
      },
      removeAttribute: (k: string) => {
        delete attrs[k];
      },
      getAttribute: (k: string) => attrs[k] ?? null,
      focus: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
    };
  }
  function page(opts: { admin: boolean; view: unknown; fetchImpl?: (...a: unknown[]) => Promise<unknown> }) {
    const els: Record<string, ReturnType<typeof el>> = {};
    for (const id of [
      'save-mode-btn',
      'save-mode-label',
      'save-mode-dialog',
      'sm-until',
      'save-mode-off',
      'save-mode-on',
      'save-mode-status',
    ])
      els[id] = el();
    const fetchMock = vi.fn(opts.fetchImpl ?? (async () => ({ ok: true, status: 200, json: async () => ({}) })));
    const inject = {
      document: { getElementById: (id: string) => els[id] ?? null, hidden: false },
      console: { error: () => {} },
      fetch: fetchMock,
      pad2,
      setTextIfChanged: (e: { textContent: string } | null, t: string) => {
        if (e) e.textContent = t;
      },
      pageDisplayLang: () => 'ko',
      paintCapacity: vi.fn(),
      refreshCsrfToken: vi.fn(),
      _isAdminModeOn: () => true,
      _csrfToken: 'csrf-1',
    };
    const api = load<any>(
      [
        'saveModeDefaultUntil',
        'saveModeInputValue',
        'saveModeFromInput',
        'saveModeChip',
        'paintSaveModeChip',
        'setSaveModeStatus',
        'openSaveModeDialog',
        'closeSaveModeDialog',
        'submitSaveMode',
        'loadCapacity',
      ],
      inject,
      `var _viewerIsAdmin = ${opts.admin ? 'true' : 'false'}; var _capacityView = ${JSON.stringify(opts.view)};
       var _capacityLoadSeq = 0; var _saveModeBusy = false;
       function state() { return _capacityView; }`,
    );
    return { api, els, fetchMock, inject };
  }

  const FUTURE = Math.floor(Date.now() / 1000) + 3 * 86400;

  it('admins see the chip; others never do', () => {
    const view = { available: true, groups: [], saveMode: { until: null, active: false, held: 0 } };
    const admin = page({ admin: true, view });
    admin.api.paintSaveModeChip();
    expect(admin.els['save-mode-btn'].style.display).toBe('inline-flex');
    expect(admin.els['save-mode-btn'].getAttribute('aria-pressed')).toBe('false');
    const plain = page({ admin: false, view });
    plain.api.paintSaveModeChip();
    expect(plain.els['save-mode-btn'].style.display).toBe('none');
  });

  it('an llmux without save mode hides the chip', () => {
    const p = page({ admin: true, view: { available: true, groups: [] } });
    p.api.paintSaveModeChip();
    expect(p.els['save-mode-btn'].style.display).toBe('none');
  });

  it('on: pressed, and the label names the cutoff', () => {
    const p = page({
      admin: true,
      view: { available: true, groups: [], saveMode: { until: FUTURE, active: true, held: 2 } },
    });
    p.api.paintSaveModeChip();
    expect(p.els['save-mode-btn'].getAttribute('aria-pressed')).toBe('true');
    expect(p.els['save-mode-label'].textContent).not.toBe('');
  });

  it('opening while off offers the next Monday 15:00 and no 끄기', () => {
    const p = page({
      admin: true,
      view: { available: true, groups: [], saveMode: { until: null, active: false, held: 0 } },
    });
    p.api.openSaveModeDialog();
    expect(p.els['sm-until'].value).toMatch(/T15:00$/);
    expect(p.els['save-mode-off'].hidden).toBe(true);
    expect(p.els['save-mode-dialog'].show).toHaveBeenCalled();
  });

  it('opening while on shows the current cutoff and 끄기', () => {
    const p = page({
      admin: true,
      view: { available: true, groups: [], saveMode: { until: FUTURE, active: true, held: 2 } },
    });
    p.api.openSaveModeDialog();
    expect(p.els['sm-until'].value).toBe(p.api.saveModeInputValue(FUTURE));
    expect(p.els['save-mode-off'].hidden).toBe(false);
  });

  it('켜기 PUTs the cutoff with the CSRF token and adopts the fresh view', async () => {
    const fresh = { available: true, groups: [], saveMode: { until: FUTURE, active: true, held: 1 } };
    const p = page({
      admin: true,
      view: { available: true, groups: [], saveMode: { until: null, active: false, held: 0 } },
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ capacity: fresh }) }),
    });
    p.els['sm-until'].value = p.api.saveModeInputValue(FUTURE - (FUTURE % 60));
    await p.api.submitSaveMode({ preventDefault: () => {} }, true);
    const [url, init] = p.fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe('/api/dashboard/llmux-save-mode');
    expect(init.method).toBe('PUT');
    expect(init.headers['X-CSRF-Token']).toBe('csrf-1');
    expect(JSON.parse(init.body)).toEqual({ until: FUTURE - (FUTURE % 60) });
    expect(p.inject.paintCapacity).toHaveBeenCalled();
    expect(p.els['save-mode-btn'].getAttribute('aria-pressed')).toBe('true');
    expect(p.els['save-mode-dialog'].hide).toHaveBeenCalled();
  });

  it('끄기 PUTs null', async () => {
    const p = page({
      admin: true,
      view: { available: true, groups: [], saveMode: { until: FUTURE, active: true, held: 1 } },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          capacity: { available: true, groups: [], saveMode: { until: null, active: false, held: 0 } },
        }),
      }),
    });
    await p.api.submitSaveMode(null, false);
    const [, init] = p.fetchMock.mock.calls[0] as [string, any];
    expect(JSON.parse(init.body)).toEqual({ until: null });
    expect(p.els['save-mode-btn'].getAttribute('aria-pressed')).toBe('false');
  });

  it('a bad cutoff never reaches the server; a refusal keeps the dialog open with the reason', async () => {
    const p = page({
      admin: true,
      view: { available: true, groups: [], saveMode: { until: null, active: false, held: 0 } },
      fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'until must be in the future' }) }),
    });
    p.els['sm-until'].value = '2000-01-01T00:00';
    await p.api.submitSaveMode({ preventDefault: () => {} }, true);
    expect(p.fetchMock).not.toHaveBeenCalled();
    expect(p.els['save-mode-status'].getAttribute('data-tone')).toBe('fail');

    p.els['sm-until'].value = p.api.saveModeInputValue(FUTURE);
    await p.api.submitSaveMode({ preventDefault: () => {} }, true);
    expect(p.els['save-mode-status'].textContent).toContain('until must be in the future');
    expect(p.els['save-mode-dialog'].hide).not.toHaveBeenCalled();
  });

  it('an older capacity read that lands after the PUT does not undo it', async () => {
    const stale = { available: true, groups: [], saveMode: { until: null, active: false, held: 0 } };
    const fresh = { available: true, groups: [], saveMode: { until: FUTURE, active: true, held: 1 } };
    let releaseGet!: () => void;
    const getGate = new Promise<void>((r) => {
      releaseGet = r;
    });
    const p = page({
      admin: true,
      view: stale,
      fetchImpl: async (url: unknown) => {
        if (url === '/api/dashboard/capacity') {
          await getGate;
          return { ok: true, status: 200, json: async () => ({ capacity: stale }) };
        }
        return { ok: true, status: 200, json: async () => ({ capacity: fresh, saveMode: fresh.saveMode }) };
      },
    });
    const polling = p.api.loadCapacity();
    p.els['sm-until'].value = p.api.saveModeInputValue(FUTURE - (FUTURE % 60));
    await p.api.submitSaveMode({ preventDefault: () => {} }, true);
    releaseGet();
    await polling;
    expect(p.els['save-mode-btn'].getAttribute('aria-pressed')).toBe('true');
  });

  it('a second press while a change is being saved sends nothing', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const p = page({
      admin: true,
      view: { available: true, groups: [], saveMode: { until: FUTURE, active: true, held: 1 } },
      fetchImpl: async () => {
        await gate;
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });
    const first = p.api.submitSaveMode(null, false);
    const second = p.api.submitSaveMode(null, false);
    release();
    await Promise.all([first, second]);
    expect(p.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a change llmux took keeps the chip even when the fresh read failed', async () => {
    const p = page({
      admin: true,
      view: { available: true, groups: [], saveMode: { until: null, active: false, held: 0 } },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          capacity: { available: false, reason: 'llmux unreachable', groups: [] },
          saveMode: { until: FUTURE, active: true, held: 1 },
        }),
      }),
    });
    p.els['sm-until'].value = p.api.saveModeInputValue(FUTURE - (FUTURE % 60));
    await p.api.submitSaveMode({ preventDefault: () => {} }, true);
    expect(p.els['save-mode-btn'].style.display).toBe('inline-flex');
    expect(p.els['save-mode-btn'].getAttribute('aria-pressed')).toBe('true');
  });
});
