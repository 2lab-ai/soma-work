/**
 * Z 2026-11-27 — "sw-webui에서 (soma-work webui) 관리자 모드 키면 입력 대기중인 다른 사람의 작업에 선택할 수 있게 해줘.
 * 그리고 권한 물어볼필요 없이 다른 사람의 세션에 직접 지시를 내릴 수 있어야함."
 *
 * The page's half, as the browser runs it: the shipped client functions are cut out of renderDashboardPage()'s template
 * literal and cooked exactly as the browser receives them. A signed-in admin with 관리자 모드 on finds every waiting card
 * of someone else's task open — the permission prompt (and its parameters, read with the mode header), the goal's cap
 * decision, someone's held instruction. With the mode off, or as anyone else, the cards stay locked as before.
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
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}

const FNS = [
  'toNum',
  'viewerAdminMode',
  'isPermissionRequester',
  'acPermissionLock',
  'acGoalDecisionLock',
  'acInstructionApprovalLock',
  'loadPermissionDetail',
] as const;

interface Viewer {
  user: string;
  admin: boolean;
  mode: boolean;
}

function load(viewer: Viewer, fetchCalls: unknown[][] = []) {
  const inject: Record<string, unknown> = {
    _viewerUserId: viewer.user,
    _viewerIsAdmin: viewer.admin,
    _isAdminModeOn: () => viewer.mode,
    isSiblingSession: () => false,
    acRepaint: () => {},
    fetch: (...args: unknown[]) => {
      fetchCalls.push(args);
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ input: '{}', truncated: false }) });
    },
  };
  const names = Object.keys(inject);
  const body = `${clientVar('AC_SIBLING')}
var _permDetails = Object.create(null);
var _permLoading = Object.create(null);
${FNS.map(clientFn).join('\n')}
return { ${FNS.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as {
    viewerAdminMode(): boolean;
    acPermissionLock(s: unknown, p: unknown): string;
    acGoalDecisionLock(s: unknown, d: unknown): string;
    acInstructionApprovalLock(s: unknown, a: unknown): string;
    loadPermissionDetail(key: string, approvalId: string): void;
  };
}

const S = { key: 'C1:t1', ownerId: 'U_OWNER' };
const PROMPT = { approvalId: 'approval_1', toolName: 'Bash', requesterId: 'U_REQ' };
const GOAL = { decisionId: 'd1', ownerId: 'U_OWNER' };
const HELD = { requestId: 'iap_1', ownerId: 'U_OWNER', requesterId: 'U_REQ' };

const ADMIN_ON: Viewer = { user: 'U_ADMIN', admin: true, mode: true };
const ADMIN_OFF: Viewer = { user: 'U_ADMIN', admin: true, mode: false };
const STRANGER_ON: Viewer = { user: 'U_X', admin: false, mode: true };
const TOKEN_ON: Viewer = { user: '', admin: true, mode: true }; // a viewer token: admin, but names nobody

describe('관리자 모드 — the waiting cards of someone else’s task (Z 2026-11-27)', () => {
  it('a signed-in admin with the mode on: the prompt, the goal decision and the held instruction are all open', () => {
    const c = load(ADMIN_ON);
    expect(c.viewerAdminMode()).toBe(true);
    expect(c.acPermissionLock(S, PROMPT)).toBe('');
    expect(c.acGoalDecisionLock(S, GOAL)).toBe('');
    expect(c.acInstructionApprovalLock(S, HELD)).toBe('');
  });

  it('the mode off: locked as before — the admin is told the mode would open the prompt', () => {
    const c = load(ADMIN_OFF);
    expect(c.viewerAdminMode()).toBe(false);
    expect(c.acPermissionLock(S, PROMPT)).toBe(
      '이 요청의 요청자만 응답할 수 있습니다 — 관리자 모드를 켜면 응답할 수 있어요',
    );
    expect(c.acGoalDecisionLock(S, GOAL)).toBe('목표 소유자만 응답할 수 있습니다');
    expect(c.acInstructionApprovalLock(S, HELD)).toContain('작업 소유자만 응답할 수 있습니다');
  });

  it('a non-admin with the mode stored, and a viewer token (names nobody), stay locked', () => {
    for (const v of [STRANGER_ON, TOKEN_ON]) {
      const c = load(v);
      expect(c.viewerAdminMode()).toBe(false);
      expect(c.acPermissionLock(S, PROMPT)).not.toBe('');
      expect(c.acGoalDecisionLock(S, GOAL)).not.toBe('');
      expect(c.acInstructionApprovalLock(S, HELD)).not.toBe('');
    }
    // A non-admin keeps the plain words (no admin hint).
    expect(load(STRANGER_ON).acPermissionLock(S, PROMPT)).toBe('이 요청의 요청자만 응답할 수 있습니다');
  });

  it('the requester and the owner answer as before, mode or not', () => {
    expect(load({ user: 'U_REQ', admin: false, mode: false }).acPermissionLock(S, PROMPT)).toBe('');
    expect(load({ user: 'U_OWNER', admin: false, mode: false }).acGoalDecisionLock(S, GOAL)).toBe('');
    expect(load({ user: 'U_OWNER', admin: false, mode: false }).acInstructionApprovalLock(S, HELD)).toBe('');
  });

  it('the prompt’s parameters are read with X-Admin-Mode: on in the mode (the fetch wrapper adds it to writes only)', () => {
    const on: unknown[][] = [];
    load(ADMIN_ON, on).loadPermissionDetail('C1:t1', 'approval_1');
    expect(on).toEqual([
      ['/api/dashboard/session/C1%3At1/permission/approval_1', { headers: { 'X-Admin-Mode': 'on' } }],
    ]);
    const requester: unknown[][] = [];
    load({ user: 'U_REQ', admin: false, mode: false }, requester).loadPermissionDetail('C1:t1', 'approval_1');
    expect(requester).toEqual([['/api/dashboard/session/C1%3At1/permission/approval_1']]);
  });

  it('flipping 관리자 모드 repaints the panel’s 입력 필요 cards (their locks follow the mode)', () => {
    const toggle = clientFn('toggleAdminMode');
    expect(toggle).toContain('repaintViewerControls();');
    const repaint = clientFn('repaintViewerControls');
    expect(repaint).toContain('renderPanelQuestion(s);');
    expect(repaint).toContain('renderPanelPermission(s);');
  });
});
