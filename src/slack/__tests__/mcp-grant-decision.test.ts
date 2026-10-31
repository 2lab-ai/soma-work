/**
 * #621 — an MCP tool access request (mcp-tool-permission → request_permission)
 * as ONE decision on two surfaces: the admins' DM buttons and the dashboard's
 * admin approvals. The real file store the MCP child waits on; the grant store
 * is observed.
 */

import { randomUUID } from 'node:crypto';
import {
  MCP_GRANT_KIND,
  PERMISSION_PROMPT_KIND,
  type PendingApproval,
  sharedStore,
} from 'somalib/permission/shared-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ admins: new Set<string>(['UADMIN1', 'UADMIN2']), setGrant: vi.fn() }));
vi.mock('../../admin-utils', () => ({
  isAdminUser: (u: string) => h.admins.has(u),
  getAdminUsers: () => h.admins,
}));
vi.mock('../../mcp-tool-grant-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../mcp-tool-grant-store')>();
  return { ...actual, mcpToolGrantStore: { setGrant: h.setGrant } };
});

import { McpToolPermissionActionHandler } from '../actions/mcp-tool-permission-action-handler';
import { clearMcpGrantResolutions, decideMcpGrant, mcpGrantAdminApprovalAdapter } from '../mcp-grant-decision';

const ids: string[] = [];

async function makeRequest(over: Partial<PendingApproval> = {}): Promise<string> {
  const id = `mcp-test-${randomUUID()}`;
  ids.push(id);
  const now = Date.now();
  await sharedStore.storePendingApproval(id, {
    kind: MCP_GRANT_KIND,
    tool_name: 'request_permission',
    input: { server: 'server-tools', level: 'write', duration: '24h', estimatedExpiry: 'tomorrow' },
    channel: 'C1',
    thread_ts: '171.1',
    user: 'U1',
    created_at: now,
    expires_at: now + 5 * 60 * 1000,
    prompts: [
      { channel: 'D1', ts: '1.1' },
      { channel: 'D2', ts: '2.2' },
    ],
    ...over,
  });
  return id;
}

async function responseOf(id: string) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const file = path.join(os.tmpdir(), 'soma-work-store', 'responses', `${id}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

describe('MCP grant requests as one decision, Slack + dashboard (#621)', () => {
  type UpdateDm = (ref: { channel: string; ts: string }, text: string) => Promise<unknown>;
  let updateDm: ReturnType<typeof vi.fn<UpdateDm>>;

  beforeEach(() => {
    h.setGrant.mockReset();
    clearMcpGrantResolutions();
    updateDm = vi.fn<UpdateDm>(async () => undefined);
  });

  afterEach(async () => {
    for (const id of ids.splice(0)) {
      await sharedStore.cleanup(id);
      await sharedStore.releasePermissionClaim(id);
    }
  });

  it('a pending request is a permission card with the DM rows; permission prompts are not listed', async () => {
    const id = await makeRequest();
    const other = await makeRequest({ kind: PERMISSION_PROMPT_KIND, tool_name: 'Bash' });
    const cards = await mcpGrantAdminApprovalAdapter(updateDm).pending(Date.now());
    const card = cards.find((c) => c.id === `mcp_grant:${id}`);
    expect(card).toMatchObject({
      kind: 'mcp_grant',
      card: 'permission',
      tool: 'mcp__server-tools',
      requesterId: 'U1',
      risk: 'medium',
      place: { channel: 'C1', threadTs: '171.1' },
      rows: { 서버: 'server-tools', 권한: '쓰기 (write)', 기간: '24h' },
    });
    expect(cards.some((c) => c.id === `mcp_grant:${other}`)).toBe(false);
  });

  it('answered on the dashboard: the stored grant, the response the child waits on, both DMs rewritten', async () => {
    const id = await makeRequest();
    const adapter = mcpGrantAdminApprovalAdapter(updateDm);
    expect(await adapter.answer(id, 'approve', 'UADMIN1')).toEqual({ ok: true, outcome: 'approved' });
    expect(h.setGrant).toHaveBeenCalledTimes(1);
    expect(h.setGrant.mock.calls[0].slice(0, 3)).toEqual(['U1', 'server-tools', 'write']);
    const response = await responseOf(id);
    expect(response).toMatchObject({ behavior: 'allow', promptsRewritten: ['1.1', '2.2'] });
    expect(response.promptText).toContain('대시보드에서 응답');
    expect(updateDm.mock.calls.map((c) => c[0].channel)).toEqual(['D1', 'D2']);
    for (const c of updateDm.mock.calls) expect(c[1]).toContain('Permission granted by <@UADMIN1>');
    expect((await adapter.resolved(0)).find((r) => r.id === `mcp_grant:${id}`)).toMatchObject({
      outcome: 'approved',
      by: 'UADMIN1',
      via: 'dashboard',
    });
  });

  it('a Slack click first: the button payload cannot change the grant, and the dashboard answer is already answered', async () => {
    const id = await makeRequest();
    const respond = vi.fn(async () => undefined);
    await new McpToolPermissionActionHandler({ updateDm }).handleApprove(
      {
        user: { id: 'UADMIN2' },
        // A tampered payload: another server, a longer duration.
        actions: [
          { value: JSON.stringify({ requestId: id, userId: 'UEVIL', server: 'evil', level: 'write', duration: '4w' }) },
        ],
      },
      respond,
    );
    expect(h.setGrant.mock.calls[0].slice(0, 3)).toEqual(['U1', 'server-tools', 'write']);
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ replace_original: true }));
    expect(updateDm).toHaveBeenCalledTimes(2);
    const adapter = mcpGrantAdminApprovalAdapter(updateDm);
    expect(await adapter.answer(id, 'deny', 'UADMIN1')).toEqual({ ok: false, reason: 'already_answered' });
    expect(h.setGrant).toHaveBeenCalledTimes(1);
    expect((await adapter.resolved(0)).find((r) => r.id === `mcp_grant:${id}`)).toMatchObject({
      via: 'slack',
      by: 'UADMIN2',
    });
  });

  it('Slack and the dashboard at the same moment: exactly one answer wins', async () => {
    const id = await makeRequest();
    const results = await Promise.all([
      decideMcpGrant({ requestId: id, decision: 'approve', actor: 'UADMIN1', via: 'dashboard', updateDm }),
      decideMcpGrant({ requestId: id, decision: 'deny', actor: 'UADMIN2', via: 'slack', updateDm }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === 'already_answered')).toHaveLength(1);
    expect(h.setGrant.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('refused: a non-admin, an unknown choice, a missing or expired request — nothing granted', async () => {
    const id = await makeRequest();
    const adapter = mcpGrantAdminApprovalAdapter(updateDm);
    expect(await adapter.answer(id, 'approve', 'U1')).toEqual({ ok: false, reason: 'forbidden' });
    expect(await adapter.answer(id, 'maybe', 'UADMIN1')).toEqual({ ok: false, reason: 'invalid' });
    expect(await adapter.answer(`mcp-test-missing-${randomUUID()}`, 'approve', 'UADMIN1')).toEqual({
      ok: false,
      reason: 'not_found',
    });
    const expired = await makeRequest({ expires_at: Date.now() - 1 });
    expect(await adapter.answer(expired, 'approve', 'UADMIN1')).toEqual({ ok: false, reason: 'not_found' });
    expect(h.setGrant).not.toHaveBeenCalled();
    expect((await adapter.pending(Date.now())).some((c) => c.id === `mcp_grant:${id}`)).toBe(true);
  });

  it('the MCP child timed out between the read and the claim: not found, nothing granted', async () => {
    const id = await makeRequest();
    const claim = sharedStore.claimPermissionResponse.bind(sharedStore);
    const spy = vi.spyOn(sharedStore, 'claimPermissionResponse').mockImplementationOnce(async (rid) => {
      await sharedStore.cleanup(rid);
      return claim(rid);
    });
    const r = await decideMcpGrant({
      requestId: id,
      decision: 'approve',
      actor: 'UADMIN1',
      via: 'dashboard',
      updateDm,
    });
    expect(r).toMatchObject({ ok: false, reason: 'not_found' });
    expect(h.setGrant).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
