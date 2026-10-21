import { describe, expect, it } from 'vitest';
import type { AvailableSkill } from '../../skill-locator';
import {
  AUTOSKILL_ADD_BLOCK_ID,
  AUTOSKILL_ADD_OPEN_ACTION_ID,
  AUTOSKILL_ADD_SELECT_ACTION_ID,
  AUTOSKILL_REMOVE_ACTION_ID,
  buildAutoskillAddModal,
  buildAutoskillCard,
  parseAutoskillButtonValue,
  parseAutoskillModalMetadata,
} from '../autoskill-blocks';

const REQ = 'U_REQ';

describe('buildAutoskillCard', () => {
  it('renders an empty-state card with just the add button', () => {
    const { blocks } = buildAutoskillCard({ requesterId: REQ, skills: [] });
    const actionIds = collectActionIds(blocks);
    expect(actionIds).toContain(AUTOSKILL_ADD_OPEN_ACTION_ID);
    expect(actionIds).not.toContain(AUTOSKILL_REMOVE_ACTION_ID);
  });

  it('renders one delete button per registered skill', () => {
    const { blocks } = buildAutoskillCard({ requesterId: REQ, skills: ['a', 'b'] });
    const removeButtons = collectButtons(blocks).filter((b) => b.action_id === AUTOSKILL_REMOVE_ACTION_ID);
    expect(removeButtons).toHaveLength(2);
    // Each delete button carries the requester + the specific skill name.
    const values = removeButtons.map((b) => parseAutoskillButtonValue(b.value));
    expect(values).toEqual([
      { requesterId: REQ, skillName: 'a' },
      { requesterId: REQ, skillName: 'b' },
    ]);
  });

  it('add button carries the requester id (no skillName)', () => {
    const { blocks } = buildAutoskillCard({ requesterId: REQ, skills: ['a'] });
    const addBtn = collectButtons(blocks).find((b) => b.action_id === AUTOSKILL_ADD_OPEN_ACTION_ID);
    expect(parseAutoskillButtonValue(addBtn?.value)).toEqual({ requesterId: REQ, skillName: undefined });
  });
});

describe('buildAutoskillAddModal', () => {
  const available: AvailableSkill[] = [
    { name: 'using-ssot', source: 'local' },
    { name: 'using-govuk', source: 'local' },
    { name: 'my-skill', source: 'user' },
  ];
  const meta = { requesterId: REQ, channelId: 'C1', messageTs: '1.1', threadTs: '1.1' };

  it('excludes already-registered skills from the options', () => {
    const modal = buildAutoskillAddModal({ available, alreadyRegistered: ['using-ssot'], privateMetadata: meta });
    expect(modal).not.toBeNull();
    const opts = selectOptions(modal as Record<string, any>);
    const values = opts.map((o) => o.value);
    expect(values).toContain('using-govuk');
    expect(values).toContain('my-skill');
    expect(values).not.toContain('using-ssot');
  });

  it('returns null when nothing is left to add', () => {
    const modal = buildAutoskillAddModal({
      available,
      alreadyRegistered: ['using-ssot', 'using-govuk', 'my-skill'],
      privateMetadata: meta,
    });
    expect(modal).toBeNull();
  });

  it('encodes the private metadata as JSON', () => {
    const modal = buildAutoskillAddModal({ available, alreadyRegistered: [], privateMetadata: meta }) as Record<
      string,
      any
    >;
    expect(parseAutoskillModalMetadata(modal.private_metadata)).toEqual(meta);
  });

  it('uses the documented block/action ids', () => {
    const modal = buildAutoskillAddModal({ available, alreadyRegistered: [], privateMetadata: meta }) as Record<
      string,
      any
    >;
    const block = modal.blocks.find((b: any) => b.block_id === AUTOSKILL_ADD_BLOCK_ID);
    expect(block.element.action_id).toBe(AUTOSKILL_ADD_SELECT_ACTION_ID);
    expect(block.element.type).toBe('multi_static_select');
  });
});

describe('parseAutoskillButtonValue', () => {
  it('rejects malformed JSON / missing requesterId', () => {
    expect(parseAutoskillButtonValue('not-json')).toBeNull();
    expect(parseAutoskillButtonValue(JSON.stringify({ skillName: 'a' }))).toBeNull();
    expect(parseAutoskillButtonValue(123 as unknown)).toBeNull();
  });
});

describe('parseAutoskillModalMetadata', () => {
  it('rejects malformed metadata', () => {
    expect(parseAutoskillModalMetadata('nope')).toBeNull();
    expect(parseAutoskillModalMetadata(JSON.stringify({ channelId: 'C1' }))).toBeNull();
  });
});

// ── helpers ──
function collectButtons(blocks: any[]): any[] {
  const out: any[] = [];
  for (const b of blocks) {
    if (b.accessory?.type === 'button') out.push(b.accessory);
    if (b.type === 'actions') for (const el of b.elements ?? []) if (el.type === 'button') out.push(el);
  }
  return out;
}
function collectActionIds(blocks: any[]): string[] {
  return collectButtons(blocks).map((b) => b.action_id);
}
function selectOptions(modal: Record<string, any>): Array<{ value: string }> {
  const block = modal.blocks.find((b: any) => b.block_id === AUTOSKILL_ADD_BLOCK_ID);
  return block.element.options;
}
