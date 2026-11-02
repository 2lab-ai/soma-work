import { describe, expect, it, vi } from 'vitest';
import {
  createSettingsRegistry,
  SettingsError,
  type SettingsRegistryDeps,
  type SettingsStoreLike,
} from '../user-settings-registry';

// SSOT 2026-10-23 T2 — every personal setting a Slack command can change is
// readable and writable through one registry, and every write goes through the
// same mutation path Slack uses (the `/z` apply function or the same
// validator + setter).

function memoryStore(): SettingsStoreLike & { data: Record<string, any> } {
  const data: Record<string, any> = {};
  const u = (id: string) => (data[id] ??= {});
  return {
    data,
    getUserDefaultModel: (id) => u(id).model ?? 'claude-opus-5-5[1m]',
    setUserDefaultModel: (id, m) => {
      u(id).model = m;
    },
    getModelDisplayName: (m) => `Display(${m})`,
    getUserDefaultEffort: (id) => u(id).effort ?? 'xhigh',
    setUserDefaultEffort: (id, e) => {
      u(id).effort = e;
    },
    resolveEffortInput: (input) => {
      const n = input.toLowerCase().trim();
      return ['low', 'medium', 'high', 'xhigh', 'max'].includes(n) ? (n as any) : null;
    },
    getUserDefaultLogVerbosity: (id) => u(id).verbosity ?? 'minimal',
    getUserSessionTheme: (id) => u(id).theme ?? 'default',
    getUserPersona: (id) => u(id).persona ?? 'default',
    getUserEmail: (id) => u(id).email,
    getUserSettings: (id) => ({ notification: u(id).notification }),
    patchNotification: (id, patch) => {
      u(id).notification = { ...(u(id).notification || {}), ...patch };
    },
    getUserAutoGoalEnabled: (id) => !!u(id).autoGoal,
    setUserAutoGoalEnabled: (id, v) => {
      u(id).autoGoal = v;
    },
    getUserGoalMaxContinuations: (id) => u(id).goalMax,
    setUserGoalMaxContinuations: (id, v) => {
      u(id).goalMax = v;
    },
    getUserAutoskills: (id) => [...(u(id).autoskills || [])],
    setUserAutoskills: (id, s) => {
      u(id).autoskills = s;
    },
    getUserRating: (id) => u(id).rating ?? 5,
    changeUserRating: (id, r) => {
      const from = u(id).rating ?? 5;
      u(id).rating = r;
      if (from !== r) u(id).pending = { from, to: r };
      return { from, to: r };
    },
    getUserPermissionMode: (id) => u(id).mode ?? 'auto',
    getUserSlackTaskEntry: (id) => !!u(id).slackTaskEntry,
    getUserEpicTasks: (id) => !!u(id).epicTasks,
    setUserEpicTasks: (id, v) => {
      u(id).epicTasks = v;
    },
    setUserSlackTaskEntry: (id, v) => {
      u(id).slackTaskEntry = v;
    },
    getUserSandboxDisabled: (id) => !!u(id).sandboxOff,
    getUserNetworkDisabled: (id) => !!u(id).networkOff,
    getUserDashboardMode: (id) => u(id).dashboardMode ?? 'minimal',
    setUserDashboardMode: (id, m) => {
      u(id).dashboardMode = m;
    },
    getUserDashboardLayout: (id) => u(id).dashboardLayout ?? { v: 1 },
    setUserDashboardLayout: (id, doc) => {
      u(id).dashboardLayout = doc;
    },
    getUserDashboardPlan: (id) => u(id).dashboardPlan ?? '1',
    setUserDashboardPlan: (id, p) => {
      u(id).dashboardPlan = p;
    },
  };
}

function setup(over: Partial<SettingsRegistryDeps> = {}) {
  const store = memoryStore();
  const ok = (summary = 'ok') => vi.fn(async () => ({ ok: true, summary }));
  const apply = {
    persona: ok(),
    theme: ok(),
    verbosity: ok(),
    permissionMode: ok(),
    sandbox: vi.fn(async ({ userId, value }: { userId: string; value: string }) =>
      (value === 'on' || value === 'off') && userId !== 'U_ADMIN'
        ? { ok: false, summary: '🚫 Admin only: sandbox on/off는 관리자만 변경 가능합니다.' }
        : { ok: true, summary: 'ok' },
    ),
    notify: ok(),
    email: ok(),
  };
  const resolveModel = vi.fn(async (value: string) =>
    value === 'nope'
      ? { ok: false as const, summary: '❌ Unknown model: `nope`', description: 'Available aliases: `opus`' }
      : { ok: true as const, modelId: value },
  );
  const deps: SettingsRegistryDeps = {
    store,
    resolveModel,
    apply,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    verbosityLevels: ['minimal', 'compact', 'detail', 'verbose'],
    themes: { default: 'Default', compact: 'Compact', minimal: 'Minimal' },
    defaults: {
      model: 'claude-opus-5-5[1m]',
      effort: 'xhigh',
      verbosity: 'minimal',
      theme: 'default',
      goalMaxContinuations: 10,
    },
    goalMaxBounds: { min: 1, max: 1000 },
    maxAutoskills: 20,
    validateGoalMax: (v) => {
      if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error('goal max must be an integer');
      return Math.min(1000, Math.max(1, v));
    },
    listPersonas: () => ['default', 'linus'],
    listModels: () => [
      { nickname: 'opus[1m]', model: 'claude-opus-5-5[1m]', label: 'Opus 5.5' },
      { nickname: 'grok[1m]', model: 'grok-4.6', label: 'Grok 4.6' },
    ],
    listSkills: () => [{ name: 'local:z' }, { name: 'local:autoz' }],
    skillExists: (name) => name.startsWith('local:'),
    validateWebhookUrl: (url) =>
      url.startsWith('https://') && !url.includes('127.0.0.1')
        ? { valid: true }
        : { valid: false, error: 'HTTPS URL만 등록 가능합니다.' },
    workingDirectoryFor: (id) => `/work/${id}`,
    isAdmin: (id) => id === 'U_ADMIN',
    isAccepted: (id) => id !== 'U_DENIED',
    ...over,
  };
  // `apply.model` is the model resolver (the save itself is the store setter).
  return { registry: createSettingsRegistry(deps), store, apply: { ...apply, model: deps.resolveModel } };
}

async function refused(p: Promise<unknown>, status: number): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(SettingsError);
    expect((e as SettingsError).statusCode).toBe(status);
    return (e as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('settings registry — read', () => {
  it('lists every Slack-changeable personal setting, grouped, with its Slack command', () => {
    const { registry } = setup();
    const snap = registry.read('U1');
    expect(snap.settings.map((s) => s.key)).toEqual([
      'defaultModel',
      'defaultEffort',
      'logVerbosity',
      'sessionTheme',
      'persona',
      'notifySlackDm',
      'notifyTelegram',
      'notifyWebhook',
      'autoGoal',
      'goalMaxContinuations',
      'autoskills',
      'email',
      'rating',
      'workingDirectory',
      'slackTaskEntry',
      'epicTasks',
      'permissionMode',
      'sandbox',
      'sandboxNetwork',
      'dashboardMode',
      'dashboardPlan',
    ]);
    for (const s of snap.settings) {
      // A dashboard-only setting (the dashboard's own view) has no Slack command; every other one names it.
      if (s.group === 'dashboard') expect(s.slackCommand).toBeUndefined();
      else expect(s.slackCommand).toBeTruthy();
      expect(snap.groups.map((g) => g.id)).toContain(s.group);
    }
  });

  it('shows the default model as its representative nickname and marks unmodified rows', () => {
    const { registry } = setup();
    const model = registry.read('U1').settings.find((s) => s.key === 'defaultModel')!;
    expect(model.value).toBe('opus[1m]');
    expect(model.modified).toBe(false);
    expect(model.options!.map((o) => o.value)).toEqual(['opus[1m]', 'grok[1m]']);
  });

  it('keeps a non-representative default model visible as the first option', () => {
    const { registry, store } = setup();
    store.data.U1 = { model: 'claude-sonnet-4-6' };
    const model = registry.read('U1').settings.find((s) => s.key === 'defaultModel')!;
    expect(model.value).toBe('claude-sonnet-4-6');
    expect(model.options![0]).toMatchObject({ value: 'claude-sonnet-4-6', label: 'Display(claude-sonnet-4-6)' });
    expect(model.modified).toBe(true);
  });

  it('locks sandbox for a non-admin and opens it for an admin; cwd is read-only', () => {
    const { registry } = setup();
    const plainUser = registry.read('U1').settings;
    expect(plainUser.find((s) => s.key === 'sandbox')).toMatchObject({ editable: false, adminOnly: true });
    expect(plainUser.find((s) => s.key === 'workingDirectory')).toMatchObject({ editable: false, value: '/work/U1' });
    expect(registry.read('U_ADMIN').settings.find((s) => s.key === 'sandbox')).toMatchObject({ editable: true });
  });
});

describe('settings registry — write', () => {
  it('default model goes through the /z model resolver and returns the fresh view', async () => {
    const { registry, apply } = setup();
    const v = await registry.write('U1', 'defaultModel', 'grok[1m]');
    expect(apply.model).toHaveBeenCalledWith('grok-4.6');
    expect(v.value).toBe('grok[1m]');
    expect(v.modified).toBe(true);
  });

  it('an apply refusal becomes a 400 with the card text, minus Slack markup', async () => {
    const { registry } = setup();
    const msg = await refused(registry.write('U1', 'defaultModel', 'nope'), 400);
    expect(msg).toBe('❌ Unknown model: nope — Available aliases: opus');
  });

  it('default effort is validated like the Slack resolver', async () => {
    const { registry, store } = setup();
    await registry.write('U1', 'defaultEffort', 'HIGH');
    expect(store.data.U1.effort).toBe('high');
    await refused(registry.write('U1', 'defaultEffort', 'ultra'), 400);
  });

  it('notification: DM via the card, Telegram id and webhook validated, empty clears', async () => {
    const { registry, apply, store } = setup();
    await registry.write('U1', 'notifySlackDm', true);
    expect(apply.notify).toHaveBeenCalledWith({ userId: 'U1', value: 'dm_on' });
    await registry.write('U1', 'notifyTelegram', '-100123');
    expect(store.data.U1.notification.telegramChatId).toBe('-100123');
    await refused(registry.write('U1', 'notifyTelegram', '12ab'), 400);
    await registry.write('U1', 'notifyTelegram', '');
    expect(apply.notify).toHaveBeenCalledWith({ userId: 'U1', value: 'tg_clear' });
    await registry.write('U1', 'notifyWebhook', 'https://hooks.example.com/x');
    expect(store.data.U1.notification.webhookUrl).toBe('https://hooks.example.com/x');
    expect(await refused(registry.write('U1', 'notifyWebhook', 'http://127.0.0.1/x'), 400)).toContain('HTTPS');
    await registry.write('U1', 'notifyWebhook', '');
    expect(store.data.U1.notification.webhookUrl).toBeUndefined();
  });

  it('goal max clamps like Slack; a non-integer is refused', async () => {
    const { registry, store } = setup();
    await registry.write('U1', 'goalMaxContinuations', 5000);
    expect(store.data.U1.goalMax).toBe(1000);
    await refused(registry.write('U1', 'goalMaxContinuations', 2.5), 400);
  });

  it('autoskills: unknown names refused, duplicates collapsed, cap enforced', async () => {
    const { registry, store } = setup();
    await registry.write('U1', 'autoskills', ['local:z', 'local:z', ' local:autoz ']);
    expect(store.data.U1.autoskills).toEqual(['local:z', 'local:autoz']);
    expect(await refused(registry.write('U1', 'autoskills', ['ghost']), 400)).toContain('ghost');
    await refused(registry.write('U1', 'autoskills', 'local:z'), 400);
  });

  it('rating records the pending change the agent is told about, like `rate +`', async () => {
    const { registry, store } = setup();
    await registry.write('U1', 'rating', 8);
    expect(store.data.U1).toMatchObject({ rating: 8, pending: { from: 5, to: 8 } });
    await refused(registry.write('U1', 'rating', 11), 400);
  });

  it('sandbox: a non-admin is refused before any write; an admin goes through applySandbox', async () => {
    const { registry, apply } = setup();
    await refused(registry.write('U1', 'sandbox', false), 403);
    expect(apply.sandbox).not.toHaveBeenCalled();
    await registry.write('U_ADMIN', 'sandbox', false);
    expect(apply.sandbox).toHaveBeenCalledWith({ userId: 'U_ADMIN', value: 'off' });
    await registry.write('U1', 'sandboxNetwork', false);
    expect(apply.sandbox).toHaveBeenCalledWith({ userId: 'U1', value: 'network_off' });
  });

  it('slackTaskEntry (E2 ⑧): off by default, a toggle in account, written through the store setter', async () => {
    const { registry, store } = setup();
    const row = registry.read('U1').settings.find((s) => s.key === 'slackTaskEntry')!;
    expect(row).toMatchObject({ kind: 'toggle', group: 'account', value: false, modified: false, editable: true });
    expect(row.slackCommand).toBe('taskentry on|off');
    const v = await registry.write('U1', 'slackTaskEntry', true);
    expect(store.data.U1.slackTaskEntry).toBe(true);
    expect(v).toMatchObject({ value: true, modified: true });
    await refused(registry.write('U1', 'slackTaskEntry', 'on'), 400);
  });

  it('epicTasks (E4 ④a-2): off by default, a toggle in account, written through the store setter', async () => {
    const { registry, store } = setup();
    const row = registry.read('U1').settings.find((s) => s.key === 'epicTasks')!;
    expect(row).toMatchObject({ kind: 'toggle', group: 'account', value: false, modified: false, editable: true });
    expect(row.slackCommand).toBe('epictasks on|off');
    const v = await registry.write('U1', 'epicTasks', true);
    expect(store.data.U1.epicTasks).toBe(true);
    expect(v).toMatchObject({ value: true, modified: true });
    await refused(registry.write('U1', 'epicTasks', 'on'), 400);
  });

  it('dashboardMode (SSOT 2026-11-01): minimal by default, a choice in its own dashboard group, saved per user', async () => {
    const { registry, store } = setup();
    const row = registry.read('U1').settings.find((s) => s.key === 'dashboardMode')!;
    expect(row).toMatchObject({
      kind: 'choice',
      group: 'dashboard',
      value: 'minimal',
      defaultValue: 'minimal',
      modified: false,
      editable: true,
    });
    expect(row.options!.map((o) => o.value)).toEqual(['minimal', 'advanced']);
    expect(registry.read('U1').groups.map((g) => g.id)).toContain('dashboard');
    const v = await registry.write('U1', 'dashboardMode', 'advanced');
    expect(store.data.U1.dashboardMode).toBe('advanced');
    expect(v).toMatchObject({ value: 'advanced', modified: true });
    // Another user keeps the default — the choice is per user.
    expect(registry.read('U2').settings.find((s) => s.key === 'dashboardMode')!.value).toBe('minimal');
    await registry.write('U1', 'dashboardMode', 'minimal');
    expect(store.data.U1.dashboardMode).toBe('minimal');
    await refused(registry.write('U1', 'dashboardMode', 'detail'), 400);
    await refused(registry.write('U1', 'dashboardMode', true), 400);
    // A denied user cannot write it either (a write must not re-create the record).
    await refused(registry.write('U_DENIED', 'dashboardMode', 'advanced'), 403);
    expect(store.data.U_DENIED).toBeUndefined();
  });

  it('dashboardPlan (SSOT 2026-11-01 ④, .prd/20): 1안 by default, 1 · 2 · 3 in the dashboard group, saved per user', async () => {
    const { registry, store } = setup();
    const row = registry.read('U1').settings.find((s) => s.key === 'dashboardPlan')!;
    expect(row).toMatchObject({
      kind: 'choice',
      group: 'dashboard',
      label: '화면 구성안',
      value: '1',
      defaultValue: '1',
      modified: false,
      editable: true,
    });
    expect(row.slackCommand).toBeUndefined();
    expect(row.options!.map((o) => o.value)).toEqual(['1', '2', '3']);
    // Each option says what it is in both modes.
    for (const o of row.options!) expect(o.description).toMatch(/미니멀.*어드밴스드/);
    const v = await registry.write('U1', 'dashboardPlan', '3');
    expect(store.data.U1.dashboardPlan).toBe('3');
    expect(v).toMatchObject({ value: '3', modified: true });
    expect(registry.read('U2').settings.find((s) => s.key === 'dashboardPlan')!.value).toBe('1');
    await refused(registry.write('U1', 'dashboardPlan', '4'), 400);
    await refused(registry.write('U1', 'dashboardPlan', 2), 400);
    await refused(registry.write('U_DENIED', 'dashboardPlan', '2'), 403);
    expect(store.data.U_DENIED).toBeUndefined();
  });

  it('dashboard layouts (.prd/21): read with the built-ins and the catalog; a write is checked and accepted-only', () => {
    const { registry, store } = setup();
    const snap = registry.readLayout('U1');
    expect(snap).toMatchObject({ userId: 'U1', accepted: true, doc: { v: 1 }, plan: '1', mode: 'minimal' });
    expect(Object.keys(snap.builtins)).toEqual(['1', '2', '3']);
    expect(snap.catalog.card.rows.length).toBeGreaterThan(0);
    const written = registry.writeLayout('U1', {
      active: { card: '2' },
      presets: {
        '1': {
          minimal: {
            card: {
              rows: [
                { id: 'task', on: true },
                { id: 'nope', on: true },
              ],
            },
          },
        },
      },
    });
    expect(store.data.U1.dashboardLayout.active).toEqual({ card: '2' });
    // Checked on the way in: the unknown id is gone, the missing ones are appended off.
    const rows = written.doc.presets!['1']!.minimal!.card!.rows;
    expect(rows[0]).toEqual({ id: 'task', on: true });
    expect(rows.map((r) => r.id)).not.toContain('nope');
    expect(rows).toHaveLength(5);
    expect(() => registry.writeLayout('U1', 'x')).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(() => registry.writeLayout('U_DENIED', { active: { card: '3' } })).toThrow(
      expect.objectContaining({ statusCode: 403 }),
    );
    expect(store.data.U_DENIED).toBeUndefined();
  });

  it('read-only and unknown keys are refused; wrong value types are 400', async () => {
    const { registry } = setup();
    await refused(registry.write('U1', 'workingDirectory', '/tmp'), 403);
    await refused(registry.write('U1', 'bogus', 1), 400);
    await refused(registry.write('U1', 'autoGoal', 'yes'), 400);
    await refused(registry.write('U1', 'email', 42), 400);
  });

  it('a user without admin acceptance (denied or never accepted) cannot write — a write must not re-create the record', async () => {
    const { registry, store, apply } = setup();
    expect(await refused(registry.write('U_DENIED', 'defaultEffort', 'low'), 403)).toContain('승인');
    await refused(registry.write('U_DENIED', 'defaultModel', 'grok[1m]'), 403);
    expect(store.data.U_DENIED).toBeUndefined();
    expect(apply.model).not.toHaveBeenCalled();
    expect(registry.read('U_DENIED').accepted).toBe(false);
    expect(registry.read('U1').accepted).toBe(true);
  });

  it('an admin deny that lands while the model is still being resolved wins: no write, 403, no record (review R2 P1)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let accepted = true;
    const { registry, store } = setup({
      isAccepted: () => accepted,
      resolveModel: vi.fn(async (value: string) => {
        await gate; // the catalog refresh Slack's /z model also waits on
        return { ok: true as const, modelId: value };
      }),
    });
    const pending = registry.write('U1', 'defaultModel', 'claude-sonnet-4-6');
    accepted = false; // admin deny + removeUserSettings meanwhile
    delete store.data.U1;
    release();
    await refused(pending, 403);
    expect(store.data.U1).toBeUndefined();
  });

  it('a representative nickname is saved as the model id it stands for (grok[1m] → grok-4.6)', async () => {
    const { registry, apply } = setup();
    await registry.write('U1', 'defaultModel', 'grok[1m]');
    expect(apply.model).toHaveBeenCalledWith('grok-4.6');
    await registry.write('U1', 'defaultModel', 'claude-sonnet-4-6');
    expect(apply.model).toHaveBeenLastCalledWith('claude-sonnet-4-6');
  });

  it('email: empty clears through the card', async () => {
    const { registry, apply } = setup();
    await registry.write('U1', 'email', '  ');
    expect(apply.email).toHaveBeenCalledWith({ userId: 'U1', value: 'clear' });
  });
});
