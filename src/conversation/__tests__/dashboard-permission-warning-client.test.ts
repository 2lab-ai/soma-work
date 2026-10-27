/**
 * SSOT_2 #3 (T8.3): "이거 슬랙 메세지랑 대시보드 채팅창에도 그대로 해줘." The dashboard
 * shows the auto-mode permission WARNING with the permission request card's look
 * and nothing to answer — in the work log and filed into the panel chat at its
 * time. The shipped client functions are cut out of renderDashboardPage()'s
 * template literal and cooked exactly as the browser receives them.
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
function clientFn(name: string): string {
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientLine(prefix: string): string {
  const start = TEMPLATE.indexOf(`\n${prefix}`);
  if (start < 0) throw new Error(`client line ${prefix} not found`);
  return cook(TEMPLATE.slice(start + 1, TEMPLATE.indexOf('\n', start + 1)));
}

const FNS = ['esc', 'escAttr', 'renderPermissionWarningCard', 'permissionWarningSlot', 'renderWorkLogEntry'] as const;
interface Client {
  renderPermissionWarningCard(e: unknown): string;
  permissionWarningSlot(times: number[], ts: number, hasOlder: boolean): number | null;
  renderWorkLogEntry(e: unknown): string;
}
const client = new Function(
  'decodeSlackEntities',
  'wlChildBlock',
  `${clientLine('var WL_LABELS = ')}\n${FNS.map(clientFn).join('\n')}\nreturn { ${FNS.join(', ')} };`,
)(
  (t: string) => t,
  () => '',
) as Client;

const ENTRY = {
  seq: 7,
  ts: Date.UTC(2026, 9, 27, 3, 0, 0),
  kind: 'permission_warning',
  tool: 'Bash',
  text: 'rm -rf /tmp/scratch <img src=x onerror=alert(1)>',
  warning: {
    reason: 'owner asked to clean scratch',
    rules: [{ id: 'rm-recursive', label: 'recursive delete', description: 'rm with -r' }],
  },
};

describe('dashboard permission warning card', () => {
  const html = client.renderPermissionWarningCard(ENTRY);

  it('has the permission card look: header, command, matched rules, the model reason', () => {
    expect(html).toContain('perm-request perm-warning');
    expect(html).toContain('Permission Warning');
    expect(html).toContain('<code>Bash</code>');
    expect(html).toContain('<code>rm-recursive</code> &mdash; recursive delete: rm with -r');
    expect(html).toContain('owner asked to clean scratch');
    expect(html).toContain('응답 필요 없음');
  });

  it('asks nothing: no buttons, no approval id', () => {
    expect(html).not.toContain('<button');
    expect(html).not.toContain('data-perm-decision');
  });

  it('escapes the command', () => {
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('is the work-log row for a permission_warning entry', () => {
    const row = client.renderWorkLogEntry(ENTRY);
    expect(row).toContain('wl-entry wl-permission_warning');
    expect(row).toContain('data-seq="7"');
    expect(row).toContain('perm-warning');
  });
});

describe('permissionWarningSlot — filing a warning into the chat at its time', () => {
  it('goes before the first turn after it', () => {
    expect(client.permissionWarningSlot([10, 20, 30], 25, false)).toBe(2);
    expect(client.permissionWarningSlot([10, 20, 30], 5, false)).toBe(0);
  });
  it('goes after every turn when it is the newest (the turn still running)', () => {
    expect(client.permissionWarningSlot([10, 20], 25, false)).toBe(-1);
    expect(client.permissionWarningSlot([], 25, false)).toBe(-1);
  });
  it('waits for older pages when it is older than every loaded turn', () => {
    expect(client.permissionWarningSlot([10, 20], 5, true)).toBeNull();
    expect(client.permissionWarningSlot([10, 20], 15, true)).toBe(1);
  });
});
