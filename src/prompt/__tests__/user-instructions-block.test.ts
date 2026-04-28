import { describe, expect, it } from 'vitest';
import type { ConversationSession, SessionInstruction } from '../../types';
import {
  buildUserInstructionsBlock,
  computeCompletedUpstreamHash,
  USER_INSTRUCTIONS_BLOCK_CLOSE,
  USER_INSTRUCTIONS_BLOCK_OPEN,
} from '../user-instructions-block';

function mkSession(instructions: SessionInstruction[]): ConversationSession {
  return {
    ownerId: 'U123',
    userId: 'U123',
    channelId: 'C1',
    isActive: true,
    lastActivity: new Date(),
    instructions,
  } as ConversationSession;
}

type LegacyInstrFixture = {
  id?: string;
  text?: string;
  createdAt?: string;
  status?: SessionInstruction['status'];
  source?: SessionInstruction['source'];
  // Legacy fixture fields — accepted for terseness, normalised below.
  addedAt?: number;
  completedAt?: number | string;
  evidence?: string;
  linkedSessionIds?: string[];
  sourceRawInputIds?: SessionInstruction['sourceRawInputIds'];
};

function mkInstr(partial: LegacyInstrFixture): SessionInstruction {
  // Sealed shape (#727 / #754): `createdAt` is an ISO string, `source` is
  // an enum, `linkedSessionIds` / `sourceRawInputIds` are required arrays,
  // and there is no `evidence` field. Tests still accept legacy fixture
  // numbers (`addedAt`, numeric `completedAt`) for terseness; they're
  // converted to ISO here.
  const createdAt =
    partial.createdAt ??
    (typeof partial.addedAt === 'number' ? new Date(partial.addedAt).toISOString() : new Date(0).toISOString());
  return {
    id: partial.id ?? 'instr_default',
    text: partial.text ?? 'do the thing',
    createdAt,
    source: partial.source ?? 'model',
    status: partial.status ?? 'active',
    completedAt:
      typeof partial.completedAt === 'number' ? new Date(partial.completedAt).toISOString() : partial.completedAt,
    linkedSessionIds: partial.linkedSessionIds ?? [],
    sourceRawInputIds: partial.sourceRawInputIds ?? [],
  };
}

describe('buildUserInstructionsBlock', () => {
  it('returns empty string when session has no instructions', () => {
    expect(buildUserInstructionsBlock(undefined)).toBe('');
    expect(buildUserInstructionsBlock(mkSession([]))).toBe('');
  });

  it('renders active-only entries in full text', () => {
    const block = buildUserInstructionsBlock(
      mkSession([
        mkInstr({ id: 'a', text: 'ship the feature', status: 'active' }),
        mkInstr({ id: 'b', text: 'write tests', status: 'active' }),
      ]),
    );
    expect(block).toContain(USER_INSTRUCTIONS_BLOCK_OPEN);
    expect(block).toContain(USER_INSTRUCTIONS_BLOCK_CLOSE);
    expect(block).toContain('## Active');
    expect(block).toContain('- ship the feature');
    expect(block).toContain('- write tests');
    expect(block).not.toContain('## Completed');
  });

  it('renders active before completed and DROPS cancelled (PR1 scope, TODO(#756))', () => {
    // Sealed status set (#754): active | completed | cancelled. PR1 (#754)
    // is mechanical sealed-enum compatibility ONLY — the builder must read
    // 'cancelled' rows without crashing but MUST NOT render them. Surfacing
    // cancelled to the prompt is owned by #756.
    const block = buildUserInstructionsBlock(
      mkSession([
        mkInstr({ id: 'c', text: 'completed-one', status: 'completed', completedAt: 1 }),
        mkInstr({ id: 'a', text: 'active-one', status: 'active' }),
        mkInstr({ id: 'x', text: 'cancelled-one', status: 'cancelled' }),
      ]),
    );
    const activeIdx = block.indexOf('## Active');
    const completedIdx = block.indexOf('## Completed');
    expect(activeIdx).toBeGreaterThan(-1);
    expect(completedIdx).toBeGreaterThan(activeIdx);
    // PR1: cancelled section is intentionally absent.
    expect(block).not.toContain('## Cancelled');
    expect(block).not.toContain('cancelled-one');
  });

  it('renders a single completed entry verbatim (no summary)', () => {
    const block = buildUserInstructionsBlock(
      mkSession([mkInstr({ id: 'c', text: 'closed the ticket', status: 'completed', completedAt: 1 })]),
    );
    expect(block).toContain('## Completed');
    expect(block).toContain('- closed the ticket');
    expect(block).not.toContain('summary pending');
  });

  it('falls back to placeholder when ≥2 completed and no cached summary', () => {
    const session = mkSession([
      mkInstr({ id: 'c1', text: 't1', status: 'completed', completedAt: 1 }),
      mkInstr({ id: 'c2', text: 't2', status: 'completed', completedAt: 2 }),
    ]);
    const block = buildUserInstructionsBlock(session);
    expect(block).toContain('## Completed');
    expect(block).toContain('summary pending');
    expect(block).not.toContain('- t1');
  });

  it('uses cached summary when hash matches', () => {
    const session = mkSession([
      mkInstr({ id: 'c1', text: 't1', status: 'completed', completedAt: 1 }),
      mkInstr({ id: 'c2', text: 't2', status: 'completed', completedAt: 2 }),
    ]);
    const hash = computeCompletedUpstreamHash(session.instructions);
    session.instructionsCompletedSummary = {
      summary: 'Closed two tickets relating to auth flow.',
      upstreamHash: hash,
    };
    const block = buildUserInstructionsBlock(session);
    expect(block).toContain('Closed two tickets relating to auth flow.');
    expect(block).not.toContain('summary pending');
  });

  it('falls back to placeholder when hash mismatches (stale cache)', () => {
    const session = mkSession([
      mkInstr({ id: 'c1', text: 't1', status: 'completed', completedAt: 1 }),
      mkInstr({ id: 'c2', text: 't2', status: 'completed', completedAt: 2 }),
    ]);
    session.instructionsCompletedSummary = {
      summary: 'old summary',
      upstreamHash: 'deadbeef',
    };
    const block = buildUserInstructionsBlock(session);
    expect(block).toContain('summary pending');
    expect(block).not.toContain('old summary');
  });
});

describe('computeCompletedUpstreamHash', () => {
  it('is deterministic across array-order permutations', () => {
    const a: SessionInstruction[] = [
      mkInstr({ id: 'c1', completedAt: 10, status: 'completed', text: 'x' }),
      mkInstr({ id: 'c2', completedAt: 20, status: 'completed', text: 'y' }),
    ];
    const b: SessionInstruction[] = [a[1], a[0]];
    expect(computeCompletedUpstreamHash(a)).toBe(computeCompletedUpstreamHash(b));
  });

  it('ignores non-completed entries', () => {
    const onlyCompleted = [mkInstr({ id: 'c1', status: 'completed', completedAt: 10 })];
    const withExtras = [
      ...onlyCompleted,
      mkInstr({ id: 'a1', status: 'active' }),
      mkInstr({ id: 't1', status: 'cancelled' }),
    ];
    expect(computeCompletedUpstreamHash(onlyCompleted)).toBe(computeCompletedUpstreamHash(withExtras));
  });

  it('changes when a new completion is added', () => {
    const before = computeCompletedUpstreamHash([mkInstr({ id: 'c1', status: 'completed', completedAt: 1 })]);
    const after = computeCompletedUpstreamHash([
      mkInstr({ id: 'c1', status: 'completed', completedAt: 1 }),
      mkInstr({ id: 'c2', status: 'completed', completedAt: 2 }),
    ]);
    expect(before).not.toBe(after);
  });

  it('returns the empty-input hash when no completed entries exist', () => {
    const h1 = computeCompletedUpstreamHash([]);
    const h2 = computeCompletedUpstreamHash(undefined);
    expect(h1).toBe(h2);
  });
});
