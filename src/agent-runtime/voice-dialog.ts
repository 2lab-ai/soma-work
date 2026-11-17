/**
 * Voice dialog — one long-lived Agent SDK `query()` for one phone call (.prd/31-phone-calls-architecture.md §3.1).
 *
 * The call's turns arrive as a stream of user messages (the other party's transcribed words, and the call
 * system's own `[시스템: …]` cues); the replies stream back as text deltas so the phone can start speaking at the
 * end of the first sentence. One CLI process lives for the whole call, so a turn pays no spawn cost. Auth is the
 * caller's: it passes `env` from `buildQueryEnv(lease, { llmuxTenant })` — the same path every soma-work model
 * call takes (rules/auth.md).
 *
 * The call agent's only tools are the ones the phone gives it (`hang_up`, `send_dtmf`), served in process.
 */

import {
  createSdkMcpServer,
  type Options,
  query,
  type SDKMessage,
  type SDKUserMessage,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { createTrackedClaudeProcessSpawner } from './claude-child-process-registry';

export const VOICE_DIALOG_SERVER = 'phone';

export interface VoiceDialogTool {
  name: string;
  description: string;
  /** Plain string parameters only — the phone's tools need nothing richer. */
  params: Record<string, { description: string; optional?: boolean }>;
  handler: (args: Record<string, string>) => Promise<string>;
}

export interface VoiceDialogOptions {
  model: string;
  systemPrompt: string;
  env: Record<string, string | undefined>;
  effort?: string;
  tools: VoiceDialogTool[];
  onStderr?: (line: string) => void;
}

export type VoiceDialogEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'assistant'; text: string; model?: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'turn_end'; isError: boolean; message?: string }
  | { type: 'closed'; message?: string };

export interface VoiceDialog {
  /** Queue one user message. `false` once the dialog is closed. */
  send(text: string): boolean;
  /** Stop the reply being written now (barge-in). The dialog stays open. */
  interrupt(): Promise<void>;
  /** End the dialog: the input stream closes and the CLI exits. */
  close(): void;
  readonly events: AsyncIterable<VoiceDialogEvent>;
}

/** An async queue of user messages the SDK reads as its prompt. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private wake?: () => void;
  closed = false;

  push(text: string): boolean {
    if (this.closed) return false;
    this.items.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    } as SDKUserMessage);
    this.wake?.();
    return true;
  }

  /** No more input: what is still queued is dropped (the call is over), and the iterator ends. */
  close(): void {
    this.closed = true;
    this.items.length = 0;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      const next = this.items.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: 'text'; text: string } => !!b && (b as { type?: string }).type === 'text')
    .map((b) => b.text)
    .join('');
}

/** Map one SDK message to the dialog's events (exported for tests). */
export function dialogEventsOf(message: SDKMessage): VoiceDialogEvent[] {
  if (message.type === 'stream_event') {
    const ev = (message as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
      return [{ type: 'text_delta', text: ev.delta.text }];
    }
    return [];
  }
  if (message.type === 'assistant') {
    const msg = (message as { message?: { content?: unknown; model?: string } }).message;
    const out: VoiceDialogEvent[] = [];
    const text = textOf(msg?.content);
    if (text) out.push({ type: 'assistant', text, model: msg?.model });
    if (Array.isArray(msg?.content)) {
      for (const block of msg.content as Array<{ type?: string; name?: string; input?: unknown }>) {
        if (block?.type === 'tool_use' && block.name)
          out.push({ type: 'tool_use', name: block.name, input: block.input });
      }
    }
    return out;
  }
  if (message.type === 'result') {
    const r = message as { is_error?: boolean; subtype?: string; errors?: unknown };
    const errors = Array.isArray(r.errors) ? r.errors.filter((e): e is string => typeof e === 'string') : [];
    return [{ type: 'turn_end', isError: !!r.is_error, message: errors.join('\n') || undefined }];
  }
  return [];
}

export function openVoiceDialog(opts: VoiceDialogOptions): VoiceDialog {
  const input = new InputQueue();
  const server = createSdkMcpServer({
    name: VOICE_DIALOG_SERVER,
    tools: opts.tools.map((t) => {
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, p] of Object.entries(t.params)) {
        shape[key] = p.optional ? z.string().optional().describe(p.description) : z.string().describe(p.description);
      }
      return tool(t.name, t.description, shape, async (args: Record<string, unknown>) => {
        const clean: Record<string, string> = {};
        for (const [k, v] of Object.entries(args ?? {})) if (typeof v === 'string') clean[k] = v;
        const text = await t.handler(clean);
        return { content: [{ type: 'text' as const, text }] };
      });
    }),
  });
  const options: Options = {
    model: opts.model,
    systemPrompt: opts.systemPrompt,
    tools: [],
    mcpServers: { [VOICE_DIALOG_SERVER]: server },
    allowedTools: opts.tools.map((t) => `mcp__${VOICE_DIALOG_SERVER}__${t.name}`),
    includePartialMessages: true,
    settingSources: [],
    plugins: [],
    persistSession: false,
    thinking: { type: 'disabled' },
    env: opts.env,
    stderr: opts.onStderr,
    spawnClaudeCodeProcess: createTrackedClaudeProcessSpawner(opts.onStderr),
    ...(opts.effort ? { effort: opts.effort as Options['effort'] } : {}),
  };
  const q = query({ prompt: input, options });

  const events: AsyncIterable<VoiceDialogEvent> = {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const message of q) {
          for (const ev of dialogEventsOf(message)) yield ev;
        }
        yield { type: 'closed' };
      } catch (err) {
        yield { type: 'closed', message: (err as Error).message };
      } finally {
        input.close(); // the stream is over (the CLI ended or died): nothing more is sent into it
      }
    },
  };

  return {
    send: (text) => input.push(text),
    interrupt: async () => {
      try {
        await q.interrupt();
      } catch {
        // Nothing was running, or the CLI is gone: either way there is nothing left to stop.
      }
    },
    // Ending the input is only EOF — a reply being written would still finish, with its CLI. The call is over, so
    // the query is closed too: process, MCP transport and pending requests go now.
    close: () => {
      input.close();
      try {
        q.close();
      } catch {
        // Already gone.
      }
    },
    events,
  };
}
