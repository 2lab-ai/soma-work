/**
 * Tests for `<current-user-instruction>` block builder (#756).
 *
 * The block lives at a fixed position in the system prompt every request,
 * is re-derived from the user-scope master (UserSessionStore) on every
 * rebuild, and surfaces:
 *   - the active instruction (id · title, age, linked sessions)
 *   - explicit `active: null` when the session pointer is null
 *   - candidate active instructions (max 5, "+ N more" overflow)
 *   - a `pending: <op> ...` line when a y/n confirm entry exists
 *
 * The builder is pure — it consumes a UserSessionDoc, the session pointer,
 * and an optional pending-confirm entry. Wiring (UserSessionStore +
 * PendingInstructionConfirmStore lookup) is the prompt-builder's job.
 */

import { describe, expect, it } from 'vitest';
import {
  buildCurrentInstructionBlock,
  CURRENT_INSTRUCTION_BLOCK_CLOSE,
  CURRENT_INSTRUCTION_BLOCK_OPEN,
} from '../current-instruction-block';
import type { UserSessionDoc } from '../../user-session-store';
import type { PendingInstructionConfirm } from '../../slack/actions/pending-instruction-confirm-store';

const NOW_MS = Date.UTC(2026, 3, 28, 12, 0, 0); // 2026-04-28 12:00 UTC
const NOW_ISO = new Date(NOW_MS).toISOString();

function isoHoursAgo(h: number): string {
  return new Date(NOW_MS - h * 3600 * 1000).toISOString();
}

function emptyDoc(): UserSessionDoc {
  return { schemaVersion: 1, instructions: [], lifecycleEvents: [] };
}

describe('buildCurrentInstructionBlock', () => {
  it('always emits the block — fixed position with the canonical tag', () => {
    const doc = emptyDoc();
    const block = buildCurrentInstructionBlock({
      doc,
      sessionKey: 'C1-T1',
      currentInstructionId: null,
      now: () => NOW_ISO,
    });
    expect(block.startsWith(CURRENT_INSTRUCTION_BLOCK_OPEN)).toBe(true);
    expect(block.endsWith(CURRENT_INSTRUCTION_BLOCK_CLOSE)).toBe(true);
    expect(block).toContain('active: null');
  });

  it('renders the active instruction with id · title, age, and linked sessions', () => {
    const doc: UserSessionDoc = {
      schemaVersion: 1,
      instructions: [
        {
          id: 'inst_1',
          text: 'ship the dashboard',
          status: 'active',
          source: 'model',
          createdAt: isoHoursAgo(5),
          linkedSessionIds: ['C1-T1', 'C1-T2'],
          sourceRawInputIds: [],
        },
      ],
      lifecycleEvents: [],
    };

    const block = buildCurrentInstructionBlock({
      doc,
      sessionKey: 'C1-T1',
      currentInstructionId: 'inst_1',
      now: () => NOW_ISO,
    });

    expect(block).toContain('active: inst_1 · ship the dashboard');
    expect(block).toContain('age: 5h');
    expect(block).toContain('linked sessions: [C1-T1, C1-T2]');
    // Active line must be the first content row inside the block.
    const lines = block.split('\n');
    expect(lines[1]?.trim().startsWith('active: inst_1')).toBe(true);
  });

  it('renders linked sessions as an empty list when there are no links yet', () => {
    const doc: UserSessionDoc = {
      schemaVersion: 1,
      instructions: [
        {
          id: 'inst_1',
          text: 't',
          status: 'active',
          source: 'model',
          createdAt: isoHoursAgo(0),
          linkedSessionIds: [],
          sourceRawInputIds: [],
        },
      ],
      lifecycleEvents: [],
    };

    const block = buildCurrentInstructionBlock({
      doc,
      sessionKey: 'C1-T1',
      currentInstructionId: 'inst_1',
      now: () => NOW_ISO,
    });
    expect(block).toContain('linked sessions: []');
  });

  it('falls back to active: null when currentInstructionId points at a missing instruction', () => {
    // Defensive: doc.instructions does not contain `gone_id`. The block
    // should NOT throw; it should render `active: null` so the model gets
    // a deterministic answer instead of a half-formed line.
    const doc = emptyDoc();
    const block = buildCurrentInstructionBlock({
      doc,
      sessionKey: 'C1-T1',
      currentInstructionId: 'gone_id',
      now: () => NOW_ISO,
    });
    expect(block).toContain('active: null');
    expect(block).not.toContain('gone_id');
  });

  it('falls back to active: null when the pointed instruction is completed/cancelled', () => {
    const doc: UserSessionDoc = {
      schemaVersion: 1,
      instructions: [
        {
          id: 'done_1',
          text: 'done',
          status: 'completed',
          source: 'model',
          createdAt: isoHoursAgo(10),
          completedAt: isoHoursAgo(1),
          linkedSessionIds: [],
          sourceRawInputIds: [],
        },
      ],
      lifecycleEvents: [],
    };
    const block = buildCurrentInstructionBlock({
      doc,
      sessionKey: 'C1-T1',
      currentInstructionId: 'done_1',
      now: () => NOW_ISO,
    });
    expect(block).toContain('active: null');
    expect(block).not.toContain('active: done_1');
  });

  it('lists candidates from the user master when active is null, sorted by recency, max 5', () => {
    const instructions: UserSessionDoc['instructions'] = [];
    for (let i = 1; i <= 7; i++) {
      instructions.push({
        id: `c${i}`,
        text: `candidate ${i}`,
        status: 'active',
        source: 'model',
        createdAt: isoHoursAgo(20 - i), // c1 oldest, c7 newest
        linkedSessionIds: [],
        sourceRawInputIds: [],
      });
    }
    const doc: UserSessionDoc = {
      schemaVersion: 1,
      instructions,
      lifecycleEvents: [],
    };

    const block = buildCurrentInstructionBlock({
      doc,
      sessionKey: 'C1-T1',
      currentInstructionId: null,
      now: () => NOW_ISO,
    });

    expect(block).toContain('active: null');
    expect(block).toContain('candidates');
    // Newest 5 candidates (c7..c3); c1 and c2 dropped, surfaced as "+ N more".
    expect(block).toContain('c7 · candidate 7');
    expect(block).toContain('c3 · candidate 3');
    expect(block).not.toContain('c2 · candidate 2');
    expect(block).not.toContain('c1 · candidate 1');
    expect(block).toContain('+ 2 more (see dashboard)');
  });

  it('omits completed/cancelled rows from the candidate list', () => {
    const doc: UserSessionDoc = {
      schemaVersion: 1,
      instructions: [
        {
          id: 'c_active',
          text: 'live',
          status: 'active',
          source: 'model',
          createdAt: isoHoursAgo(2),
          linkedSessionIds: [],
          sourceRawInputIds: [],
        },
        {
          id: 'c_done',
          text: 'done',
          status: 'completed',
          source: 'model',
          createdAt: isoHoursAgo(3),
          completedAt: isoHoursAgo(1),
          linkedSessionIds: [],
          sourceRawInputIds: [],
        },
        {
          id: 'c_cancelled',
          text: 'gone',
          status: 'cancelled',
          source: 'model',
          createdAt: isoHoursAgo(4),
          cancelledAt: isoHoursAgo(2),
          linkedSessionIds: [],
          sourceRawInputIds: [],
        },
      ],
      lifecycleEvents: [],
    };

    const block = buildCurrentInstructionBlock({
      doc,
      sessionKey: 'C1-T1',
      currentInstructionId: null,
      now: () => NOW_ISO,
    });

    expect(block).toContain('c_active · live');
    expect(block).not.toContain('c_done');
    expect(block).not.toContain('c_cancelled');
  });

  it('emits "candidates: none" when active is null and the user has no active instructions', () => {
    const doc = emptyDoc();
    const block = buildCurrentInstructionBlock({
      doc,
      sessionKey: 'C1-T1',
      currentInstructionId: null,
      now: () => NOW_ISO,
    });
    expect(block).toContain('active: null');
    // No candidates list emitted when the master is empty — keeps prompt
    // noise low. The model just sees `active: null`.
    expect(block).not.toContain('candidates');
    expect(block).not.toContain('see dashboard');
  });

  it('emits a pending: line when a confirm entry is supplied', () => {
    const doc: UserSessionDoc = {
      schemaVersion: 1,
      instructions: [
        {
          id: 'inst_1',
          text: 't',
          status: 'active',
          source: 'model',
          createdAt: isoHoursAgo(2),
          linkedSessionIds: [],
          sourceRawInputIds: [],
        },
      ],
      lifecycleEvents: [],
    };
    const pending: PendingInstructionConfirm = {
      requestId: 'req_1',
      sessionKey: 'C1-T1',
      channelId: 'C1',
      threadTs: 'T1',
      payload: { instructionOperations: [{ action: 'complete', id: 'inst_1' }] } as unknown as PendingInstructionConfirm['payload'],
      createdAt: NOW_MS - 30 * 60 * 1000,
      requesterId: 'U_REQ',
      type: 'complete',
      by: { type: 'slack-user', id: 'U_REQ' },
    };
    const block = buildCurrentInstructionBlock({
      doc,
      sessionKey: 'C1-T1',
      currentInstructionId: 'inst_1',
      pending,
      now: () => NOW_ISO,
    });
    expect(block).toMatch(/pending: complete \(requested by slack-user:U_REQ at /);
  });

  it('still emits the block with active and pending lines together', () => {
    const doc: UserSessionDoc = {
      schemaVersion: 1,
      instructions: [
        {
          id: 'inst_1',
          text: 'do x',
          status: 'active',
          source: 'model',
          createdAt: isoHoursAgo(1),
          linkedSessionIds: ['C1-T1'],
          sourceRawInputIds: [],
        },
      ],
      lifecycleEvents: [],
    };
    const pending: PendingInstructionConfirm = {
      requestId: 'req_x',
      sessionKey: 'C1-T1',
      channelId: 'C1',
      threadTs: 'T1',
      payload: { instructionOperations: [{ action: 'rename', id: 'inst_1', text: 'do x prime' }] } as unknown as PendingInstructionConfirm['payload'],
      createdAt: NOW_MS - 5 * 60 * 1000,
      requesterId: 'U_REQ',
      type: 'rename',
      by: { type: 'slack-user', id: 'U_REQ' },
    };
    const block = buildCurrentInstructionBlock({
      doc,
      sessionKey: 'C1-T1',
      currentInstructionId: 'inst_1',
      pending,
      now: () => NOW_ISO,
    });
    expect(block).toContain('active: inst_1 · do x');
    expect(block).toContain('pending: rename');
    expect(block.indexOf('active:')).toBeLessThan(block.indexOf('pending:'));
  });

  it('produces the same block content from the same master across two calls (compact/reset survival)', () => {
    // The block is re-derivable on demand: same UserSessionDoc + same
    // session pointer must yield byte-identical output. This is the
    // dual-protection contract — after compaction or reset the host
    // re-runs the builder against the unchanged master and the model
    // sees the same authoritative answer.
    const doc: UserSessionDoc = {
      schemaVersion: 1,
      instructions: [
        {
          id: 'inst_1',
          text: 't',
          status: 'active',
          source: 'model',
          createdAt: isoHoursAgo(3),
          linkedSessionIds: ['C1-T1'],
          sourceRawInputIds: [],
        },
      ],
      lifecycleEvents: [],
    };
    const a = buildCurrentInstructionBlock({
      doc,
      sessionKey: 'C1-T1',
      currentInstructionId: 'inst_1',
      now: () => NOW_ISO,
    });
    const b = buildCurrentInstructionBlock({
      doc,
      sessionKey: 'C1-T1',
      currentInstructionId: 'inst_1',
      now: () => NOW_ISO,
    });
    expect(a).toBe(b);
  });

  it('truncates long instruction titles to keep the prompt compact', () => {
    const longText = 'x'.repeat(500);
    const doc: UserSessionDoc = {
      schemaVersion: 1,
      instructions: [
        {
          id: 'inst_1',
          text: longText,
          status: 'active',
          source: 'model',
          createdAt: isoHoursAgo(0),
          linkedSessionIds: [],
          sourceRawInputIds: [],
        },
      ],
      lifecycleEvents: [],
    };
    const block = buildCurrentInstructionBlock({
      doc,
      sessionKey: 'C1-T1',
      currentInstructionId: 'inst_1',
      now: () => NOW_ISO,
    });
    // Single active line must not contain the full 500-char text — the
    // builder enforces a length cap on the rendered title.
    const activeLine = block.split('\n').find((l) => l.trim().startsWith('active:')) || '';
    expect(activeLine.length).toBeLessThan(longText.length);
    expect(activeLine).toContain('…');
  });
});
