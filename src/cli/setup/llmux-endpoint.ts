/**
 * What counts as an llmux endpoint somawork will talk to.
 *
 * ## Why this is its own module
 *
 * Three modules need the same answer and they form a cycle if any two of them
 * own it: `doctor.ts` probes the endpoint, `materialize.ts` writes it into the
 * profile's `.env`, and `setup/llmux.ts` learns it from `llmux env` — and
 * `doctor.ts` already imports both of the others. So the rule lives here, in a
 * leaf with no repository imports at all, and every caller reaches the same
 * gate rather than re-deriving a weaker one.
 *
 * `doctor.ts` re-exports these three names, which is where they were first
 * written and where existing callers still import them from.
 */

/**
 * llmux's *default* port, as a base URL. **Nothing in production reads it.**
 *
 * It is not a fallback and there is no code path that treats it as one. Setup
 * learns the real endpoint from `llmux env` (`./llmux`), the materializer takes
 * it as a required input (`./materialize`), and `doctor` refuses rather than
 * guess — the three places that could plausibly want a default all have a
 * better answer, which is the point: a machine whose 3456 is already taken runs
 * llmux on another port, so this value is right only by coincidence.
 *
 * It survives solely to keep the pre-existing public export/import site alive:
 * `doctor.ts` imports it and re-exports it under its own name, which is where
 * it was first defined and where out-of-tree importers still reach it. Removing
 * it would be an API break for no gain. Only tests read it today, and what they
 * assert is precisely that it is *not* reachable as a doctor fallback.
 *
 * The literal is llmux's shipped `proxy.port` (`llmux` `src/cli/mod.rs:544`
 * builds `http://localhost:<proxy.port>`, and 3456 is the shipped default).
 * Do not make anything depend on it.
 */
export const DEFAULT_LLMUX_BASE_URL = 'http://localhost:3456';

/** Hosts a v1 llmux endpoint may name. `URL` renders IPv6 hostnames bracketed. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Raised when no usable llmux endpoint can be had: a profile, an override, or a
 * child process named one that is not a supported local address, **or** named
 * none at all.
 *
 * One phrase covers both origins, and it is phrased for the weaker of the two.
 * "The profile names an endpoint that is not supported" is simply false when
 * the profile names nothing — it sends an operator looking for a line that is
 * not in the file — while "none is configured" is true of an absent line and of
 * a line naming `https://evil.example.com`, which somawork does not accept and
 * therefore has not configured.
 *
 * Carries no URL and no path — not in the message, not in a field. The offending
 * value came from a file or a child an attacker may control, and it must not be
 * echoed into a report, a log, or an exception that some future handler decides
 * to print. Distinguishing "absent" from "rejected" in the message would leak
 * that distinction for free; the operator's next move (make the profile name a
 * loopback http origin) is the same either way.
 */
export class LlmuxEndpointError extends Error {
  constructor() {
    super('No supported local llmux endpoint is configured for this profile.');
    this.name = 'LlmuxEndpointError';
  }
}

/**
 * Accept only a plain loopback HTTP endpoint.
 *
 * This gate exists because of what the callers do next: `fetchLlmuxStatus`
 * sends `x-api-key: getLlmuxAdminKey(base)`, and `getLlmuxAdminKey` returns the
 * operator-set ambient key *before* its own loopback test (that test only
 * guards the llmux-config-file fallback). So an unvalidated destination read
 * out of a file is an outbound credential surface: whoever writes
 * `ANTHROPIC_BASE_URL` into the profile's `.env` chooses where the operator's
 * llmux admin key is POSTed. The materializer is the same decision one step
 * earlier — it is what *writes* that line.
 *
 * Refused, each for its own reason:
 * - a non-`http:` scheme — v1 talks to a local daemon; `https://evil.example`
 *   is the whole attack in one line;
 * - any host but `localhost` / `127.0.0.1` / `::1` — note `localhost.evil.com`
 *   passes a naive `startsWith`/`includes` check and is a real registrable
 *   domain;
 * - userinfo (`http://user:pass@localhost`) — credentials in a URL, and a
 *   parser-confusion vector;
 * - a path, query, or fragment — the client appends `/llmux/status`, so
 *   anything here is either dead weight or an attempt to reshape the request;
 * - a port outside 1..65535.
 *
 * Returns the parsed **origin**, not the caller's string. `search` and `hash`
 * are tested with `!== ''` and a bare delimiter parses to empty, so
 * `http://localhost:3456/?` and `.../#` pass validation — and the client then
 * builds `http://localhost:3456/?/llmux/status`, dialing `/` with the real
 * path as a query and reporting a healthy daemon dead. Returning the origin
 * makes the string that was validated the string that is sent, which closes
 * that class rather than special-casing its two instances.
 */
export function validateLlmuxBaseUrl(candidate: string): string {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new LlmuxEndpointError();
  }
  if (url.protocol !== 'http:') throw new LlmuxEndpointError();
  if (!LOOPBACK_HOSTS.has(url.hostname)) throw new LlmuxEndpointError();
  if (url.username !== '' || url.password !== '') throw new LlmuxEndpointError();
  if (url.pathname !== '' && url.pathname !== '/') throw new LlmuxEndpointError();
  if (url.search !== '' || url.hash !== '') throw new LlmuxEndpointError();
  if (url.port !== '') {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new LlmuxEndpointError();
  }
  return url.origin;
}
