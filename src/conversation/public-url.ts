/**
 * Public URL self-check.
 *
 * Every link the server hands out (Slack thread header deep links, the
 * `dashboard` sign-in link, conversation links) is built on the public URL,
 * `config.conversation.viewerUrl` (env `CONVERSATION_VIEWER_URL`). If that
 * name's DNS or proxy points at another server, every link is dead and nothing
 * notices. So the instance probes `<public URL>/health` and looks for its own
 * per-process id in the `x-soma-instance` response header.
 *
 * A mismatch is logged and reported on /health. Links move off the configured
 * URL only when the operator opted in (`SOMA_PUBLIC_URL_FALLBACK=true`) and
 * both are proven:
 *   - another server answered there (an HTTP response without our id, or with
 *     another instance's id), and
 *   - the operator's OAuth callback origin (`SOMA_OAUTH_CALLBACK_BASE_URL`)
 *     answers with our id.
 * Anything less certain — no answer, a name this host cannot resolve, an access
 * gate, a 5xx, a redirect to another host, our own /health body behind a proxy
 * that dropped the header — changes nothing, so split-horizon DNS and
 * authenticating proxies keep their links. Links return to the public URL once
 * it answers as this instance again.
 */

import { randomUUID } from 'node:crypto';
import { config } from '../config';
import { Logger } from '../logger';

const logger = new Logger('PublicUrl');

/** Response header on `/health` carrying this process's id. */
export const INSTANCE_HEADER = 'x-soma-instance';

/** Random per process: a restarted or sibling instance never matches. */
const instanceId = randomUUID();

export function getInstanceId(): string {
  return instanceId;
}

export type ProbeResult = 'verified' | 'mismatch' | 'inconclusive';

const PROBE_TIMEOUT_MS = 5000;
const MAX_SAME_HOST_REDIRECTS = 3;
/** Our /health body is under 100 bytes; reading more of a foreign body proves nothing. */
const MAX_BODY_BYTES = 4096;
const ACCESS_GATE_STATUSES = new Set([401, 403, 407]);
/** Re-check period; links return to the public URL within one period of a DNS fix. */
const PUBLIC_URL_CHECK_INTERVAL_MS = 10 * 60 * 1000;

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** True when `body` is this service's /health JSON. */
function isOwnHealthBody(body: string): boolean {
  try {
    return (JSON.parse(body) as { service?: unknown })?.service === 'conversation-viewer';
  } catch {
    return false;
  }
}

/**
 * Up to MAX_BODY_BYTES of a response body, then hang up — a foreign server
 * decides how much it sends. `failed` when the stream errors or the deadline
 * cuts it off.
 */
async function readBodyPrefix(res: Response, signal: AbortSignal): Promise<{ text: string; failed: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: '', failed: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size <= MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    return { text: '', failed: true };
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (signal.aborted) return { text: '', failed: true };
  return {
    text: Buffer.concat(chunks)
      .subarray(0, MAX_BODY_BYTES + 1)
      .toString('utf8'),
    failed: false,
  };
}

/**
 * Who answers `GET <origin>/health`. A redirect is followed only when it keeps
 * the hostname and the /health path (an http → https upgrade); never throws.
 */
export async function probeOrigin(
  origin: string,
  options: { timeoutMs?: number } = {},
): Promise<{ result: ProbeResult; detail: string }> {
  let target: URL;
  try {
    target = new URL(`${trimSlash(origin)}/health`);
  } catch {
    return { result: 'inconclusive', detail: 'invalid URL' };
  }
  const hostname = target.hostname;
  const signal = AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS);

  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetch(target, { redirect: 'manual', signal });
    } catch (error) {
      const cause = (error as { cause?: { code?: unknown } })?.cause?.code;
      return { result: 'inconclusive', detail: typeof cause === 'string' ? cause : (error as Error)?.name || 'error' };
    }

    const id = res.headers.get(INSTANCE_HEADER);
    if (id === instanceId) {
      await res.body?.cancel().catch(() => {});
      return { result: 'verified', detail: `HTTP ${res.status}` };
    }
    if (id) {
      await res.body?.cancel().catch(() => {});
      return { result: 'mismatch', detail: 'another soma-work instance answered' };
    }

    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      const location = res.headers.get('location');
      let next: URL | null = null;
      try {
        next = location ? new URL(location, target) : null;
      } catch {
        next = null;
      }
      if (next && next.hostname === hostname && next.pathname === '/health' && hop < MAX_SAME_HOST_REDIRECTS) {
        target = next;
        continue;
      }
      return { result: 'inconclusive', detail: `HTTP ${res.status} redirect away from ${hostname}/health` };
    }

    if (ACCESS_GATE_STATUSES.has(res.status)) {
      await res.body?.cancel().catch(() => {});
      return { result: 'inconclusive', detail: `HTTP ${res.status} access gate` };
    }
    if (res.status >= 500) {
      await res.body?.cancel().catch(() => {});
      return { result: 'inconclusive', detail: `HTTP ${res.status} (proxy upstream down?)` };
    }

    const body = await readBodyPrefix(res, signal);
    // A body cut off by a reset or the deadline proves nothing about who answered.
    if (body.failed) return { result: 'inconclusive', detail: 'response body cut off' };
    if (isOwnHealthBody(body.text)) {
      return { result: 'inconclusive', detail: `${INSTANCE_HEADER} header missing (dropped by a proxy?)` };
    }
    return { result: 'mismatch', detail: `HTTP ${res.status} from another server` };
  }
}

type PublicUrlStatus = 'unchecked' | 'verified' | 'mismatch';

let status: PublicUrlStatus = 'unchecked';
/** The proven origin links use while the public URL is a mismatch; '' = none. */
let fallback = '';
let timer: ReturnType<typeof setInterval> | null = null;
/** Last probe result of the public URL; logs inconclusive spells once. */
let lastResult: ProbeResult | null = null;

/** Result of the last conclusive check of the public URL. */
export function getPublicUrlStatus(): PublicUrlStatus {
  return status;
}

/**
 * The public base URL links and origin checks use: the configured one, unless
 * the last check proved it reaches another server and proved the callback
 * origin reaches this one.
 */
export function effectiveViewerUrl(): string {
  const configured = config.conversation.viewerUrl || '';
  if (configured && status === 'mismatch' && fallback) return fallback;
  return configured;
}

/** True when cookies should carry `Secure` (the effective origin is https). */
export function isSecureViewerOrigin(): boolean {
  try {
    return new URL(effectiveViewerUrl()).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Probe the public URL (and, if it is a mismatch, the callback origin) once. */
export async function checkPublicUrl(): Promise<void> {
  const configured = config.conversation.viewerUrl || '';
  if (!configured) return;

  const probe = await probeOrigin(configured);
  if (probe.result === 'inconclusive') {
    if (lastResult !== 'inconclusive') {
      const keeps = status === 'mismatch' ? 'keeping the previous decision' : 'links keep using it';
      logger.warn(`Could not confirm that ${configured} reaches this instance (${probe.detail}); ${keeps}`);
    }
    lastResult = 'inconclusive';
    return;
  }
  lastResult = probe.result;

  if (probe.result === 'verified') {
    if (status === 'mismatch') {
      logger.info(`Public URL ${configured} reaches this instance again; links use it`);
    }
    status = 'verified';
    fallback = '';
    return;
  }

  const callbackBase = trimSlash(config.oauth.callbackBaseUrl || '');
  const optedIn = !!config.conversation.publicUrlFallback;
  let nextFallback = '';
  if (optedIn && callbackBase && callbackBase !== trimSlash(configured)) {
    const callback = (await probeOrigin(callbackBase)).result;
    // An uncertain answer keeps an established fallback; only proof drops it.
    if (callback === 'verified' || (callback === 'inconclusive' && fallback === callbackBase)) {
      nextFallback = callbackBase;
    }
  }

  if (status !== 'mismatch' || nextFallback !== fallback) {
    const using = nextFallback
      ? `links use ${nextFallback} (SOMA_OAUTH_CALLBACK_BASE_URL) until it does`
      : optedIn
        ? 'no other origin is proven to reach this instance, so links keep using it'
        : 'links keep using it (set SOMA_PUBLIC_URL_FALLBACK=true to move them to a proven SOMA_OAUTH_CALLBACK_BASE_URL)';
    logger.error(
      `Public URL ${configured} does not reach this instance (${probe.detail}); ${using}. Fix its DNS or proxy, or CONVERSATION_VIEWER_URL.`,
    );
  }
  status = 'mismatch';
  fallback = nextFallback;
}

/** Check now and every PUBLIC_URL_CHECK_INTERVAL_MS until stopped. */
export function startPublicUrlCheck(): void {
  stopPublicUrlCheck();
  if (!config.conversation.viewerUrl) return;
  void checkPublicUrl();
  timer = setInterval(() => void checkPublicUrl(), PUBLIC_URL_CHECK_INTERVAL_MS);
  timer.unref?.();
}

export function stopPublicUrlCheck(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
