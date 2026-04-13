/**
 * TuiViewAdapter tests (Issue #414)
 */

import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '../types.js';
import { type TuiMessageRef, type TuiOutput, TuiViewAdapter, tuiTarget } from './tui-view-adapter.js';

// ─── Helpers ────────────────────────────────────────────────────

function createMockOutput(): TuiOutput & { buffer: string } {
  const output = {
    buffer: '',
    write(text: string) {
      output.buffer += text;
    },
  };
  return output;
}

// ─── Tests ───────────────────────────────────────────────────────

describe('TuiViewAdapter', () => {
  it('reports platform as tui', () => {
    const output = createMockOutput();
    const adapter = new TuiViewAdapter(output);
    expect(adapter.platform).toBe('tui');
  });

  describe('tuiTarget', () => {
    it('creates target with default pid', () => {
      const target = tuiTarget('U001');
      expect(target.platform).toBe('tui');
      expect(target.userId).toBe('U001');
    });

    it('creates target with custom pid', () => {
      const target = tuiTarget('U001', 12345);
      expect((target.ref as { pid: number }).pid).toBe(12345);
    });
  });

  describe('featuresFor', () => {
    it('returns minimal capabilities', () => {
      const output = createMockOutput();
      const adapter = new TuiViewAdapter(output);
      const target = tuiTarget('U001');
      const features = adapter.featuresFor(target);

      expect(features.canEdit).toBe(false);
      expect(features.canThread).toBe(false);
      expect(features.canReact).toBe(false);
      expect(features.canModal).toBe(false);
      expect(features.canUploadFile).toBe(false);
      expect(features.canEphemeral).toBe(false);
      expect(features.maxMessageLength).toBe(0); // Unlimited
    });
  });

  describe('postMessage', () => {
    it('writes text to output', async () => {
      const output = createMockOutput();
      const adapter = new TuiViewAdapter(output);
      const target = tuiTarget('U001');
      const blocks: ContentBlock[] = [{ type: 'text', text: 'Hello TUI!' }];

      const handle = await adapter.postMessage(target, blocks);

      expect(output.buffer).toBe('Hello TUI!\n');
      expect(handle.platform).toBe('tui');
    });

    it('renders multiple blocks', async () => {
      const output = createMockOutput();
      const adapter = new TuiViewAdapter(output);
      const target = tuiTarget('U001');
      const blocks: ContentBlock[] = [
        { type: 'text', text: 'Line 1' },
        { type: 'status', phase: 'Processing' },
        { type: 'text', text: 'Line 2' },
      ];

      await adapter.postMessage(target, blocks);

      expect(output.buffer).toBe('Line 1\n[Processing]\nLine 2\n');
    });

    it('renders attachment blocks as file name', async () => {
      const output = createMockOutput();
      const adapter = new TuiViewAdapter(output);
      const target = tuiTarget('U001');
      const blocks: ContentBlock[] = [{ type: 'attachment', name: 'data.csv', data: 'content', mimeType: 'text/csv' }];

      await adapter.postMessage(target, blocks);

      expect(output.buffer).toBe('[File: data.csv]\n');
    });

    it('increments line counter', async () => {
      const output = createMockOutput();
      const adapter = new TuiViewAdapter(output);
      const target = tuiTarget('U001');

      const h1 = await adapter.postMessage(target, [{ type: 'text', text: 'First' }]);
      const h2 = await adapter.postMessage(target, [{ type: 'text', text: 'Second' }]);

      expect((h1.ref as TuiMessageRef).lineNumber).toBe(1);
      expect((h2.ref as TuiMessageRef).lineNumber).toBe(2);
    });
  });

  describe('beginResponse', () => {
    it('streams text deltas to output', async () => {
      const output = createMockOutput();
      const adapter = new TuiViewAdapter(output);
      const target = tuiTarget('U001');

      const session = adapter.beginResponse(target);
      session.appendText('Hello ');
      session.appendText('world');
      await session.complete();

      expect(output.buffer).toBe('Hello world\n');
    });

    it('shows status inline', () => {
      const output = createMockOutput();
      const adapter = new TuiViewAdapter(output);
      const session = adapter.beginResponse(tuiTarget('U001'));

      session.setStatus('Thinking');

      expect(output.buffer).toContain('[Thinking]');
    });

    it('shows file attachment notification', () => {
      const output = createMockOutput();
      const adapter = new TuiViewAdapter(output);
      const session = adapter.beginResponse(tuiTarget('U001'));

      session.attachFile({ name: 'output.txt', data: 'content', mimeType: 'text/plain' });

      expect(output.buffer).toContain('[File: output.txt]');
    });

    it('does not append text after complete', async () => {
      const output = createMockOutput();
      const adapter = new TuiViewAdapter(output);
      const session = adapter.beginResponse(tuiTarget('U001'));

      session.appendText('Hello');
      await session.complete();
      session.appendText(' world');

      expect(output.buffer).toBe('Hello\n');
    });

    it('shows abort reason', () => {
      const output = createMockOutput();
      const adapter = new TuiViewAdapter(output);
      const session = adapter.beginResponse(tuiTarget('U001'));

      session.appendText('Start');
      session.abort('error occurred');

      expect(output.buffer).toContain('[Aborted: error occurred]');
    });

    it('shows generic abort without reason', () => {
      const output = createMockOutput();
      const adapter = new TuiViewAdapter(output);
      const session = adapter.beginResponse(tuiTarget('U001'));

      session.abort();

      expect(output.buffer).toContain('[Aborted]');
    });

    it('replaces part with text content', () => {
      const output = createMockOutput();
      const adapter = new TuiViewAdapter(output);
      const session = adapter.beginResponse(tuiTarget('U001'));

      session.replacePart('tool-output', { type: 'text', text: 'Tool result here' });

      expect(output.buffer).toContain('Tool result here');
    });
  });
});
