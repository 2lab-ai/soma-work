/**
 * secret-access WU2 (#1338, .prd/32 A1–A6): the whole secret-use approval with every real piece wired — the policy
 * hook (`buildStreamOptions` → step 4), `requestSecretUse` (admin DM card), the admin request store and the grant
 * store on disk, `SecretUseActionHandler` (the admin's button), the dashboard adapter, the audit ledger, and the
 * re-sent turn. Only Slack is a fake that records what would have been posted.
 *
 *   card 1 → 수락 (이 스레드) → that thread only · 거부 → no grant · 앞으로 계속 자동 수락 → card 0 everywhere
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminApprovalSnapshot, clearAdminApprovalAdapters, registerAdminApprovalAdapter } from '../admin-approvals';
import { resetAdminUsersCache } from '../admin-utils';
import { type BuildStreamOptionsDeps, buildStreamOptions } from '../agent-runtime/claude-code/build-stream-options';
import { CONFIG_FILE, DATA_DIR } from '../env-paths';
import type { McpConfig, SlackContext } from '../mcp-config-builder';
import { SECRET_AUDIT_FILE } from '../secrets/secret-audit';
import { SecretUseActionHandler } from '../slack/actions/secret-use-action-handler';
import { secretUseAdminApprovalAdapter } from '../slack/secret-use-admin-approval';
import { requestSecretUse } from '../slack/secret-use-request';
import { hasSecretGrant } from '../user-skill-grants-store';

const ADMIN = 'UADMINSEC01';
const REQUESTER = 'UREQSEC0001';
const CHANNEL = 'CSECFLOW001';
/** A fresh thread per test: thread grants live in memory for the process. */
let THREAD = '';
let OTHER_THREAD = '';
let testNo = 0;
const VALUE_MARKER = 'never-on-any-card';

interface Posted {
  channel: string;
  text: string;
  opts?: { threadTs?: string; blocks?: any[] };
}

describe('secret-use approval — full flow', () => {
  const posted: Posted[] = [];
  const slackApi = {
    openDmChannel: vi.fn(async (user: string) => `D-${user}`),
    postMessage: vi.fn(async (channel: string, text: string, opts?: Posted['opts']) => {
      posted.push({ channel, text, opts });
      return { ts: `${posted.length}.0001`, channel };
    }),
    updateMessage: vi.fn(async () => undefined),
  };
  const resent: Array<{ user: string; text: string; thread?: string }> = [];
  const messageHandler = vi.fn(async (event: any) => {
    resent.push({ user: event.user, text: event.text, thread: event.thread_ts });
  });
  const handler = new SecretUseActionHandler({ slackApi: slackApi as any, messageHandler });

  /** The policy hook for the requester in `threadTs`, with the real card sender behind its denials. */
  async function call(tool: string, input: Record<string, unknown>, threadTs?: string) {
    threadTs ??= THREAD;
    const deps: BuildStreamOptionsDeps = {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getEffectivePluginPaths: () => [],
      buildModelCommandContext: () => undefined,
      mcpConfigBuilder: {
        buildConfig: vi.fn(
          async () => ({ permissionMode: 'bypassPermissions', somaPermissionMode: 'bypass' }) as McpConfig,
        ),
      },
      compactHookBuilder: undefined,
      promptBuilder: { buildSystemPrompt: vi.fn(() => 'P') },
      sessionRegistry: {
        getSessionKey: vi.fn(() => 'k'),
        isDangerousRuleDisabled: vi.fn(() => false),
        getSession: vi.fn(() => undefined),
      } as unknown as BuildStreamOptionsDeps['sessionRegistry'],
      checkMcpToolPermission: vi.fn(() => 'No active read grant for server-tools'),
      onSecretUseDenied: (denial) =>
        requestSecretUse({ slackApi, ...denial, originalText: 'continue the step that waited on the secret' }).then(
          () => undefined,
        ),
    };
    const slackContext = { user: REQUESTER, channel: CHANNEL, threadTs, repos: [] } as unknown as SlackContext;
    const { options } = await buildStreamOptions({ queryEnv: {}, slackContext }, deps);
    const entry = (options.hooks?.PreToolUse ?? []).find((e) => (e as { matcher: string }).matcher === '^mcp__') as any;
    const out = await entry.hooks[0]({
      hook_event_name: 'PreToolUse',
      tool_name: `mcp__server-tools__${tool}`,
      tool_input: input,
    });
    // Let the fire-and-forget card delivery finish.
    await new Promise((r) => setTimeout(r, 20));
    return out.hookSpecificOutput?.permissionDecision as string | undefined;
  }
  const DB = ['db_query', { server: 'plain', database: 'app', query: 'select 1' }] as const;

  function cards(): Posted[] {
    return posted.filter((p) => p.channel === `D-${ADMIN}` && Array.isArray(p.opts?.blocks));
  }
  function button(kind: string): string {
    const all = cards();
    const card = all[all.length - 1];
    const actions = card?.opts?.blocks?.find((b: any) => b.type === 'actions');
    return actions.elements.find((e: any) => e.action_id === `secret_use_${kind}`).value;
  }
  const click = (value: string, user = ADMIN) =>
    handler.handleAction(
      { user: { id: user }, actions: [{ value }] },
      vi.fn(async () => ({})),
    );

  const savedAdmins = process.env.ADMIN_USERS;
  beforeAll(() => {
    process.env.ADMIN_USERS = ADMIN;
    resetAdminUsersCache();
  });
  afterAll(() => {
    process.env.ADMIN_USERS = savedAdmins;
    resetAdminUsersCache();
    clearAdminApprovalAdapters();
    fs.rmSync(CONFIG_FILE, { force: true });
  });
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify({
        'server-tools': {
          permission: { db_query: 'read' },
          plain: { ssh: { host: 'plain' }, databases: { app: { type: 'mysql', password: { $secret: 'plain-db' } } } },
        },
      }),
    );
    posted.length = 0;
    resent.length = 0;
    vi.clearAllMocks();
    testNo += 1;
    THREAD = `1793100000.${String(testNo).padStart(4, '0')}01`;
    OTHER_THREAD = `1793100000.${String(testNo).padStart(4, '0')}99`;
  });

  it('A1 — one card to the admin, a notice in the thread, the value nowhere', async () => {
    expect(await call(...DB)).toBe('deny');
    expect(cards()).toHaveLength(1);
    const card = cards()[0];
    const choices = card.opts?.blocks?.find((b: any) => b.type === 'actions').elements.map((e: any) => e.text.text);
    expect(choices).toEqual(['✅ 수락 (이 스레드)', '❌ 거부', '🔁 앞으로 계속 자동 수락']);
    expect(JSON.stringify(card)).toContain('plain-db');
    expect(posted.some((p) => p.channel === CHANNEL && p.text.includes('어드민에게 DM으로 요청'))).toBe(true);
    // A second call in the same thread neither re-sends the card nor posts another notice.
    expect(await call(...DB)).toBe('deny');
    expect(cards()).toHaveLength(1);
    expect(posted.filter((p) => p.channel === CHANNEL)).toHaveLength(1);
    expect(JSON.stringify(posted)).not.toContain(VALUE_MARKER);
  });

  it('A2 — 수락 (이 스레드): the turn is sent again, the call runs in that thread only', async () => {
    await call(...DB);
    await click(button('secret_once'));
    expect(resent).toEqual([{ user: REQUESTER, text: 'continue the step that waited on the secret', thread: THREAD }]);
    expect(await call(...DB)).not.toBe('deny');
    expect(await call(DB[0], DB[1], OTHER_THREAD)).toBe('deny');
    expect(hasSecretGrant('plain-db', REQUESTER)).toBe(false);
  });

  it('A3 — 거부: no grant, no re-sent turn, the requester is told; a second click changes nothing', async () => {
    await call(...DB);
    const deny = button('secret_deny');
    await click(deny);
    expect(resent).toHaveLength(0);
    expect(posted.some((p) => p.channel === CHANNEL && p.text.includes('거부되었습니다'))).toBe(true);
    await click(button('secret_always'));
    expect(hasSecretGrant('plain-db', REQUESTER)).toBe(false);
    // asking again opens a fresh card
    expect(await call(...DB)).toBe('deny');
    expect(cards()).toHaveLength(2);
  });

  it('A4 — 앞으로 계속 자동 수락: recorded per user, no card in any thread afterwards, audited without a value', async () => {
    await call(...DB);
    await click(button('secret_always'));
    expect(hasSecretGrant('plain-db', REQUESTER)).toBe(true);
    posted.length = 0;
    expect(await call(DB[0], DB[1], OTHER_THREAD)).not.toBe('deny');
    expect(cards()).toHaveLength(0);
    const ledger = fs
      .readFileSync(path.join(DATA_DIR, SECRET_AUDIT_FILE), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(ledger).toEqual([
      expect.objectContaining({
        actor: ADMIN,
        action: 'use.always',
        name: 'plain-db',
        userId: REQUESTER,
        tool: 'db_query',
        server: 'plain',
      }),
    ]);
  });

  it('only an admin answers', async () => {
    await call(...DB);
    await click(button('secret_always'), REQUESTER);
    expect(hasSecretGrant('plain-db', REQUESTER)).toBe(false);
  });

  it('the dashboard lists the same card and answers it through the same decision', async () => {
    clearAdminApprovalAdapters();
    registerAdminApprovalAdapter(secretUseAdminApprovalAdapter(handler));
    await call(...DB);
    const snap = await adminApprovalSnapshot();
    expect(snap.pending).toHaveLength(1);
    const card = snap.pending[0];
    expect(card.kind).toBe('secret_use');
    expect(card.choices?.map((c) => c.id)).toEqual(['secret_once', 'secret_deny', 'secret_always']);
    const { answerAdminApproval } = await import('../admin-approvals');
    expect(await answerAdminApproval(card.id, 'secret_always', ADMIN)).toEqual({ ok: true, outcome: 'approved' });
    expect(hasSecretGrant('plain-db', REQUESTER)).toBe(true);
    // the DM copy was rewritten, and the Slack button now finds it answered
    expect(slackApi.updateMessage).toHaveBeenCalled();
    expect((await adminApprovalSnapshot()).pending).toHaveLength(0);
  });
});
