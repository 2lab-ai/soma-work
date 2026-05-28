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
 *     a healthy socket are not a symptom.
 *   - `unrecoverable-start`: the `unable_to_socket_mode_start` event
 *     (UnrecoverableSocketModeStartError path).
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
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
}

export interface SlackSocketWatchdogHandle {
  stop(): void;
}

export function startSlackSocketWatchdog(options: SlackSocketWatchdogOptions): SlackSocketWatchdogHandle {
  const { client, reconnectStormThreshold, stalenessMs, checkIntervalMs, onUnhealthy, now = Date.now } = options;

  let socketConnected = false;
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

  const onReconnecting = (): void => {
    socketConnected = false;
    consecutiveReconnects += 1;
    if (consecutiveReconnects >= reconnectStormThreshold) {
      trip('reconnect-storm', { consecutiveReconnects });
    }
  };

  const onSlackEvent = (): void => {
    lastEventAt = now();
  };

  const onUnrecoverableStart = (err: unknown): void => {
    trip('unrecoverable-start', err);
  };

  client.on('connected', onConnected);
  client.on('reconnecting', onReconnecting);
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
      client.off('slack_event', onSlackEvent);
      client.off('unable_to_socket_mode_start', onUnrecoverableStart);
    },
  };
}
