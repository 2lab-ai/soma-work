/**
 * Boot-time sync of the local llmux codex model pin with soma-work's default.
 *
 * Why this exists. gpt-* model ids are served through llmux's codex backend,
 * and llmux PINS the upstream slug from its own config
 * (`codex.default_model` in `~/.config/llmux.json`) — the model id soma-work
 * sends is only used for backend-group ROUTING. Deploys ship the app bundle
 * but never touch host-level llmux config, so after the gpt-5.6 default flip
 * a host whose llmux still pins `gpt-5.5` would silently serve the smaller
 * model: soma-work's window math (372k, `GPT_5_6_CONTEXT_WINDOW`) would
 * overrun gpt-5.5's real 272k input cap and long sessions would hit hard
 * context-overflow errors before the harness ever compacts.
 *
 * What it does. In llmux auth mode only: read the live pin via an empty
 * partial-update POST to `{baseUrl}/llmux/codex` (all fields optional — an
 * empty body is a read), and if the pin is a stale gpt-5.5-era slug, rewrite
 * it to `GPT_5_6_UPSTREAM_SLUG`. llmux applies the change live and persists
 * it to its config file, so this is a one-shot repair per host (subsequent
 * boots see the new pin and skip). Operator-custom pins that are neither
 * gpt-5.5- nor gpt-5.6-family are respected and only logged.
 *
 * The bare `gpt-5.6` id is NOT a valid upstream slug — the ChatGPT-account
 * codex backend rejects it ("model is not supported when using Codex with a
 * ChatGPT account"; probed 2026-07-10). `gpt-5.6-sol` (flagship tier) is the
 * accepted slug, hence the mapping lives here and in llmux ≥ 0.2.16 rather
 * than in the user-facing model id.
 *
 * Fail-soft by design: any network/HTTP error returns `failed` and the
 * caller logs a warning — boot must not be blocked by a proxy hiccup. The
 * mismatch hazard then still exists, so the warning is loud and names the
 * expected pin.
 */

/**
 * Upstream codex slug that serves soma-work's `gpt-5.6` id. Must match
 * llmux's `CODEX_MODEL` compile-time default (llmux ≥ 0.2.16).
 */
export const GPT_5_6_UPSTREAM_SLUG = 'gpt-5.6-sol';

/** Stale pins this sync is allowed to overwrite (the previous generation). */
const STALE_PIN_RE = /^gpt-5\.5/i;

/** Pins that already serve the gpt-5.6 family — nothing to do. */
const CURRENT_PIN_RE = /^gpt-5\.6/i;

export interface LlmuxCodexSyncResult {
  status: 'already-current' | 'updated' | 'custom-pin-left' | 'failed';
  /** Pin observed before any write. Absent when the read itself failed. */
  before?: string;
  /** Pin after the sync (only set for `updated`). */
  after?: string;
  /** Human-readable failure detail (only set for `failed`). */
  error?: string;
}

export interface LlmuxCodexSyncOptions {
  /** llmux proxy base URL, e.g. `http://localhost:3456`. */
  baseUrl: string;
  /** Target slug override — defaults to {@link GPT_5_6_UPSTREAM_SLUG}. */
  targetSlug?: string;
  /** Injected fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms (default 3000). */
  timeoutMs?: number;
}

/**
 * Ensure the local llmux codex pin serves the gpt-5.6 family. See module doc.
 */
export async function syncLlmuxCodexModel(opts: LlmuxCodexSyncOptions): Promise<LlmuxCodexSyncResult> {
  const target = opts.targetSlug ?? GPT_5_6_UPSTREAM_SLUG;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const endpoint = `${opts.baseUrl.replace(/\/$/, '')}/llmux/codex`;

  const post = async (body: Record<string, unknown>): Promise<{ default_model?: unknown }> => {
    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${endpoint}`);
    return (await res.json()) as { default_model?: unknown };
  };

  try {
    // Empty partial update = read of the live shape (all fields optional).
    const current = await post({});
    const before = typeof current.default_model === 'string' ? current.default_model : '';

    if (CURRENT_PIN_RE.test(before)) {
      return { status: 'already-current', before };
    }
    if (!STALE_PIN_RE.test(before)) {
      // Operator pinned something deliberate (e.g. gpt-5-codex) — respect it.
      return { status: 'custom-pin-left', before };
    }

    const updated = await post({ default_model: target });
    const after = typeof updated.default_model === 'string' ? updated.default_model : '';
    if (after !== target) {
      return { status: 'failed', before, error: `pin write did not stick (got "${after}")` };
    }
    return { status: 'updated', before, after };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}
