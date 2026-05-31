/**
 * Slack Socket-Mode watchdog.
 *
 * Bolt's `@slack/socket-mode` handles transient WebSocket drops with an
 * internal reconnect loop, but has no escape hatch when that loop never
 * recovers (HTTP 408 on the WSS upgrade, pong-timeout cycles). In that
 * state the Node process and the Claude SDK stay alive, but inbound Slack
 * events stop reaching SlackHandler — the bot looks dead.
 *
 * This watchdog observes the SocketModeClient EventEmitter and trips
 * `onUnhealthy()` so the host can `process.exit(1)`; the supervisor
 * (launchd / systemd) then recycles the process. Three triggers:
 *   - `reconnect-storm`: N consecutive `reconnecting` without an
 *     intervening `connected`.
 *   - `stale-inbound`: no `slack_event` for `stalenessMs` while not
 *     Connected. The not-Connected gate is critical — quiet channels on
 *     a healthy socket are not a symptom. Both `reconnecting` and
 *     `disconnected` count as not-Connected; only `connected` clears it.
 *   - `unrecoverable-start`: the `unable_to_socket_mode_start` event
 *     (UnrecoverableSocketModeStartError path).
 *
 * Initial-state caveat: this watchdog is wired AFTER `app.start()` resolves
 * (so boot reconnects don't count against the storm threshold). By then the
 * socket has already emitted its first `connected`, which this watchdog can
 * never observe. Callers that wire post-connect MUST pass
 * `initiallyConnected: true`; otherwise `socketConnected` stays `false` on a
 * perfectly healthy-but-quiet socket and the stale-inbound gate fires every
 * `stalenessMs`, killing the process in a restart loop.
 */

export type SocketWatchdogUnhealthyReason = 'reconnect-storm' | 'stale-inbound' | 'unrecoverable-start';

export interface SocketLikeEmitter {
  on(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
}

export interface SlackSocketWatchdogOptions {
  client: SocketLikeEmitter;
  reconnectStormThreshold: number;
  stalenessMs: number;
  checkIntervalMs: number;
  onUnhealthy: (reason: SocketWatchdogUnhealthyReason, detail?: unknown) => void;
  /**
   * Seeds the internal `socketConnected` flag. Set `true` when wiring the
   * watchdog right after `app.start()` resolves — at that instant the socket
   * is Connected but its `connected` event already fired and can't be
   * re-observed. Defaults to `false`.
   */
  initiallyConnected?: boolean;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
}

export interface SlackSocketWatchdogHandle {
  stop(): void;
}

export function startSlackSocketWatchdog(options: SlackSocketWatchdogOptions): SlackSocketWatchdogHandle {
  const {
    client,
    reconnectStormThreshold,
    stalenessMs,
    checkIntervalMs,
    onUnhealthy,
    initiallyConnected = false,
    now = Date.now,
  } = options;

  let socketConnected = initiallyConnected;
  let consecutiveReconnects = 0;
  let lastEventAt = now();
  // First-trip wins. Without this guard a reconnect storm above the
  // threshold re-fires on every subsequent `reconnecting` event until the
  // host's async `process.exit(1)` finally completes — same story for the
  // 30s staleness tick. Caller can ignore exit-window dedupe.
  let tripped = false;
  const trip = (reason: SocketWatchdogUnhealthyReason, detail?: unknown): void => {
    if (tripped) return;
    tripped = true;
    onUnhealthy(reason, detail);
  };

  const onConnected = (): void => {
    socketConnected = true;
    consecutiveReconnects = 0;
  };

  // `connected` is the only signal that flips us back to healthy. EVERY
  // not-connected transition (`reconnecting` and `disconnected`) routes
  // through here so the stale-inbound gate arms no matter which event the
  // SocketModeClient chooses. `disconnected`-without-`reconnecting` is the
  // one path to a permanently-blind watchdog otherwise: socketConnected would
  // stay `true`, the gate would never open, and a genuinely dead socket would
  // never trip.
  const markNotConnected = (): void => {
    // Reset the staleness clock on the connected→disconnected *edge* only.
    // `lastEventAt` tracks inbound recency, which on a quiet instance can be
    // hours old. Without this reset, the first transient disconnect after a
    // long silent-but-healthy stretch would make the very next staleness tick
    // trip immediately — killing a socket Bolt would have recovered in
    // seconds. Measuring from the disconnect edge means stale-inbound only
    // trips after the socket has been *continuously* unhealthy for
    // `stalenessMs`. Edge-only (guarded by `socketConnected`) so a flapping
    // socket doesn't keep pushing the deadline out; `reconnect-storm` owns
    // that case. A `disconnected`→`reconnecting` pair therefore resets once,
    // not twice.
    if (socketConnected) {
      lastEventAt = now();
    }
    socketConnected = false;
  };

  const onReconnecting = (): void => {
    markNotConnected();
    consecutiveReconnects += 1;
    if (consecutiveReconnects >= reconnectStormThreshold) {
      trip('reconnect-storm', { consecutiveReconnects });
    }
  };

  // Terminal/clean disconnect. Arms staleness but does NOT count toward the
  // reconnect storm (that trigger is reconnect-attempt-specific).
  const onDisconnected = (): void => {
    markNotConnected();
  };

  const onSlackEvent = (): void => {
    lastEventAt = now();
  };

  const onUnrecoverableStart = (err: unknown): void => {
    trip('unrecoverable-start', err);
  };

  client.on('connected', onConnected);
  client.on('reconnecting', onReconnecting);
  client.on('disconnected', onDisconnected);
  client.on('slack_event', onSlackEvent);
  client.on('unable_to_socket_mode_start', onUnrecoverableStart);

  const timer = setInterval(() => {
    if (socketConnected) return;
    if (now() - lastEventAt > stalenessMs) {
      trip('stale-inbound', { stalenessMs, since: lastEventAt });
    }
  }, checkIntervalMs);
  timer.unref();

  return {
    stop(): void {
      clearInterval(timer);
      client.off('connected', onConnected);
      client.off('reconnecting', onReconnecting);
      client.off('disconnected', onDisconnected);
      client.off('slack_event', onSlackEvent);
      client.off('unable_to_socket_mode_start', onUnrecoverableStart);
    },
  };
}
