/**
 * Halt a session on an Anthropic safeguards block seen OUTSIDE the turn's own
 * stream (#904, review R5): the permission guardian's Claude call about this
 * session's tool call, or an incident attempt whose text the screener replaced.
 *
 * The turn's own block goes through the executor's `haltOnSafeguardFlag` rail.
 * These sources never reach that rail, so they lock the session here, in the
 * same order: the halt is on the session and saved first, then the running
 * turn stops (abort reason `'safeguard'` — the executor ends it as the halt,
 * quietly), then ONE "세이프가드 에러" notice with the admin button is posted.
 * A session already halted keeps its halt and gets no second notice.
 */

import type { SafeguardFlagInfo, SafeguardHalt } from '@soma/common/safeguard';
import { buildSafeguardHaltBlocks, safeguardHaltNoticeText } from '@soma/slack/safeguard';

/** What the halt needs from the Slack side — wired by `SlackHandler`. */
export interface SafeguardHaltPorts {
  isRequestActive(sessionKey: string): boolean;
  abortSession(sessionKey: string, reason: 'safeguard'): boolean;
  postNotice(channel: string, threadTs: string | undefined, text: string, blocks: unknown[]): Promise<unknown>;
}

interface HaltableSession {
  channelId?: string;
  threadTs?: string;
  safeguardHalt?: SafeguardHalt;
}

export interface SafeguardExternalHaltDeps {
  getSessionByKey(sessionKey: string): HaltableSession | undefined;
  /**
   * No session live under the key (closed while the guardian ran): leave the
   * thread a tombstone so the next session there inherits the lock
   * (`SessionRegistry.haltSafeguardByKey`).
   */
  haltSafeguardByKey?(sessionKey: string, halt: SafeguardHalt): unknown;
  saveSessions(): void;
  broadcastSessionUpdate?(): void;
  /** Absent → the lock still lands (fail closed); nothing stops the turn or posts. */
  ports?: SafeguardHaltPorts;
  logger: {
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
  };
  now?: () => number;
}

export interface SafeguardExternalHaltOptions {
  /** Where the block was seen — for the log. */
  source: 'guardian' | 'incident' | 'summary';
  /**
   * Stop the session's running turn. The guardian's block arrives while the
   * turn runs; an incident attempt's arrives as the attempt ends, and its host
   * conclusion must still reach the thread.
   */
  stopRunningTurn: boolean;
}

/** The halt now on the session; undefined when the session is gone. Never throws. */
export function haltSessionOnSafeguardFlag(
  deps: SafeguardExternalHaltDeps,
  sessionKey: string,
  flag: SafeguardFlagInfo,
  opts: SafeguardExternalHaltOptions,
): SafeguardHalt | undefined {
  const { logger } = deps;
  const session = deps.getSessionByKey(sessionKey);
  if (!session) {
    if (deps.haltSafeguardByKey) {
      const halt: SafeguardHalt = { atMs: (deps.now ?? Date.now)(), ...flag };
      deps.haltSafeguardByKey(sessionKey, halt);
      try {
        deps.saveSessions();
      } catch (error) {
        logger.error('Safeguard halt: saving the thread tombstone failed — halted in memory only', {
          sessionKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      logger.warn('Safeguards block for a closed session — the thread is locked (tombstone)', {
        sessionKey,
        source: opts.source,
        ...flag,
      });
      return halt;
    }
    logger.error('Safeguards block for a session that is gone — nothing to halt', {
      sessionKey,
      source: opts.source,
      ...flag,
    });
    return undefined;
  }

  const fresh = !session.safeguardHalt;
  if (fresh) {
    session.safeguardHalt = { atMs: (deps.now ?? Date.now)(), ...flag };
    try {
      deps.saveSessions();
    } catch (error) {
      // The lock stays on in memory: the session is halted either way.
      logger.error('Safeguard halt: saving the lock failed — halted in memory only', {
        sessionKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    deps.broadcastSessionUpdate?.();
    logger.warn('Session halted by an Anthropic safeguards block — admin retry required', {
      sessionKey,
      source: opts.source,
      ...flag,
    });
  }
  const halt = session.safeguardHalt as SafeguardHalt;

  const ports = deps.ports;
  if (opts.stopRunningTurn && ports) {
    try {
      if (ports.isRequestActive(sessionKey)) ports.abortSession(sessionKey, 'safeguard');
    } catch (error) {
      logger.warn('Safeguard halt: stopping the running turn failed', {
        sessionKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (fresh && ports && session.channelId) {
    void ports
      .postNotice(
        session.channelId,
        session.threadTs,
        safeguardHaltNoticeText(halt),
        buildSafeguardHaltBlocks(halt, sessionKey),
      )
      .catch((error: unknown) =>
        logger.warn('Safeguard halt: posting the notice failed', {
          sessionKey,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  }
  return halt;
}
