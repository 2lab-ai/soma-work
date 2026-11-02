/**
 * The Slack API a Slack-less task's executor gets (#598 ④b, design 598b §10).
 *
 * Every helper method records the call and rejects; `getClient()` records and
 * throws, so no raw client is ever handed to another module (a method pulled
 * off a client would escape any trap on it). A task turn that reaches Slack is
 * a missed seam: in production it is logged once per turn, in the T9 harness
 * the recorded list must be empty.
 */
import type { SlackApiHelper } from '../slack-api-helper';

export class SlackFromTaskTurnError extends Error {
  readonly code = 'SLACK_FROM_TASK_TURN';
  constructor(readonly method: string) {
    super(`A Slack-less task turn tried to call Slack (${method})`);
    this.name = 'SlackFromTaskTurnError';
  }
}

export interface RecordedSlackCall {
  method: string;
  firstArg?: unknown;
}

export interface FailClosedSlackApi {
  /** Typed as the helper so it drops into `StreamExecutorDeps.slackApi`. */
  api: SlackApiHelper;
  calls: RecordedSlackCall[];
}

export function createFailClosedSlackApi(opts: { onFirstCall?: (method: string) => void } = {}): FailClosedSlackApi {
  const calls: RecordedSlackCall[] = [];
  const record = (method: string, firstArg?: unknown) => {
    calls.push({ method, firstArg });
    if (calls.length === 1) opts.onFirstCall?.(method);
  };
  const api = new Proxy(Object.create(null) as object, {
    get(_target, prop) {
      // Not a thenable: `await api` must not look like a call.
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      const method = String(prop);
      if (method === 'getClient') {
        return () => {
          record(method);
          throw new SlackFromTaskTurnError(method);
        };
      }
      return (...args: unknown[]) => {
        record(method, args[0]);
        return Promise.reject(new SlackFromTaskTurnError(method));
      };
    },
  }) as SlackApiHelper;
  return { api, calls };
}
