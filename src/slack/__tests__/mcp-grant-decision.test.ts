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

const h = vi.hoisted(() => ({
  admins: new Set<string>(['UADMIN1', 'UADMIN2']),
  setGrant: vi.fn((): unknown => ({ replaced: null, written: { grantedAt: 'g', expiresAt: 'e', grantedBy: 'x' } })),
  restoreGrant: vi.fn(),
}));
vi.mock('../../admin-utils', () => ({
  isAdminUser: (u: string) => h.admins.has(u),
  getAdminUsers: () => h.admins,
}));
vi.mock('../../mcp-tool-grant-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../mcp-tool-grant-store')>();
  return { ...actual, mcpToolGrantStore: { setGrant: h.setGrant, restoreGrant: h.restoreGrant } };
});

import { DATA_DIR } from '../../env-paths';
import { McpToolPermissionActionHandler } from '../actions/mcp-tool-permission-action-handler';
import { clearMcpGrantResolutions, decideMcpGrant, mcpGrantAdminApprovalAdapter } from '../mcp-grant-decision';

const ids: string[] = [];

async function makeRequest(over: Partial<PendingApproval> = {}): Promise<string> {
  const id = `mcp-test-${randomUUID()}`;
  ids.push(id);
  const now = Date.now();
  await sharedStore.storePendingApproval(id, {
    kind: MCP_GRANT_KIND,
    owner: DATA_DIR,
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
    h.setGrant.mockImplementation(() => ({
      replaced: null,
      written: { grantedAt: 'g', expiresAt: 'e', grantedBy: 'x' },
    }));
    h.restoreGrant.mockReset();
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
    expect(response).toMatchObject({ behavior: 'allow' });
    // Answered: off the pending list even before the child reads the response and cleans up.
    expect((await adapter.pending(Date.now())).some((c) => c.id === `mcp_grant:${id}`)).toBe(false);
    expect(response.promptText).toContain('대시보드에서 응답');
    expect(updateDm.mock.calls.map((c) => c[0].channel)).toEqual(['D1', 'D2']);
    for (const c of updateDm.mock.calls) expect(c[1]).toContain('Permission granted by <@UADMIN1>');
    expect((await adapter.resolved(0)).find((r) => r.id === `mcp_grant:${id}`)).toMatchObject({
      outcome: 'approved',
      by: 'UADMIN1',
      via: 'dashboard',
    });
  });

  it('another instance on the host (shared temp store): its requests are neither listed nor answerable here', async () => {
    const foreign = await makeRequest({ owner: '/opt/soma-work/prod/data' });
    const unstamped = await makeRequest({ owner: undefined });
    const adapter = mcpGrantAdminApprovalAdapter(updateDm);
    const listed = (await adapter.pending(Date.now())).map((c) => c.id);
    expect(listed).not.toContain(`mcp_grant:${foreign}`);
    expect(listed).not.toContain(`mcp_grant:${unstamped}`);
    expect(await adapter.answer(foreign, 'approve', 'UADMIN1')).toEqual({ ok: false, reason: 'not_found' });
    expect(await adapter.answer(unstamped, 'approve', 'UADMIN1')).toEqual({ ok: false, reason: 'not_found' });
    expect(h.setGrant).not.toHaveBeenCalled();
    // A Slack click reaches only the instance that posted it: a record from a child older than the stamp still works.
    expect(
      await decideMcpGrant({ requestId: unstamped, decision: 'deny', actor: 'UADMIN1', via: 'slack', updateDm }),
    ).toMatchObject({ ok: true, outcome: 'denied' });
    expect(
      await decideMcpGrant({ requestId: foreign, decision: 'deny', actor: 'UADMIN1', via: 'slack', updateDm }),
    ).toMatchObject({ ok: false, reason: 'not_found' });
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
    const winner = results.find((r) => r.ok) as { ok: true; outcome: string };
    expect(h.setGrant).toHaveBeenCalledTimes(winner.outcome === 'approved' ? 1 : 0);
    expect((await responseOf(id)).behavior).toBe(winner.outcome === 'approved' ? 'allow' : 'deny');
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

  it('the grant cannot be written: no answer reaches the child, the claim goes back', async () => {
    const id = await makeRequest();
    h.setGrant.mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    await expect(
      decideMcpGrant({ requestId: id, decision: 'approve', actor: 'UADMIN1', via: 'dashboard', updateDm }),
    ).rejects.toThrow('ENOSPC');
    expect(await responseOf(id)).toBeNull();
    expect(updateDm).not.toHaveBeenCalled();
    expect(
      await decideMcpGrant({ requestId: id, decision: 'deny', actor: 'UADMIN2', via: 'slack', updateDm }),
    ).toMatchObject({ ok: true, outcome: 'denied' });
  });

  it('the answer cannot be written: the grant is taken back (the earlier one restored), the claim goes back', async () => {
    const id = await makeRequest();
    const change = {
      replaced: { grantedAt: 'g0', expiresAt: 'e0', grantedBy: 'UOLD' },
      written: { grantedAt: 'g1', expiresAt: 'e1', grantedBy: 'UADMIN1' },
    };
    h.setGrant.mockImplementationOnce(() => change);
    const spy = vi.spyOn(sharedStore, 'storePermissionResponse').mockRejectedValueOnce(new Error('EACCES'));
    await expect(
      decideMcpGrant({ requestId: id, decision: 'approve', actor: 'UADMIN1', via: 'dashboard', updateDm }),
    ).rejects.toThrow('EACCES');
    expect(h.restoreGrant).toHaveBeenCalledWith('U1', 'server-tools', 'write', change);
    spy.mockRestore();
    expect(
      await decideMcpGrant({ requestId: id, decision: 'deny', actor: 'UADMIN2', via: 'slack', updateDm }),
    ).toMatchObject({ ok: true, outcome: 'denied' });
  });

  it('the answer cannot be written and the grant cannot be taken back: the claim is kept (no contradicting answer)', async () => {
    const id = await makeRequest();
    h.restoreGrant.mockImplementationOnce(() => {
      throw new Error('locked');
    });
    const spy = vi.spyOn(sharedStore, 'storePermissionResponse').mockRejectedValueOnce(new Error('EACCES'));
    await expect(
      decideMcpGrant({ requestId: id, decision: 'approve', actor: 'UADMIN1', via: 'dashboard', updateDm }),
    ).rejects.toThrow('EACCES');
    spy.mockRestore();
    expect(
      await decideMcpGrant({ requestId: id, decision: 'deny', actor: 'UADMIN2', via: 'slack', updateDm }),
    ).toMatchObject({ ok: false, reason: 'already_answered' });
  });

  it('two answers for the same grant, both undeliverable: neither leaves a grant behind (#621)', async () => {
    // The real grant store this time: the order of write → answer → rollback is what matters.
    const actual = await vi.importActual<typeof import('../../mcp-tool-grant-store')>('../../mcp-tool-grant-store');
    const real = new actual.McpToolGrantStore(DATA_DIR);
    h.setGrant.mockImplementation((...a: any[]) => (real.setGrant as any)(...a));
    h.restoreGrant.mockImplementation((...a: any[]) => (real.restoreGrant as any)(...a));
    const a = await makeRequest();
    const b = await makeRequest();
    const spy = vi.spyOn(sharedStore, 'storePermissionResponse').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      throw new Error('responses dir unavailable');
    });
    const results = await Promise.allSettled([
      decideMcpGrant({ requestId: a, decision: 'approve', actor: 'UADMIN1', via: 'dashboard', updateDm }),
      decideMcpGrant({ requestId: b, decision: 'approve', actor: 'UADMIN2', via: 'slack', updateDm }),
    ]);
    spy.mockRestore();
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(new actual.McpToolGrantStore(DATA_DIR).hasActiveGrant('U1', 'server-tools', 'write')).toBe(false);
    // Both are answerable again; a denial now leaves no grant either.
    for (const id of [a, b]) {
      expect(
        await decideMcpGrant({ requestId: id, decision: 'deny', actor: 'UADMIN1', via: 'slack', updateDm }),
      ).toMatchObject({
        ok: true,
      });
    }
    expect(new actual.McpToolGrantStore(DATA_DIR).hasActiveGrant('U1', 'server-tools', 'write')).toBe(false);
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
    // The claim is given back: nothing else can answer it, and a retry reads "expired", not "already handled".
    expect(await sharedStore.claimPermissionResponse(id)).toBe(true);
    spy.mockRestore();
  });
});
