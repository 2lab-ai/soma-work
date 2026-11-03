/**
 * #865 — a task's `goal …` sent from the open card is the host's goal command:
 * it starts no turn of its own, so the optimistic turn the page showed for it
 * leaves the transcript and the host's answer shows as a toast (the work log
 * keeps the notice). Any other answer leaves the send as it was.
 *
 * Executes the shipped `sendCommand` (cut out of renderDashboardPage()'s
 * template literal and cooked exactly as the browser receives it — the harness
 * of dashboard-optimistic-echo-client.test.ts) with its page globals stubbed.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
const SEND = (() => {
  const start = TEMPLATE.indexOf('\nasync function sendCommand(');
  if (start < 0) throw new Error('sendCommand not found');
  return cook(TEMPLATE.slice(start + 1, TEMPLATE.indexOf('\n}\n', start) + 2));
})();

type Toast = { title: string; description?: string; tone: string };

async function send(
  text: string,
  answer: { status: number; body: Record<string, unknown> },
  opts: { running?: boolean; ref?: string } = {},
) {
  const toasts: Toast[] = [];
  const appended: string[] = [];
  const dropped: string[] = [];
  const rows: Array<[string, string]> = [];
  const el = {
    data: { running: opts.running === true },
    setItemState: (ref: string, state: string) => rows.push([ref, state]),
  };
  const stubs: Record<string, unknown> = {
    document: { getElementById: (id: string) => (id === 'cmd-steer' ? el : null) },
    pcCanSend: () => true,
    pcGiveBack: () => {},
    ntReadFile: async () => ({}),
    dashToast: (t: Toast) => toasts.push(t),
    appendTurnToPanel: (turn: { id: string }) => appended.push(turn.id),
    dropTurnFromPanel: (id: string) => dropped.push(id),
    pcCommandBody: (msg: string) => ({ message: msg }),
    acPost: async () => ({ ok: answer.status < 400, status: answer.status, json: async () => answer.body }),
  };
  const names = Object.keys(stubs);
  const body = [
    "var panelSessionKey = 'task:1';",
    "var _sessionCache = { 'task:1': {} };",
    'var _pcNoteFiles = {}; var _pcFailed = {}; var _pcSending = false; var _pcInFlight = 0;',
    "var _viewerUserId = 'U1';",
    SEND,
    'return sendCommand;',
  ].join('\n');
  const sendCommand = new Function(...names, body)(...names.map((n) => stubs[n])) as (
    text: string,
    ref?: string,
    files?: unknown[],
  ) => Promise<void>;
  await sendCommand(text, opts.ref, []);
  return { toasts, appended, dropped, rows };
}

describe('#865 · a task’s goal command sent from the card', () => {
  it('the host’s answer: the optimistic turn leaves, the answer is a toast', async () => {
    const r = await send('goal clear', {
      status: 200,
      body: { ok: true, goalCommand: true, message: '🧹 Goal cleared (also cleared 1 queued goal).' },
    });
    expect(r.appended).toHaveLength(1);
    expect(r.dropped).toEqual(r.appended);
    expect(r.toasts).toEqual([
      { title: '목표', description: '🧹 Goal cleared (also cleared 1 queued goal).', tone: 'success' },
    ]);
  });

  it('an ordinary instruction keeps its optimistic turn and shows no toast', async () => {
    const r = await send('fix the build', { status: 202, body: { ok: true } });
    expect(r.appended).toHaveLength(1);
    expect(r.dropped).toEqual([]);
    expect(r.toasts).toEqual([]);
  });

  // #876 R2 (fable P1) — sent while a turn ran: the steering row made for it is not left "sending".
  it('sent while a turn runs: its steering row goes (the command applied at once), the answer is a toast', async () => {
    const r = await send(
      'goal pause',
      { status: 200, body: { ok: true, goalCommand: true, message: '⏸️ Goal paused.' } },
      { running: true, ref: 'as-1' },
    );
    expect(r.appended).toEqual([]);
    expect(r.rows).toEqual([['as-1', 'cancelled']]);
    expect(r.toasts.map((t) => t.tone)).toEqual(['success']);
  });

  it('a goal it started queued its first turn: that row is the host queue’s, left alone', async () => {
    const r = await send(
      'goal ship it',
      { status: 202, body: { ok: true, queued: true, itemId: 'tq-1', goalCommand: true, message: '🎯 Goal set' } },
      { running: true, ref: 'as-2' },
    );
    expect(r.rows).toEqual([]);
  });

  it('a refused goal command fails like any send (the error toast, the turn dropped)', async () => {
    const r = await send('goal max x', { status: 400, body: { error: '⚠️ goal max must be an integer (1–1000).' } });
    expect(r.dropped).toEqual(r.appended);
    expect(r.toasts.map((t) => t.tone)).toEqual(['error']);
  });
});
