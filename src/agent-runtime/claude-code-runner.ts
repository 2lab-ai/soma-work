/**
 * Claude Code SDK adapter (ADR 0002, pass 1).
 *
 * This file is the *only* runtime importer of `@anthropic-ai/claude-agent-sdk`
 * for one-shot text generation. The dependency boundary is enforced by
 * `src/agent-runtime/__tests__/boundary.test.ts`.
 *
 * Future passes will add sibling adapters (e.g. `acp-runner.ts`) and a
 * dispatcher in `runner.ts` that picks between them. Pass 1 has only one
 * implementation.
 */

import { type Options, query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRunOptions } from './agent-runner';

/**
 * Map portable {@link AgentRunOptions} to the SDK's {@link Options} shape.
 *
 * Exported separately so unit tests can pin the mapping without spinning
 * up the SDK child process. Defaults match what the migrated helpers used
 * to set inline:
 *   • `tools: []`            — one-shot text, no tool calls.
 *   • `settingSources: []`   — no local plugin layering.
 *   • `plugins: []`          — no plugin directory mounts.
 * Override via `extensions.claudeCode` to deviate.
 */
export function toSdkOptions(opts: AgentRunOptions): Options {
  const ext = opts.extensions?.claudeCode ?? {};
  return {
    model: opts.model,
    maxTurns: opts.maxTurns,
    systemPrompt: opts.systemPrompt,
    tools: opts.tools ?? [],
    settingSources: (ext.settingSources as Options['settingSources']) ?? [],
    plugins: (ext.plugins as Options['plugins']) ?? [],
    env: ext.env,
    thinking: ext.thinking as Options['thinking'],
    stderr: ext.stderr,
  };
}

/**
 * Run a 1-turn text completion against the Claude Code SDK and return the
 * accumulated assistant-message text.
 *
 * Behavior preserved verbatim from the pre-refactor helpers:
 *   • Only `message.type === 'assistant'` content is consumed.
 *   • Only `block.type === 'text'` blocks are concatenated.
 *   • System / result / user messages are silently ignored.
 *   • No trimming, no JSON parsing — callers handle their own
 *     post-processing.
 */
export async function runOneShotTextClaudeCode(prompt: string, opts: AgentRunOptions): Promise<string> {
  const options = toSdkOptions(opts);
  let assistantText = '';
  for await (const message of query({ prompt, options })) {
    if (message.type === 'assistant' && message.message?.content) {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          assistantText += block.text;
        }
      }
    }
  }
  return assistantText;
}
