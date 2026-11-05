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
import { parseSafeguardFlag, safeguardFlagOf } from '@soma/common/safeguard';
import { isSdkEffortLevel } from 'soma-lib';
import type { AgentRunOptions } from './agent-runner';
import { createTrackedClaudeProcessSpawner } from './claude-child-process-registry';

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
  const sdk: Options = {
    model: opts.model,
    maxTurns: opts.maxTurns,
    systemPrompt: opts.systemPrompt,
    tools: opts.tools ?? [],
    settingSources: (ext.settingSources as Options['settingSources']) ?? [],
    plugins: (ext.plugins as Options['plugins']) ?? [],
    env: ext.env,
    thinking: ext.thinking as Options['thinking'],
    stderr: ext.stderr,
    spawnClaudeCodeProcess: createTrackedClaudeProcessSpawner(ext.stderr),
  };
  // One-shot dispatch knobs (#model-call-unify) — only set when supplied so the
  // existing one-shot helpers' SDK Options stay byte-for-byte unchanged.
  // `ultra` (the goal evaluator matching an ultra work session) is not a CLI `--effort` value and no backend takes
  // it on the wire: it runs as `max`, the strongest level (build-stream-options does the same).
  if (ext.effort !== undefined) sdk.effort = (isSdkEffortLevel(ext.effort) ? ext.effort : 'max') as Options['effort'];
  if (ext.cwd !== undefined) sdk.cwd = ext.cwd;
  if (ext.abortController !== undefined) sdk.abortController = ext.abortController;
  if (ext.resume !== undefined) sdk.resume = ext.resume;
  if (ext.forkSession !== undefined) sdk.forkSession = ext.forkSession;
  return sdk;
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
  let resultErrors: string[] = [];
  /**
   * An Anthropic safeguards block (#904), seen in one assistant message on its
   * own — never hidden behind text an earlier message wrote (review R6, astra
   * P1). The query stops at it, and it is thrown: every caller (dispatch
   * classifier, permission guardian, goal eval) halts the session on it.
   */
  let blocked: string | undefined;
  try {
    for await (const message of query({ prompt, options })) {
      if (message.type === 'assistant' && message.message?.content) {
        let messageText = '';
        for (const block of message.message.content) {
          if (block.type === 'text') {
            messageText += block.text;
          }
        }
        if (parseSafeguardFlag(messageText)) {
          blocked = messageText;
          break; // stop the query at the block
        }
        assistantText += messageText;
      } else if (message.type === 'result') {
        const errors = (message as { errors?: unknown }).errors;
        if (Array.isArray(errors)) resultErrors = errors.filter((e): e is string => typeof e === 'string');
      }
    }
  } catch (error) {
    // A thrown safeguards block outranks any text collected before it.
    if (!blocked && safeguardFlagOf(error)) throw error;
    // Resilience (preserved from the former dispatchOneShot inline loop): if the
    // SDK child died (e.g. SIGTERM / exit 143) AFTER emitting usable assistant
    // text, the response is effectively complete — return it. Only rethrow when
    // nothing was collected. Callers still do their own parse/validation.
    if (!blocked) {
      if (assistantText.trim()) return assistantText;
      throw error;
    }
  }
  if (blocked) throw new Error(blocked);
  // An Anthropic safeguards block delivered in the result's errors[] is the
  // answer whatever text came before it: surface it as the error it is, so
  // the caller locks the session instead of reading the partial text.
  if (resultErrors.length > 0) {
    const joined = resultErrors.join('\n');
    if (parseSafeguardFlag(joined, { source: 'error' })) throw new Error(joined);
  }
  return assistantText;
}
