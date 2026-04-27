/**
 * Preview-only: writes the rendered /z memory card as JSON to $TMPDIR so we
 * can feed it into the Block Kit Builder / preview skill during code review.
 *
 * Gated behind `MEMORY_CARD_PREVIEW=1` — under the normal `npm test` run it
 * is a single assertion that exercises the render path but does not emit a
 * file, keeping test output clean.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../user-memory-store', () => {
  const mem = [
    'Project: soma-work — TypeScript + Slack Bolt + Claude MCP.',
    'macOS sandbox TLS: GODEBUG=x509usefallbackroots=1 + fallback import (PR #511).',
    'MCP push_files cannot trigger GitHub Actions workflows.',
    'UIAskUserQuestion requires tier prefix [tiny|small|medium|large|xlarge].',
  ];
  const usr = [
    'Prefers direct tone. Hates filler intros.',
    'Enforces zcheck before any Approval.',
    'Demands tier + options-with-rationale in UIAskUserQuestion.',
  ];
  type Target = 'memory' | 'user';
  return {
    loadMemory: (_u: string, t: Target) => ({
      entries: t === 'memory' ? [...mem] : [...usr],
      charLimit: 10000,
      totalChars: 0,
      percentUsed: 25,
    }),
    addMemory: vi.fn(),
    removeMemoryByIndex: vi.fn(),
    clearAllMemory: vi.fn(),
    replaceMemoryByIndex: vi.fn(),
    replaceAllMemory: vi.fn(),
    clearMemory: vi.fn(),
  };
});

import { renderMemoryCard } from '../memory-topic';

describe('memory-topic — preview', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes preview JSON when MEMORY_CARD_PREVIEW=1', async () => {
    const card = await renderMemoryCard({ userId: 'U_PREVIEW', issuedAt: 1 });
    // Per-entry section (4 memory + 3 user) + 7 fixed = 14 blocks.
    expect(card.blocks.length).toBe(14);

    if (process.env.MEMORY_CARD_PREVIEW === '1') {
      const outDir = process.env.TMPDIR || '/tmp';
      const outPath = path.join(outDir, 'memory-card-preview.json');
      fs.writeFileSync(outPath, JSON.stringify({ text: card.text, blocks: card.blocks }, null, 2));
    }
  });
});
