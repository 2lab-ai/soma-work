/**
 * `model` (bare status) × admin force catalog refresh (T1).
 *
 * SSOT: "admin 권한으로 model을 치면 신규로 모델 카탈로그 업데이트하고 출력해줘"
 *   - Admin bare `model` → synchronous forced llmux catalog fetch (cooldown +
 *     TTL bypassed) BEFORE the card renders, so the output reflects the fresh
 *     catalog, plus a refresh-summary line.
 *   - Non-admin bare `model` → unchanged (background TTL revalidation only;
 *     no forced fetch).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAdminUsersCache } from '../../../admin-utils';
import type { LlmuxModelEntry } from '../../../auth/llmux-client';
import { modelCatalog } from '../../../model-catalog';
import { ModelHandler } from '../model-handler';
import type { CommandContext, CommandDependencies } from '../types';

const GROK: LlmuxModelEntry = {
  id: 'grok-4.5',
  aliases: ['grok'],
  name: 'Grok 4.5',
  efforts: ['low', 'medium', 'high'],
  max_context: 500_000,
  group: 'grok',
};

const ADMIN = 'UADMIN1';
const PLEB = 'UPLEB1';

let tmpDir: string;
let savedAdminUsers: string | undefined;

function makeCtx(user: string, say: ReturnType<typeof vi.fn>): CommandContext {
  return {
    user,
    channel: 'C1',
    text: 'model',
    threadTs: '1700000000.000001',
    say,
  } as unknown as CommandContext;
}

function makeHandler(): ModelHandler {
  const deps = {
    claudeHandler: { getSession: () => null },
  } as unknown as CommandDependencies;
  return new ModelHandler(deps);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-handler-admin-'));
  modelCatalog.__testReset();
  modelCatalog.setSnapshotPathForTests(path.join(tmpDir, 'model-catalog.json'));
  savedAdminUsers = process.env.ADMIN_USERS;
  process.env.ADMIN_USERS = ADMIN;
  resetAdminUsersCache();
});

afterEach(() => {
  if (savedAdminUsers === undefined) delete process.env.ADMIN_USERS;
  else process.env.ADMIN_USERS = savedAdminUsers;
  resetAdminUsersCache();
  modelCatalog.setSnapshotPathForTests(null);
  modelCatalog.__testReset();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ModelHandler bare `model` — admin force refresh (T1)', () => {
  it('admin: fetches a fresh catalog even when cooldown + TTL say fresh, and outputs it', async () => {
    // Prime: one successful fetch → fetchedAt=now (TTL fresh), lastAttemptAt=now (cooldown active).
    const primer = vi.fn(async () => []);
    await modelCatalog.refresh(primer);
    expect(primer).toHaveBeenCalledTimes(1);

    // llmux now serves grok-4.5 — only a FORCED fetch can see it.
    const fetcher = vi.fn(async () => [GROK]);
    modelCatalog.setFetcher(fetcher);

    const say = vi.fn(async (_msg: unknown) => {});
    await makeHandler().execute(makeCtx(ADMIN, say));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledTimes(1);
    // The rendered card must include the freshly fetched catalog model.
    const payload = JSON.stringify(say.mock.calls[0][0]);
    expect(payload).toContain('grok-4.5');
    // …and a refresh summary so the admin can SEE the update happened.
    expect(payload).toMatch(/카탈로그|catalog/i);
  });

  it('non-admin: does not force a fetch (existing background-only behavior)', async () => {
    const primer = vi.fn(async () => []);
    await modelCatalog.refresh(primer);

    const fetcher = vi.fn(async () => [GROK]);
    modelCatalog.setFetcher(fetcher);

    const say = vi.fn(async () => {});
    await makeHandler().execute(makeCtx(PLEB, say));

    expect(fetcher).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledTimes(1);
  });
});
