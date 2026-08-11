import { Logger } from '../logger';
import { getLlmuxAdminKey, getLlmuxSettings } from './auth-runtime';

const logger = new Logger('LlmuxClient');

/**
 * Thin typed client for the llmux daemon's admin API
 * (https://github.com/2lab-ai/llmux, `src/proxy/server.rs`).
 *
 * Endpoints used:
 *   - `GET  /llmux/status`                        → {@link LlmuxStatus}
 *   - `POST /llmux/switch`  `{account}`           → manual account switch
 *   - `POST /llmux/add-account` `{api_key,name?}` → add an api-key account
 *   - `POST /llmux/remove-account` `{name,confirm:true}` → remove an account
 *
 * Auth: these are CONTROL-plane endpoints, which multi-tenant llmux gates on an
 * admin credential for every peer — the loopback exemption applies to the data
 * plane only. We send `getLlmuxAdminKey()` as `x-api-key`; see its doc in
 * `auth-runtime.ts` for how the admin credential is resolved.
 *
 * Every method takes an optional `baseUrl` override (the Settings modal
 * validates a *candidate* URL before persisting); default is the live
 * runtime setting.
 */

/** One `five_hour` / `seven_day` window from `/llmux/status`. */
export interface LlmuxWindow {
  /** 0..1 effective utilization (llmux emits a ratio, not a percent). */
  utilization: number;
  /** Unix epoch seconds. */
  resets_at: number;
  resets_in_secs: number;
}

/**
 * One model-scoped weekly window from `/llmux/status` (`fable_weekly` /
 * `scoped_limits[]`). Same shape as {@link LlmuxWindow} plus:
 *   - `scope_label` — present only in the generic `scoped_limits` list
 *     (e.g. `"Fable"`); `fable_weekly` omits it (it IS the Fable entry).
 *   - `severity` / `is_active` — llmux's own read of the window
 *     (`"ok" | "warning" | "critical"` etc.).
 * Additive fields — older llmux versions don't emit these at all.
 */
export interface LlmuxScopedWindow extends LlmuxWindow {
  scope_label?: string;
  severity?: string;
  is_active?: boolean;
}

export interface LlmuxAccount {
  name: string;
  /** Credential kind: 'oauth' | 'apikey' | 'codex'. */
  type: string;
  /** Backend group: 'claude' | 'codex'. */
  group?: string;
  /** 'active' | 'ok' | 'cooldown' | 'auth_failed'. */
  status: string;
  /** 1-based scheduler selection order. */
  order: number;
  /** Blocking reason for ineligible accounts, null/absent otherwise. */
  blocked?: string | null;
  five_hour?: LlmuxWindow | null;
  seven_day?: LlmuxWindow | null;
  /**
   * Model-scoped weekly windows (additive, llmux ≥ status-v2). `fable_weekly`
   * is the "Fable" entry surfaced for convenient reads; `scoped_limits` is
   * the full generic list (each entry carries `scope_label`) so future scoped
   * models appear without a schema change. Absent on older llmux.
   */
  fable_weekly?: LlmuxScopedWindow | null;
  scoped_limits?: LlmuxScopedWindow[];
  cooldown_until?: number | null;
  in_flight?: number;
  totals?: { requests: number; input_tokens: number; output_tokens: number };
}

export interface LlmuxStatus {
  version?: string;
  pid?: number;
  uptime_secs?: number;
  port?: number;
  email_anonymous?: boolean;
  /** Representative current account name (claude slot if present). */
  current: string | null;
  current_by_group?: Record<string, string>;
  accounts: LlmuxAccount[];
}

export class LlmuxClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmuxClientError';
  }
}

const DEFAULT_TIMEOUT_MS = 5_000;

async function request<T>(
  method: 'GET' | 'POST',
  pathName: string,
  opts?: { baseUrl?: string; body?: unknown; timeoutMs?: number },
): Promise<T> {
  const settings = getLlmuxSettings();
  const base = (opts?.baseUrl ?? settings.baseUrl).replace(/\/+$/, '');
  const url = `${base}${pathName}`;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`llmux ${method} ${pathName} timed out`)),
    opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        // Control-plane endpoints (`/llmux/*` except `/llmux/models`) require
        // an ADMIN credential even on loopback since llmux went multi-tenant
        // (llmux #22) — the loopback exemption only covers the data plane. So
        // send the admin key, not the data-plane one: `getLlmuxAdminKey()`
        // returns the operator-set key when there is one and otherwise falls
        // back to the co-located llmux config's `proxy.api_key` (which llmux
        // resolves to admin) when the operator left the placeholder.
        //
        // Resolved against `base`, NOT the live setting: `opts.baseUrl` (the
        // Settings modal's candidate probe) can address another host while the
        // persisted setting is still loopback, and the local llmux config's key
        // must never leave this machine.
        'x-api-key': getLlmuxAdminKey(base),
      },
      body: opts?.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      // llmux error bodies are `{"type":"error","error":{"message": …}}` —
      // surface the inner message when present.
      let detail = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } };
        if (parsed?.error?.message) detail = parsed.error.message;
      } catch {
        /* keep raw body slice */
      }
      throw new LlmuxClientError(`llmux ${method} ${pathName} → ${res.status}: ${detail}`, res.status);
    }
    return JSON.parse(text) as T;
  } catch (err) {
    if (err instanceof LlmuxClientError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new LlmuxClientError(`llmux unreachable at ${base} (${message})`);
  } finally {
    clearTimeout(timer);
  }
}

/** `GET /llmux/status` — pool snapshot: accounts, usage windows, current. */
export async function fetchLlmuxStatus(opts?: { baseUrl?: string; timeoutMs?: number }): Promise<LlmuxStatus> {
  return request<LlmuxStatus>('GET', '/llmux/status', opts);
}

/**
 * Cheap reachability probe — `true` iff `GET /llmux/status` answers 2xx
 * within the (short) timeout. Never throws.
 */
export async function isLlmuxUp(baseUrl?: string, timeoutMs = 1_500): Promise<boolean> {
  try {
    await fetchLlmuxStatus({ baseUrl, timeoutMs });
    return true;
  } catch (err) {
    logger.debug(`llmux probe failed: ${(err as Error).message}`);
    return false;
  }
}

/**
 * One entry of `GET /llmux/models` (llmux ≥ 0.2.17).
 *
 * `group` routes the id to a backend account pool (`'claude' | 'codex' |
 * 'grok'` today — future groups appear without a schema change).
 * `max_context` can be `null` (unknown) and `efforts` can be empty.
 */
export interface LlmuxModelEntry {
  id: string;
  aliases: string[];
  name: string;
  efforts: string[];
  max_context: number | null;
  group: string;
}

/**
 * `GET /llmux/models` — the model catalog llmux is willing to serve.
 * Returns the `.models` array; entries lacking a non-empty string `id` are
 * dropped (defensive — the consumer keys everything off `id`).
 */
export async function fetchLlmuxModels(opts?: { baseUrl?: string; timeoutMs?: number }): Promise<LlmuxModelEntry[]> {
  const payload = await request<{ models?: unknown }>('GET', '/llmux/models', opts);
  const models = Array.isArray(payload?.models) ? payload.models : [];
  return models.filter(
    (entry): entry is LlmuxModelEntry =>
      !!entry &&
      typeof entry === 'object' &&
      typeof (entry as { id?: unknown }).id === 'string' &&
      (entry as { id: string }).id.trim().length > 0,
  );
}

/** `POST /llmux/switch` — manual account switch. 409 → LlmuxClientError with the scheduler's refusal reason. */
export async function switchLlmuxAccount(account: string): Promise<{ ok: boolean; current: string }> {
  return request('POST', '/llmux/switch', { body: { account } });
}

/** `POST /llmux/add-account` — add (upsert) an api-key account. Name optional (server assigns `api-N`). */
export async function addLlmuxAccount(args: {
  apiKey: string;
  name?: string;
}): Promise<{ ok: boolean; name: string; type: string; added: boolean }> {
  return request('POST', '/llmux/add-account', {
    body: { api_key: args.apiKey, ...(args.name ? { name: args.name } : {}) },
  });
}

/** `POST /llmux/remove-account` — remove an account. `confirm:true` is mandatory (llmux refuses silent deletes). */
export async function removeLlmuxAccount(name: string): Promise<{ ok: boolean }> {
  return request('POST', '/llmux/remove-account', { body: { name, confirm: true } });
}
