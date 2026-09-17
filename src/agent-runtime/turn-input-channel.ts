/**
 * Streaming-input plumbing for a single agent turn (user-steering WU1).
 *
 * A turn used to be driven as `query({ prompt: '<text>' })` — single-prompt
 * mode, where the CLI takes one string, answers, and exits. That mode has two
 * costs the steering feature cannot pay: nothing can be added to the turn once
 * it started, and control requests (`interrupt`, `cancel_async_message`) are
 * "only supported when streaming input/output is used"
 * (`@anthropic-ai/claude-agent-sdk` sdk.d.ts:2522-2536).
 *
 * `TurnInputChannel` is the minimal `AsyncIterable<SDKUserMessage>` that buys
 * both: it yields the turn's opening user message, then anything the host
 * `push()`es while the turn runs (the CLI delivers those at the next tool-call
 * boundary, inside the SAME turn), and it ends only when the host `close()`s
 * it. `ClaudeHandler` closes it on the turn's `result` frame, so "one turn per
 * `query()`" is preserved — the CLI process still dies with the turn.
 *
 * Backpressure: none by design. The queue is an unbounded array because the
 * producer is a human typing into Slack; a bounded queue would drop or block a
 * user message, which is the one thing steering must never do.
 *
 * Adapter zone: may import the SDK types (type-only).
 */

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/** The wire shape pushed through the channel (the SDK's streaming-input item). */
export type SteerUserMessage = SDKUserMessage;

/** One image attachment carried by a steered message. */
export interface SteerImage {
  /** e.g. `image/png` — passed through to the Messages API `source.media_type`. */
  mediaType: string;
  /** Base64 payload without a data-URL prefix. */
  base64: string;
}

/**
 * A user message injected into a running turn.
 *
 * `uuid` is host-minted and is the join key for everything that follows: the
 * SDK stamps it back on the turn's first reply frame and on the `result`
 * (`user_message_uuid`), and it is the handle `cancel_async_message` takes.
 */
export interface SteerInput {
  uuid: string;
  text: string;
  images?: SteerImage[];
}

/**
 * The receipt of an interrupt, normalized to camelCase.
 *
 * `stillQueued` are uuids that SURVIVE the interrupt and will still run unless
 * cancelled individually; `cancelled` is populated only when the CLI supports
 * the `interrupt_cancel_queued_v1` capability (sdk.d.ts:3940-3948).
 */
export interface SteerInterruptReceipt {
  stillQueued: string[];
  cancelled: string[];
}

/**
 * Host-facing steering surface. Declared here (not on `ClaudeHandler`) so
 * consumers such as `V1QueryAdapter` can depend on the capability without
 * importing the handler or the SDK.
 */
export interface TurnSteeringPort {
  steerTurn(sessionKey: string, input: SteerInput): boolean;
  interruptTurn(sessionKey: string): Promise<SteerInterruptReceipt | undefined>;
  cancelSteeredMessage(sessionKey: string, uuid: string): Promise<boolean>;
}

/** Build the opening message of a streaming-input turn from the prompt text. */
export function buildInitialUserMessage(prompt: string): SteerUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: prompt },
    parent_tool_use_id: null,
  };
}

/**
 * Build a steered user message.
 *
 * `shouldQuery` is deliberately left UNSET: absent means "this message drives a
 * turn" (sdk.d.ts:5176 — `false` would only append it to the transcript and
 * defer it to the next querying message, which is not what a user pressing
 * enter mid-turn means).
 */
export function buildSteerUserMessage(input: SteerInput): SteerUserMessage {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: input.text }];
  for (const image of input.images ?? []) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
    });
  }
  return {
    type: 'user',
    message: { role: 'user', content: content as never },
    parent_tool_use_id: null,
    uuid: input.uuid as SteerUserMessage['uuid'],
  };
}

/**
 * Single-consumer async queue handed to `query()` as its `prompt`.
 *
 * Single-consumer is not a limitation to work around: the only consumer is the
 * SDK transport for one turn. A second iterator would steal messages from the
 * CLI, so the class is used exactly once per turn and discarded with it.
 */
export class TurnInputChannel implements AsyncIterable<SteerUserMessage> {
  private readonly queue: SteerUserMessage[] = [];
  /**
   * Uuids of the messages pushed into this turn, in push order — the ledger the
   * host settles against on the turn's `result` (spec §6 item 6). The initial
   * message is never listed: it opened the turn rather than being steered into
   * it, so it has no queue item to settle.
   */
  private readonly pushed: string[] = [];
  private closed = false;
  /** Resolver of the promise a parked consumer is waiting on, if any. */
  private wake?: () => void;

  constructor(initial: SteerUserMessage) {
    this.queue.push(initial);
  }

  /** `true` once `close()` ran — pushes are refused from that point on. */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Enqueue a message for the running turn. Returns `false` when the channel is
   * already closed (the turn ended); the caller must then treat the message as
   * undelivered rather than assume the agent saw it.
   */
  push(message: SteerUserMessage): boolean {
    if (this.closed) return false;
    this.queue.push(message);
    const uuid = (message as { uuid?: unknown }).uuid;
    if (typeof uuid === 'string' && uuid.length > 0) {
      this.pushed.push(uuid);
    }
    this.release();
    return true;
  }

  /**
   * The uuids accepted by {@link push}, in order. A copy: the caller settles
   * against this list (and may reorder/filter it) without editing the ledger.
   */
  pushedUuids(): string[] {
    return [...this.pushed];
  }

  /**
   * End the input stream. Already-queued messages are still delivered; the
   * iterator then completes, which is what lets the CLI child exit.
   * Idempotent.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.release();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SteerUserMessage, void, unknown> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift() as SteerUserMessage;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private release(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}
