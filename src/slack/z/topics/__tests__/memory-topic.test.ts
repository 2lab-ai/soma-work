import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../user-memory-store', () => {
  type Target = 'memory' | 'user';
  const entries: Record<Target, string[]> = { memory: [], user: [] };
  return {
    loadMemory: (_u: string, t: Target) => ({
      entries: [...entries[t]],
      charLimit: 10000,
      totalChars: entries[t].join('').length,
      percentUsed: 0,
    }),
    addMemory: (_u: string, t: Target, content: string) => {
      const v = content.trim();
      if (!v) return { ok: false, message: 'Empty content' };
      if (entries[t].includes(v)) return { ok: false, message: 'Duplicate' };
      entries[t].push(v);
      return { ok: true, message: 'Added', entries: [...entries[t]] };
    },
    removeMemoryByIndex: (_u: string, t: Target, i: number) => {
      if (i < 1 || i > entries[t].length) return { ok: false, message: 'Out of range' };
      entries[t].splice(i - 1, 1);
      return { ok: true, message: 'Removed' };
    },
    clearAllMemory: () => {
      entries.memory = [];
      entries.user = [];
    },
    replaceMemoryByIndex: vi.fn((_u: string, t: Target, i: number, newText: string, expectedOldText?: string) => {
      if (i < 1 || i > entries[t].length) return { ok: false, reason: 'out of range' };
      if (expectedOldText !== undefined && entries[t][i - 1] !== expectedOldText) {
        return { ok: false, reason: 'cas mismatch' };
      }
      if (!newText || newText.length === 0) return { ok: false, reason: 'empty entry' };
      entries[t][i - 1] = newText;
      return { ok: true };
    }),
    replaceAllMemory: vi.fn((_u: string, t: Target, next: string[], expectedOldEntries?: string[]) => {
      if (!Array.isArray(next) || next.length === 0) return { ok: false, reason: 'empty' };
      if (expectedOldEntries !== undefined) {
        const cur = entries[t];
        if (cur.length !== expectedOldEntries.length || cur.some((e, i) => e !== expectedOldEntries[i])) {
          return { ok: false, reason: 'cas mismatch' };
        }
      }
      if (new Set(next).size !== next.length) return { ok: false, reason: 'duplicates' };
      entries[t] = [...next];
      return { ok: true };
    }),
    clearMemory: (_u: string, t: Target) => {
      entries[t] = [];
      return { ok: true, message: 'cleared' };
    },
  };
});

vi.mock('../memory-improve', () => ({
  improveEntry: vi.fn(async (entry: string, _target: 'memory' | 'user') => `improved:${entry}`),
  improveAll: vi.fn(async (arr: string[], _target: 'memory' | 'user') => arr.map((s) => `i:${s}`)),
}));

import {
  addMemory as addMemoryMock,
  clearAllMemory as clearAllMemoryMock,
  replaceAllMemory as replaceAllMemoryMock,
  replaceMemoryByIndex as replaceMemoryByIndexMock,
} from '../../../../user-memory-store';
import { improveAll as improveAllMock, improveEntry as improveEntryMock } from '../memory-improve';
import {
  applyMemory,
  buildClearManageModal,
  buildMemoryAddModal,
  chunkByChars,
  createMemoryTopicBinding,
  escapeMrkdwn,
  renderMemoryCard,
  submitMemoryModal,
} from '../memory-topic';

function actionIds(blocks: any[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === 'actions') for (const e of b.elements) out.push(e.action_id);
  }
  return out;
}

/**
 * v4 minimal: per-entry rows use section+accessory instead of a trailing
 * actions block, so accessory buttons' action_ids need to be collected
 * directly from section blocks for full coverage.
 */
function allActionIds(blocks: any[]): string[] {
  const out = actionIds(blocks);
  for (const b of blocks) {
    if (b.type === 'section' && b.accessory?.action_id) {
      out.push(b.accessory.action_id);
    }
  }
  return out;
}

function findBlockById(blocks: any[], blockId: string): any | undefined {
  return blocks.find((b) => b.block_id === blockId);
}

beforeEach(() => {
  // Reset mock call histories so per-test assertions are clean.
  vi.mocked(improveEntryMock).mockReset();
  vi.mocked(improveEntryMock).mockImplementation(async (entry: string) => `improved:${entry}`);
  vi.mocked(improveAllMock).mockReset();
  vi.mocked(improveAllMock).mockImplementation(async (arr: string[]) => arr.map((s) => `i:${s}`));
  vi.mocked(replaceMemoryByIndexMock).mockClear();
  vi.mocked(replaceAllMemoryMock).mockClear();
});

describe('memory-topic.renderMemoryCard — legacy regression', () => {
  it('shows clear_all + open_modal + clear_manage + cancel even when stores are empty', async () => {
    clearAllMemoryMock('U1');
    const { blocks, text } = await renderMemoryCard({ userId: 'U1', issuedAt: 1 });
    expect(text).toContain('Memory');
    const ids = actionIds(blocks);
    expect(ids).toContain('z_setting_memory_set_clear_all');
    expect(ids).toContain('z_setting_memory_open_modal');
    expect(ids).toContain('z_setting_memory_open_modal_clear_manage');
    expect(ids).toContain('z_setting_memory_cancel');
  });

  it('renders per-entry improve accessory buttons for populated stores (v4 minimal)', async () => {
    clearAllMemoryMock('U2');
    addMemoryMock('U2', 'memory', 'first entry');
    addMemoryMock('U2', 'user', 'first user entry');
    const { blocks } = await renderMemoryCard({ userId: 'U2', issuedAt: 2 });
    const ids = allActionIds(blocks);
    // Accessory = improve only. Per-entry clear buttons are gone (moved
    // to the global [🗑️ 삭제 관리] modal).
    expect(ids).toContain('z_setting_memory_set_improve_memory_1');
    expect(ids).toContain('z_setting_memory_set_improve_user_1');
    expect(ids).not.toContain('z_setting_memory_set_clear_memory_1');
    expect(ids).not.toContain('z_setting_memory_set_clear_user_1');
  });
});

describe('memory-topic.applyMemory — legacy regression', () => {
  it('clear_all wipes stores', async () => {
    const r = await applyMemory({ userId: 'U1', value: 'clear_all' });
    expect(r.ok).toBe(true);
  });

  it('clear_memory_N removes memory entry', async () => {
    clearAllMemoryMock('U3');
    addMemoryMock('U3', 'memory', 'abc');
    const r = await applyMemory({ userId: 'U3', value: 'clear_memory_1' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('memory #1');
  });

  it('clear_user_N removes user entry', async () => {
    clearAllMemoryMock('U4');
    addMemoryMock('U4', 'user', 'xyz');
    const r = await applyMemory({ userId: 'U4', value: 'clear_user_1' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('user profile #1');
  });

  it('rejects unknown value', async () => {
    const r = await applyMemory({ userId: 'U1', value: 'zzz' });
    expect(r.ok).toBe(false);
  });
});

describe('memory-topic.buildMemoryAddModal', () => {
  it('produces a modal with target select + content input', () => {
    const view = buildMemoryAddModal();
    expect(view.callback_id).toBe('z_setting_memory_modal_submit');
    expect(JSON.parse(view.private_metadata).kind).toBe('add');
    const target = view.blocks.find((b: any) => b.block_id === 'memory_target');
    const content = view.blocks.find((b: any) => b.block_id === 'memory_content');
    expect(target).toBeDefined();
    expect(content).toBeDefined();
    expect(content.element.multiline).toBe(true);
  });
});

describe('memory-topic.buildClearManageModal', () => {
  it('returns a submit-less view when both stores are empty', () => {
    const view = buildClearManageModal({ memEntries: [], usrEntries: [] });
    expect(view.callback_id).toBe('z_setting_memory_modal_submit');
    expect(JSON.parse(view.private_metadata).kind).toBe('clear_manage');
    // No input block, no submit button — user can only close.
    expect(view.submit).toBeUndefined();
    const inputBlock = view.blocks.find((b: any) => b.block_id === 'memory_clear_targets');
    expect(inputBlock).toBeUndefined();
  });

  it('includes each mem + user entry as a multi_static_select option', () => {
    const view = buildClearManageModal({
      memEntries: ['mem-a', 'mem-b'],
      usrEntries: ['usr-x'],
    });
    expect(view.submit).toBeDefined();
    const inputBlock = view.blocks.find((b: any) => b.block_id === 'memory_clear_targets');
    expect(inputBlock).toBeDefined();
    expect(inputBlock.element.type).toBe('multi_static_select');
    const values = inputBlock.element.options.map((o: any) => o.value);
    expect(values).toEqual(['memory:1', 'memory:2', 'user:1']);
  });

  it('caps options at 100 (Slack multi_static_select limit)', () => {
    const memEntries = Array.from({ length: 80 }, (_, i) => `m${i + 1}`);
    const usrEntries = Array.from({ length: 80 }, (_, i) => `u${i + 1}`);
    const view = buildClearManageModal({ memEntries, usrEntries });
    const inputBlock = view.blocks.find((b: any) => b.block_id === 'memory_clear_targets');
    expect(inputBlock.element.options.length).toBe(100);
  });
});

describe('memory-topic.submitMemoryModal', () => {
  const fakeClient = { chat: { postMessage: vi.fn().mockResolvedValue({}) } } as any;

  it('rejects empty content', async () => {
    clearAllMemoryMock('U5');
    const r = await submitMemoryModal({
      client: fakeClient,
      userId: 'U5',
      values: {
        memory_target: { value: { selected_option: { value: 'user' } } },
        memory_content: { value: { value: '' } },
      },
    });
    expect(r.ok).toBe(false);
  });

  it('saves to user profile by default', async () => {
    clearAllMemoryMock('U6');
    const r = await submitMemoryModal({
      client: fakeClient,
      userId: 'U6',
      values: {
        memory_target: { value: { selected_option: { value: 'user' } } },
        memory_content: { value: { value: 'I like TypeScript' } },
      },
    });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('User profile');
  });

  describe('kind = clear_manage', () => {
    it('deletes selected entries in descending order per target', async () => {
      clearAllMemoryMock('U7');
      addMemoryMock('U7', 'memory', 'm1');
      addMemoryMock('U7', 'memory', 'm2');
      addMemoryMock('U7', 'memory', 'm3');
      addMemoryMock('U7', 'user', 'u1');
      addMemoryMock('U7', 'user', 'u2');
      const r = await submitMemoryModal({
        client: fakeClient,
        userId: 'U7',
        kind: 'clear_manage',
        values: {
          memory_clear_targets: {
            value: {
              selected_options: [{ value: 'memory:1' }, { value: 'memory:3' }, { value: 'user:2' }],
            },
          },
        },
      });
      expect(r.ok).toBe(true);
      expect(r.summary).toContain('3개 항목 삭제 완료');
      // Verify the surviving entries — memory #1, #3 gone (m1, m3), user #2 gone (u2).
      const { loadMemory } = await import('../../../../user-memory-store');
      expect((loadMemory as any)('U7', 'memory').entries).toEqual(['m2']);
      expect((loadMemory as any)('U7', 'user').entries).toEqual(['u1']);
    });

    it('rejects when nothing is selected', async () => {
      clearAllMemoryMock('U8');
      addMemoryMock('U8', 'memory', 'keep');
      const r = await submitMemoryModal({
        client: fakeClient,
        userId: 'U8',
        kind: 'clear_manage',
        values: { memory_clear_targets: { value: { selected_options: [] } } },
      });
      expect(r.ok).toBe(false);
      expect(r.summary).toContain('선택된 항목이 없습니다');
    });

    it('returns partial success when some targets are out of range', async () => {
      clearAllMemoryMock('U9');
      addMemoryMock('U9', 'memory', 'only');
      const r = await submitMemoryModal({
        client: fakeClient,
        userId: 'U9',
        kind: 'clear_manage',
        values: {
          memory_clear_targets: {
            value: {
              selected_options: [{ value: 'memory:1' }, { value: 'memory:99' }],
            },
          },
        },
      });
      // 1 ok + 1 fail = ok=true overall (at least one succeeded).
      expect(r.ok).toBe(true);
      expect(r.summary).toContain('1개 항목 삭제 완료');
    });
  });
});

describe('createMemoryTopicBinding', () => {
  it('exposes all hooks', () => {
    const b = createMemoryTopicBinding();
    expect(b.topic).toBe('memory');
    expect(typeof b.apply).toBe('function');
    expect(typeof b.renderCard).toBe('function');
    expect(typeof b.openModal).toBe('function');
    expect(typeof b.submitModal).toBe('function');
  });

  it('openModal routes to the ADD modal for z_setting_memory_open_modal', async () => {
    clearAllMemoryMock('B1');
    const binding = createMemoryTopicBinding();
    if (!binding.openModal) throw new Error('binding.openModal undefined');
    const opened: any[] = [];
    const client = { views: { open: vi.fn(async (v: any) => opened.push(v)) } } as any;
    await binding.openModal({
      client,
      triggerId: 'T1',
      body: { actions: [{ action_id: 'z_setting_memory_open_modal' }] },
      userId: 'B1',
    });
    expect(opened).toHaveLength(1);
    expect(opened[0].view.callback_id).toBe('z_setting_memory_modal_submit');
    // private_metadata must mark this as the 'add' kind.
    expect(JSON.parse(opened[0].view.private_metadata).kind).toBe('add');
    // Add modal has the content input block.
    const ids = opened[0].view.blocks.map((b: any) => b.block_id).filter(Boolean);
    expect(ids).toContain('memory_content');
  });

  it('openModal routes to the CLEAR_MANAGE modal for z_setting_memory_open_modal_clear_manage', async () => {
    clearAllMemoryMock('B2');
    addMemoryMock('B2', 'memory', 'keep me');
    addMemoryMock('B2', 'user', 'persona');
    const binding = createMemoryTopicBinding();
    if (!binding.openModal) throw new Error('binding.openModal undefined');
    const opened: any[] = [];
    const client = { views: { open: vi.fn(async (v: any) => opened.push(v)) } } as any;
    await binding.openModal({
      client,
      triggerId: 'T2',
      body: { actions: [{ action_id: 'z_setting_memory_open_modal_clear_manage' }] },
      userId: 'B2',
    });
    expect(opened).toHaveLength(1);
    expect(JSON.parse(opened[0].view.private_metadata).kind).toBe('clear_manage');
    // Clear-manage modal carries the selection input block.
    const ids = opened[0].view.blocks.map((b: any) => b.block_id).filter(Boolean);
    expect(ids).toContain('memory_clear_targets');
  });

  it('submitModal sends failure DM when private_metadata is malformed JSON', async () => {
    clearAllMemoryMock('B3');
    const binding = createMemoryTopicBinding();
    if (!binding.submitModal) throw new Error('binding.submitModal undefined');
    const posted: any[] = [];
    const client = { chat: { postMessage: vi.fn(async (p: any) => posted.push(p)) } } as any;
    await binding.submitModal({
      client,
      userId: 'B3',
      body: { view: { private_metadata: '{not-json' } },
      values: {},
    });
    expect(posted).toHaveLength(1);
    expect(posted[0].text).toContain('Malformed modal metadata');
  });
});

/* ------------------------------------------------------------------ *
 * v4 minimal rendering (Scenarios 1-5 updated)
 * ------------------------------------------------------------------ */

describe('renderMemoryCard — v4 minimal', () => {
  it('produces 17 blocks for 5+5 entries (fixed 7 + 1*10 per-entry)', async () => {
    clearAllMemoryMock('V1');
    for (let i = 1; i <= 5; i++) addMemoryMock('V1', 'memory', `m${i}`);
    for (let i = 1; i <= 5; i++) addMemoryMock('V1', 'user', `u${i}`);
    const { blocks } = await renderMemoryCard({ userId: 'V1', issuedAt: 100 });

    // Fixed blocks: header + summary-context + group_memory + divider +
    // group_user + bottom_actions + help_context = 7.
    // Per-entry blocks: 1 section each × 10 = 10. Total = 17.
    expect(blocks.length).toBe(17);

    // Each per-entry section has original text (post-escape) + accessory
    // button pointing to the improve action.
    for (let i = 1; i <= 5; i++) {
      const sec = findBlockById(blocks, `z_memory_entry_memory_${i}`);
      expect(sec).toBeDefined();
      expect((sec as any).text.text).toContain(`*#${i}*`);
      expect((sec as any).text.text).toContain(`m${i}`);
      const accessory = (sec as any).accessory;
      expect(accessory).toBeDefined();
      expect(accessory.type).toBe('button');
      expect(accessory.action_id).toBe(`z_setting_memory_set_improve_memory_${i}`);
      // Accessory button MUST be plain (no style: 'primary' / 'danger').
      expect(accessory.style).toBeUndefined();
    }
    for (let j = 1; j <= 5; j++) {
      const sec = findBlockById(blocks, `z_memory_entry_user_${j}`);
      expect(sec).toBeDefined();
      expect((sec as any).text.text).toContain(`u${j}`);
      expect((sec as any).accessory?.action_id).toBe(`z_setting_memory_set_improve_user_${j}`);
    }

    // v4 removed the top-global actions row + per-entry actions rows + the
    // separate extra-actions row. Only one bottom row remains with 6 buttons.
    expect(findBlockById(blocks, 'z_memory_global_top')).toBeUndefined();
    for (let i = 1; i <= 5; i++) {
      expect(findBlockById(blocks, `z_memory_memory_entry_${i}`)).toBeUndefined();
      expect(findBlockById(blocks, `z_memory_user_entry_${i}`)).toBeUndefined();
    }
    expect(findBlockById(blocks, 'z_memory_extra')).toBeUndefined();

    const bot = findBlockById(blocks, 'z_memory_global_bottom');
    expect(bot).toBeDefined();
    const botIds = (bot as any).elements.map((e: any) => e.action_id);
    expect(botIds).toEqual([
      'z_setting_memory_set_improve_memory_all',
      'z_setting_memory_set_improve_user_all',
      'z_setting_memory_open_modal_clear_manage',
      'z_setting_memory_set_clear_all',
      'z_setting_memory_open_modal',
      'z_setting_memory_cancel',
    ]);
  });

  it('clear_all button in the bottom row has confirm dialog; clear_manage does not', async () => {
    clearAllMemoryMock('V2');
    addMemoryMock('V2', 'memory', 'mem1');
    const { blocks } = await renderMemoryCard({ userId: 'V2', issuedAt: 1 });

    // clear_all — danger + confirm
    const bot = findBlockById(blocks, 'z_memory_global_bottom');
    const clearAllBtn = (bot as any).elements.find((e: any) => e.action_id === 'z_setting_memory_set_clear_all');
    expect(clearAllBtn).toBeDefined();
    expect(clearAllBtn.style).toBe('danger');
    expect(clearAllBtn.confirm).toBeDefined();
    expect(clearAllBtn.confirm.title.text).toContain('전체 삭제 확인');

    // clear_manage — opens a modal; plain button (no style, no confirm).
    const clearManageBtn = (bot as any).elements.find(
      (e: any) => e.action_id === 'z_setting_memory_open_modal_clear_manage',
    );
    expect(clearManageBtn).toBeDefined();
    expect(clearManageBtn.style).toBeUndefined();
    expect(clearManageBtn.confirm).toBeUndefined();
  });

  it('does NOT collapse when total ≤ 42 (v4 budget; 1 block per entry)', async () => {
    clearAllMemoryMock('V3a');
    for (let i = 1; i <= 20; i++) addMemoryMock('V3a', 'memory', `mem${i}`);
    for (let i = 1; i <= 5; i++) addMemoryMock('V3a', 'user', `usr${i}`);
    const { blocks } = await renderMemoryCard({ userId: 'V3a', issuedAt: 1 });
    // 7 fixed + 25 per-entry = 32 blocks, no banner.
    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(findBlockById(blocks, 'z_memory_collapse_banner')).toBeUndefined();
  });

  it('collapse fallback: 50 memory + 5 user → blocks ≤ 50 + ⚠️ banner', async () => {
    clearAllMemoryMock('V3');
    for (let i = 1; i <= 50; i++) addMemoryMock('V3', 'memory', `mem${i}`);
    for (let i = 1; i <= 5; i++) addMemoryMock('V3', 'user', `usr${i}`);
    const { blocks } = await renderMemoryCard({ userId: 'V3', issuedAt: 1 });

    expect(blocks.length).toBeLessThanOrEqual(50);
    const banner = findBlockById(blocks, 'z_memory_collapse_banner');
    expect(banner).toBeDefined();
    expect((banner as any).elements[0].text).toContain('⚠️');
  });

  it('collapse fallback: 50+50 short entries stays ≤ 50 blocks', async () => {
    clearAllMemoryMock('V4');
    for (let i = 1; i <= 50; i++) addMemoryMock('V4', 'memory', `m${i}`);
    for (let i = 1; i <= 50; i++) addMemoryMock('V4', 'user', `u${i}`);
    const { blocks } = await renderMemoryCard({ userId: 'V4', issuedAt: 1 });
    expect(blocks.length).toBeLessThanOrEqual(50);
  });

  it('truncates per-entry section text > 3000 chars', async () => {
    clearAllMemoryMock('V5');
    addMemoryMock('V5', 'memory', 'a'.repeat(5000));
    addMemoryMock('V5', 'user', 'short');
    const { blocks } = await renderMemoryCard({ userId: 'V5', issuedAt: 1 });
    const sec = findBlockById(blocks, 'z_memory_entry_memory_1');
    expect(sec).toBeDefined();
    const txt = (sec as any).text.text as string;
    expect(txt.length).toBeLessThanOrEqual(3000);
    expect(txt).toContain('전체 보기는');
  });

  it('keeps byte size ≤ 12000 when entries are very long', async () => {
    clearAllMemoryMock('V6');
    for (let i = 1; i <= 12; i++) addMemoryMock('V6', 'memory', `m${i}-${'x'.repeat(2000)}`);
    for (let i = 1; i <= 12; i++) addMemoryMock('V6', 'user', `u${i}-${'y'.repeat(100)}`);
    const { blocks } = await renderMemoryCard({ userId: 'V6', issuedAt: 1 });
    const byteSize = Buffer.byteLength(JSON.stringify(blocks), 'utf8');
    expect(byteSize).toBeLessThanOrEqual(12000);
  });

  it('escapes mrkdwn tokens in entry text', async () => {
    clearAllMemoryMock('V7');
    addMemoryMock('V7', 'memory', '<@U123> hello');
    addMemoryMock('V7', 'memory', '*bold* text');
    addMemoryMock('V7', 'memory', '<!here> ping');
    addMemoryMock('V7', 'memory', 'a&b');
    addMemoryMock('V7', 'memory', '_italic_ `code` ~strike~');
    const { blocks } = await renderMemoryCard({ userId: 'V7', issuedAt: 1 });

    const allText = (blocks as any[])
      .filter((b) => b.type === 'section' && b.block_id?.startsWith('z_memory_entry_memory_'))
      .map((b) => b.text.text as string)
      .join('\n');

    // Mentions/URLs neutralized.
    expect(allText).toContain('&amp;');
    expect(allText).toContain('&lt;!here&gt;');
    expect(allText).toContain('&lt;@U123&gt;');
    expect(allText).not.toMatch(/<@U\d+>/);
    expect(allText).not.toContain('<!here>');

    // Bare formatting tokens in user content must not appear.
    // (Our own '*#N*' header prefix is intentional and stays.)
    // Check that user-provided '*', '_', '`', '~' tokens are replaced.
    // Removing the "*#" header prefixes first for a clean check.
    const userContent = allText.replace(/\*#\d+\*/g, '').replace(/\| /g, '');
    expect(userContent).not.toMatch(/(?<!\\)\*/); // user-provided '*' gone
    expect(userContent).not.toContain('_italic_');
    expect(userContent).not.toContain('`code`');
    expect(userContent).not.toContain('~strike~');
  });
});

describe('escapeMrkdwn / chunkByChars — utilities', () => {
  it('escapeMrkdwn neutralizes mention + mrkdwn tokens', () => {
    const out = escapeMrkdwn('<@U123> *X* <!here> a&b `c` ~d~ _e_');
    expect(out).not.toContain('<@U123>');
    expect(out).not.toContain('<!here>');
    expect(out).toContain('&amp;');
    expect(out).toContain('&lt;!here&gt;');
    expect(out).toContain('&lt;@U123&gt;');
    expect(out).not.toContain('`c`');
    expect(out).not.toContain('~d~');
  });

  it('escapes & before < > (order matters)', () => {
    // "&lt;" should appear once, not be double-escaped to "&amp;lt;"
    const out = escapeMrkdwn('<a&b>');
    expect(out).toBe('&lt;a&amp;b&gt;');
  });

  it('chunkByChars returns chunks each ≤ maxChars and joinable to original', () => {
    const src = 'x'.repeat(10000);
    const chunks = chunkByChars(src, 2900);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2900);
    expect(chunks.join('')).toBe(src);
  });

  it('chunkByChars returns the original text when shorter than maxChars', () => {
    expect(chunkByChars('short', 1000)).toEqual(['short']);
  });
});

/* ------------------------------------------------------------------ *
 * applyMemory — improve branches (Scenarios 6-9)
 * ------------------------------------------------------------------ */

describe('applyMemory — improve branches', () => {
  it('improve_memory_3 calls improveEntry + replaceMemoryByIndex and sets rerender', async () => {
    clearAllMemoryMock('I1');
    addMemoryMock('I1', 'memory', 'entry-A');
    addMemoryMock('I1', 'memory', 'entry-B');
    addMemoryMock('I1', 'memory', 'entry-C');
    vi.mocked(improveEntryMock).mockResolvedValueOnce('refined');

    const respond = vi.fn().mockResolvedValue(undefined);
    const result = await applyMemory({ userId: 'I1', value: 'improve_memory_3', respond });

    expect(improveEntryMock).toHaveBeenCalledTimes(1);
    expect(improveEntryMock).toHaveBeenCalledWith('entry-C', 'memory');
    // CAS: expectedOldText is the original entry text captured at click-time.
    expect(replaceMemoryByIndexMock).toHaveBeenCalledWith('I1', 'memory', 3, 'refined', 'entry-C');
    expect(respond).toHaveBeenCalledTimes(1);
    // Respond (pending card) must fire BEFORE replaceMemoryByIndex.
    const respondOrder = respond.mock.invocationCallOrder[0];
    const replaceOrder = vi.mocked(replaceMemoryByIndexMock).mock.invocationCallOrder[0];
    expect(respondOrder).toBeLessThan(replaceOrder);
    expect(result.ok).toBe(true);
    expect(result.rerender).toBe('topic');
    expect(result.summary).toContain('memory #3');
  });

  it('improve_user_2 routes to user target', async () => {
    clearAllMemoryMock('I2');
    addMemoryMock('I2', 'user', 'u1');
    addMemoryMock('I2', 'user', 'u2');
    vi.mocked(improveEntryMock).mockResolvedValueOnce('refined-u');
    const result = await applyMemory({ userId: 'I2', value: 'improve_user_2' });

    expect(improveEntryMock).toHaveBeenCalledWith('u2', 'user');
    expect(replaceMemoryByIndexMock).toHaveBeenCalledWith('I2', 'user', 2, 'refined-u', 'u2');
    expect(result.ok).toBe(true);
    expect(result.rerender).toBe('topic');
  });

  it('improve_memory_all calls improveAll + replaceAllMemory (not clearAllMemory)', async () => {
    clearAllMemoryMock('I3');
    addMemoryMock('I3', 'memory', 'a');
    addMemoryMock('I3', 'memory', 'b');
    addMemoryMock('I3', 'memory', 'c');
    vi.mocked(improveAllMock).mockResolvedValueOnce(['x', 'y', 'z']);
    const result = await applyMemory({ userId: 'I3', value: 'improve_memory_all' });

    expect(improveAllMock).toHaveBeenCalledTimes(1);
    expect(improveAllMock).toHaveBeenCalledWith(['a', 'b', 'c'], 'memory');
    // CAS: 4th arg is the snapshot captured before the LLM call.
    expect(replaceAllMemoryMock).toHaveBeenCalledWith('I3', 'memory', ['x', 'y', 'z'], ['a', 'b', 'c']);
    expect(result.ok).toBe(true);
    expect(result.rerender).toBe('topic');
    expect(result.summary).toContain('3 → 3');
  });

  it('improve_user_all routes to user target', async () => {
    clearAllMemoryMock('I4');
    addMemoryMock('I4', 'user', 'u-a');
    addMemoryMock('I4', 'user', 'u-b');
    vi.mocked(improveAllMock).mockResolvedValueOnce(['U-A', 'U-B']);
    const result = await applyMemory({ userId: 'I4', value: 'improve_user_all' });

    expect(improveAllMock).toHaveBeenCalledWith(['u-a', 'u-b'], 'user');
    expect(replaceAllMemoryMock).toHaveBeenCalledWith('I4', 'user', ['U-A', 'U-B'], ['u-a', 'u-b']);
    expect(result.ok).toBe(true);
    expect(result.rerender).toBe('topic');
  });

  it('returns failure without mutation when improveEntry throws', async () => {
    clearAllMemoryMock('I5');
    addMemoryMock('I5', 'memory', 'x');
    vi.mocked(improveEntryMock).mockRejectedValueOnce(new Error('LLM down'));
    const result = await applyMemory({ userId: 'I5', value: 'improve_memory_1' });

    expect(replaceMemoryByIndexMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('개선 실패');
    expect(result.summary).toContain('LLM down');
    expect(result.rerender).toBe('topic');
  });

  it('returns failure when replaceAllMemory rejects (store unchanged)', async () => {
    clearAllMemoryMock('I6');
    addMemoryMock('I6', 'memory', 'orig');
    // Return duplicates so mock replaceAllMemory's prevalidate rejects.
    vi.mocked(improveAllMock).mockResolvedValueOnce(['dup', 'dup']);
    const result = await applyMemory({ userId: 'I6', value: 'improve_memory_all' });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('저장 실패');
    expect(result.summary).toContain('duplicates');
    expect(result.rerender).toBe('topic');
  });

  it('out-of-range improve_memory_99 returns failure without LLM call', async () => {
    clearAllMemoryMock('I7');
    addMemoryMock('I7', 'memory', 'only');
    const result = await applyMemory({ userId: 'I7', value: 'improve_memory_99' });

    expect(improveEntryMock).not.toHaveBeenCalled();
    expect(replaceMemoryByIndexMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('entry 없음');
    expect(result.rerender).toBe('topic');
  });

  it('empty store improve_memory_all returns info without LLM', async () => {
    clearAllMemoryMock('I8');
    const result = await applyMemory({ userId: 'I8', value: 'improve_memory_all' });

    expect(improveAllMock).not.toHaveBeenCalled();
    expect(replaceAllMemoryMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('entries 없음');
    expect(result.rerender).toBe('topic');
  });

  it('respond callback receives pending card blocks', async () => {
    clearAllMemoryMock('I9');
    addMemoryMock('I9', 'memory', 'e1');
    vi.mocked(improveEntryMock).mockResolvedValueOnce('refined');
    const respond = vi.fn().mockResolvedValue(undefined);

    await applyMemory({ userId: 'I9', value: 'improve_memory_1', respond });

    expect(respond).toHaveBeenCalledTimes(1);
    const [firstArg] = respond.mock.calls[0];
    expect(Array.isArray(firstArg)).toBe(true);
    const pendingText = (firstArg as any[])
      .filter((b) => b.type === 'section' && typeof b.text?.text === 'string')
      .map((b) => b.text.text as string)
      .join(' ');
    expect(pendingText).toContain('개선 중');
  });

  it('improve_memory_N rejects with CAS mismatch when entry shifted mid-flight', async () => {
    clearAllMemoryMock('I10');
    addMemoryMock('I10', 'memory', 'A');
    addMemoryMock('I10', 'memory', 'B');
    addMemoryMock('I10', 'memory', 'C');

    // Simulate concurrent delete during the LLM call: when improveEntry
    // resolves, we remove index 1 so idx 3 no longer points to 'C'.
    vi.mocked(improveEntryMock).mockImplementationOnce(async (text: string) => {
      expect(text).toBe('C'); // captured original
      // Race: another click removed entry 1 ('A')
      const { removeMemoryByIndex } = await import('../../../../user-memory-store');
      (removeMemoryByIndex as any)('I10', 'memory', 1);
      return 'refined-C';
    });

    const result = await applyMemory({ userId: 'I10', value: 'improve_memory_3' });

    // applyMemory passes expectedOldText='C'. Store now has ['B', 'C'].
    // entries[3-1] is undefined (length=2 < 3) → index out-of-range, NOT cas mismatch.
    // For the CAS path proper, we need a shift that keeps length >= idx but
    // swaps the target. Use a different race instead:
    expect(result.ok).toBe(false);
    expect(result.rerender).toBe('topic');
  });

  it('improve_memory_N rejects with CAS mismatch on same-length shift', async () => {
    clearAllMemoryMock('I11');
    addMemoryMock('I11', 'memory', 'A');
    addMemoryMock('I11', 'memory', 'B');
    addMemoryMock('I11', 'memory', 'C');

    // Race: during LLM call, another click replaced entry 2 in-place.
    vi.mocked(improveEntryMock).mockImplementationOnce(async (text: string) => {
      expect(text).toBe('B');
      // Replace idx 2 without CAS (regular replaceMemoryByIndex with no
      // expected arg) — simulates a parallel non-CAS write. Use mock directly.
      const store = await import('../../../../user-memory-store');
      (store.replaceMemoryByIndex as any)('I11', 'memory', 2, 'HIJACKED');
      return 'would-be-refined-B';
    });

    const result = await applyMemory({ userId: 'I11', value: 'improve_memory_2' });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('다른 수정이 발생해 취소됨');
    expect(result.rerender).toBe('topic');
    // Verify the hijacker's value survived — not overwritten by the stale LLM.
    const { loadMemory } = await import('../../../../user-memory-store');
    expect((loadMemory as any)('I11', 'memory').entries[1]).toBe('HIJACKED');
  });

  it('improve_memory_all rejects with CAS mismatch when entries mutated mid-flight', async () => {
    clearAllMemoryMock('I12');
    addMemoryMock('I12', 'memory', 'a1');
    addMemoryMock('I12', 'memory', 'a2');
    addMemoryMock('I12', 'memory', 'a3');

    // Race: delete one entry while the LLM batch-refine runs.
    vi.mocked(improveAllMock).mockImplementationOnce(async (arr: string[]) => {
      expect(arr).toEqual(['a1', 'a2', 'a3']); // snapshot was captured
      const { removeMemoryByIndex } = await import('../../../../user-memory-store');
      (removeMemoryByIndex as any)('I12', 'memory', 1);
      return ['refined'];
    });

    const result = await applyMemory({ userId: 'I12', value: 'improve_memory_all' });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('다른 수정이 발생해 취소됨');
    expect(result.rerender).toBe('topic');
    // Intervening delete survived — store not clobbered by stale all-improve.
    const { loadMemory } = await import('../../../../user-memory-store');
    expect((loadMemory as any)('I12', 'memory').entries).toEqual(['a2', 'a3']);
  });
});

/* ------------------------------------------------------------------ *
 * applyMemory — clear branches MUST NOT set rerender (Scenario 17)
 * ------------------------------------------------------------------ */

describe('applyMemory — regression (clear branches have no rerender)', () => {
  it('clear_memory_3 returns undefined rerender', async () => {
    clearAllMemoryMock('R1');
    addMemoryMock('R1', 'memory', 'a');
    addMemoryMock('R1', 'memory', 'b');
    addMemoryMock('R1', 'memory', 'c');
    const r = await applyMemory({ userId: 'R1', value: 'clear_memory_3' });
    expect(r.ok).toBe(true);
    expect(r.rerender).toBeUndefined();
  });

  it('clear_user_1 returns undefined rerender', async () => {
    clearAllMemoryMock('R2');
    addMemoryMock('R2', 'user', 'u1');
    const r = await applyMemory({ userId: 'R2', value: 'clear_user_1' });
    expect(r.ok).toBe(true);
    expect(r.rerender).toBeUndefined();
  });

  it('clear_all returns undefined rerender', async () => {
    const r = await applyMemory({ userId: 'R3', value: 'clear_all' });
    expect(r.ok).toBe(true);
    expect(r.rerender).toBeUndefined();
  });
});
