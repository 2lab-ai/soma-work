import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../user-memory-store', () => {
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
  };
});

import { addMemory as addMemoryMock, clearAllMemory as clearAllMemoryMock } from '../../../user-memory-store';
import {
  applyMemory,
  buildMemoryAddModal,
  createMemoryTopicBinding,
  renderMemoryCard,
  submitMemoryModal,
} from './memory-topic';

function actionIds(blocks: any[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === 'actions') for (const e of b.elements) out.push(e.action_id);
  }
  return out;
}

describe('memory-topic.renderMemoryCard', () => {
  it('shows clear_all + open_modal + cancel even when stores are empty', async () => {
    // Reset
    clearAllMemoryMock('U1');
    const { blocks, text } = await renderMemoryCard({ userId: 'U1', issuedAt: 1 });
    expect(text).toContain('Memory');
    const ids = actionIds(blocks);
    expect(ids).toContain('z_setting_memory_set_clear_all');
    expect(ids).toContain('z_setting_memory_open_modal');
    expect(ids).toContain('z_setting_memory_cancel');
  });

  it('renders per-entry clear buttons for populated stores', async () => {
    clearAllMemoryMock('U2');
    addMemoryMock('U2', 'memory', 'first entry');
    addMemoryMock('U2', 'user', 'first user entry');
    const { blocks } = await renderMemoryCard({ userId: 'U2', issuedAt: 2 });
    const ids = actionIds(blocks);
    expect(ids).toContain('z_setting_memory_set_clear_memory_1');
    expect(ids).toContain('z_setting_memory_set_clear_user_1');
  });
});

describe('memory-topic.applyMemory', () => {
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
    const target = view.blocks.find((b: any) => b.block_id === 'memory_target');
    const content = view.blocks.find((b: any) => b.block_id === 'memory_content');
    expect(target).toBeDefined();
    expect(content).toBeDefined();
    expect(content.element.multiline).toBe(true);
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
});
