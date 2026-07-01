/**
 * The default `memory` Block Kit card must surface the NEW hierarchical
 * (taxonomy) memory — pages + episodic — not only the flat L1 entries.
 * Regression for: "memory 치면 아직도 옛날 메모리가 나온다".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  return { TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-memcard-hier-${process.pid}`) };
});

vi.mock('../../../../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));

import { hierarchicalMemoryStore } from '../../../../hierarchical-memory';
import { addMemory } from '../../../../user-memory-store';
import { renderMemoryCard } from '../memory-topic';

const user = 'U_card';

function cardText(blocks: unknown[]): string {
  return JSON.stringify(blocks);
}

describe('renderMemoryCard — includes hierarchical memory', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });
  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('shows a hierarchical section listing pages alongside flat L1', async () => {
    // flat L1
    addMemory(user, 'memory', 'flat agent note one');
    // hierarchical page
    hierarchicalMemoryStore.upsertPage(
      user,
      { type: 'agent', slug: 'build-system' },
      { title: 'Build system', current: 'bun' },
    );

    const { blocks } = await renderMemoryCard({ userId: user, issuedAt: Date.now() });
    const text = cardText(blocks);

    // flat L1 still present
    expect(text).toContain('flat agent note one');
    // NEW hierarchical section present with the page
    expect(text).toContain('계층형 메모리 (신규)');
    expect(text).toContain('agent/build-system');
    expect(text).toContain('memory pages');
  });

  it('shows an empty-hierarchical hint when there are no pages yet', async () => {
    addMemory(user, 'memory', 'only flat');
    const { blocks } = await renderMemoryCard({ userId: user, issuedAt: Date.now() });
    const text = cardText(blocks);
    expect(text).toContain('계층형 메모리 (신규)');
    expect(text).toContain('아직 비어있음');
  });

  it('stays within the Block Kit 50-block cap', async () => {
    for (let i = 0; i < 5; i++) addMemory(user, 'memory', `note ${i}`);
    hierarchicalMemoryStore.upsertPage(user, { type: 'sites', slug: 'x' }, { title: 'X' });
    const { blocks } = await renderMemoryCard({ userId: user, issuedAt: Date.now() });
    expect(blocks.length).toBeLessThanOrEqual(50);
  });
});
