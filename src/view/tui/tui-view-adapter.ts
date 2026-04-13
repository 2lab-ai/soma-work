/**
 * TuiViewAdapter — Terminal UI view surface stub (Issue #414)
 *
 * Implements ViewSurfaceCore only (minimal adapter).
 * TUI does NOT support editing, threading, reactions, or modals.
 *
 * Streaming approach: native stdout (direct write, no polling).
 * ResponseSession writes text to stdout as deltas arrive.
 *
 * This is designed for CLI/REPL usage where the only output
 * channel is the terminal. No external dependencies required.
 */

import type { ResponseSession } from '../response-session.js';
import type { ViewSurfaceCore } from '../surface.js';
import type { ContentBlock, ConversationTarget, FeatureSet, MessageHandle, Platform } from '../types.js';

// ─── Types ───────────────────────────────────────────────────────

/** TUI conversation reference. */
export interface TuiConversationRef {
  readonly pid: number;
}

/** TUI message reference (output has no persistent handles). */
export interface TuiMessageRef {
  readonly lineNumber: number;
}

/**
 * Writable output interface for dependency injection.
 * Defaults to process.stdout in production, replaceable in tests.
 */
export interface TuiOutput {
  write(text: string): void;
}

// ─── Helpers ────────────────────────────────────────────────────

/** Create a TUI ConversationTarget. */
export function tuiTarget(userId: string, pid?: number): ConversationTarget {
  const ref: TuiConversationRef = { pid: pid ?? process.pid };
  return { platform: 'tui', ref, userId };
}

// ─── Implementation ─────────────────────────────────────────────

export class TuiViewAdapter implements ViewSurfaceCore {
  readonly platform: Platform = 'tui';
  private lineCounter = 0;

  constructor(private output: TuiOutput = process.stdout) {}

  async postMessage(_target: ConversationTarget, blocks: readonly ContentBlock[]): Promise<MessageHandle> {
    const text = this.blocksToText(blocks);
    this.output.write(`${text}\n`);
    this.lineCounter++;

    return {
      platform: 'tui',
      ref: { lineNumber: this.lineCounter } as TuiMessageRef,
    };
  }

  beginResponse(_target: ConversationTarget): ResponseSession {
    const adapter = this;
    let completed = false;

    return {
      appendText(delta: string) {
        if (!completed) {
          adapter.output.write(delta);
        }
      },
      setStatus(phase: string) {
        if (!completed) {
          adapter.output.write(`\r[${phase}]`);
        }
      },
      replacePart(_partId: string, content: ContentBlock) {
        if (!completed && content.type === 'text') {
          adapter.output.write(`\n${content.text}`);
        }
      },
      attachFile(file) {
        if (!completed) {
          adapter.output.write(`\n[File: ${file.name}]\n`);
        }
      },
      async complete() {
        completed = true;
        adapter.output.write('\n');
        adapter.lineCounter++;
        return {
          platform: 'tui' as Platform,
          ref: { lineNumber: adapter.lineCounter } as TuiMessageRef,
        };
      },
      abort(reason?: string) {
        completed = true;
        if (reason) {
          adapter.output.write(`\n[Aborted: ${reason}]\n`);
        } else {
          adapter.output.write('\n[Aborted]\n');
        }
      },
    };
  }

  featuresFor(_target: ConversationTarget): FeatureSet {
    return {
      canEdit: false,
      canThread: false,
      canReact: false,
      canModal: false,
      canUploadFile: false,
      canEphemeral: false,
      maxMessageLength: 0, // Unlimited (terminal has no hard limit)
      maxFileSize: 0,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────

  private blocksToText(blocks: readonly ContentBlock[]): string {
    return blocks
      .map((b) => {
        if (b.type === 'text') return b.text;
        if (b.type === 'status') return `[${b.phase}]`;
        if (b.type === 'attachment') return `[File: ${b.name}]`;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
}
