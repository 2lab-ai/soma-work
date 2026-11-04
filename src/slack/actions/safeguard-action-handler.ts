/**
 * The "관리자 재시도 허용" button on the "세이프가드 에러" notice — the only way
 * to lift a safeguards halt (ssot T3).
 *
 * Action ID: `safeguard_admin_retry` (`@soma/slack/safeguard`). The clicker is
 * the Slack-authenticated `body.user.id`; only an admin (`ADMIN_USERS`) may
 * unlock, and only the halt the notice was posted for (`value.atMs`) — an
 * older notice's button never lifts a newer halt. The click must also come
 * from the thread the value names (`body.channel` + the message's thread) —
 * the button lifts the lock of the thread it was posted in, never another.
 * Lifting saves to disk before it is reported (`liftSafeguardHalt` throws on a
 * failed write).
 */

import {
  decideSafeguardUnlock,
  parseSafeguardButtonValue,
  SAFEGUARD_ERROR_EMOJI,
  SAFEGUARD_ERROR_LABEL,
  safeguardUnlockedNotice,
} from '@soma/slack/safeguard';
import { isAdminUser } from '../../admin-utils';
import { Logger } from '../../logger';
import { buildWorkSessionKey, normalizeSessionKey } from '../../session-identity';
import type { RespondFn } from './types';

interface SafeguardRegistry {
  getSafeguardHaltByKey(sessionKey: string): import('@soma/common/safeguard').SafeguardHalt | undefined;
  liftSafeguardHalt(sessionKey: string): boolean;
  broadcastSessionUpdate?(): void;
}

export interface SafeguardActionContext {
  getRegistry: () => SafeguardRegistry | undefined;
  /** Injectable for tests; defaults to `ADMIN_USERS`. */
  isAdmin?: (userId: string) => boolean;
}

export class SafeguardActionHandler {
  private logger = new Logger('SafeguardActionHandler');

  constructor(private ctx: SafeguardActionContext) {}

  async handleAdminRetry(body: any, respond: RespondFn): Promise<void> {
    const value = parseSafeguardButtonValue(body?.actions?.[0]?.value);
    const clicker: string | undefined = body?.user?.id;
    const registry = this.ctx.getRegistry();
    if (!value || !clicker || !registry) {
      this.logger.warn('safeguard_admin_retry: unusable click', { hasValue: !!value, hasClicker: !!clicker });
      return;
    }
    // The thread the clicked message lives in — never the key inside `value`.
    const channel: string | undefined = body?.channel?.id ?? body?.container?.channel_id;
    const messageTs: string | undefined = body?.message?.ts ?? body?.container?.message_ts;
    const threadTs: string | undefined = body?.message?.thread_ts ?? body?.container?.thread_ts ?? messageTs;
    if (
      !channel ||
      !threadTs ||
      normalizeSessionKey(buildWorkSessionKey(channel, threadTs)) !== normalizeSessionKey(value.sessionKey)
    ) {
      this.logger.warn('safeguard_admin_retry: click does not come from the halted thread', {
        sessionKey: value.sessionKey,
        channel,
        threadTs,
      });
      return;
    }
    const isAdmin = (this.ctx.isAdmin ?? isAdminUser)(clicker);
    const decision = decideSafeguardUnlock({
      halt: registry.getSafeguardHaltByKey(value.sessionKey),
      clickerIsAdmin: isAdmin,
      buttonAtMs: value.atMs,
    });
    this.logger.info('safeguard_admin_retry', { sessionKey: value.sessionKey, clicker, decision });

    if (decision === 'not-admin') {
      await respond({
        response_type: 'ephemeral',
        replace_original: false,
        text: `${SAFEGUARD_ERROR_EMOJI} ${SAFEGUARD_ERROR_LABEL}로 중단된 세션은 관리자(admin)만 다시 시도할 수 있습니다.`,
      });
      return;
    }
    if (decision === 'not-halted' || decision === 'stale') {
      await respond({
        response_type: 'ephemeral',
        replace_original: false,
        text:
          decision === 'stale'
            ? '이 안내 이후 새 세이프가드 차단이 있었습니다 — 가장 최근 안내의 버튼을 사용하세요.'
            : '이미 잠금이 해제된 세션입니다.',
      });
      return;
    }

    try {
      registry.liftSafeguardHalt(value.sessionKey);
    } catch (error) {
      this.logger.error('safeguard_admin_retry: lifting the lock failed — still halted', {
        sessionKey: value.sessionKey,
        error: (error as Error)?.message ?? String(error),
      });
      await respond({
        response_type: 'ephemeral',
        replace_original: false,
        text: '❌ 잠금 해제를 저장하지 못했습니다 — 세션은 여전히 잠겨 있습니다. 잠시 후 다시 눌러 주세요.',
      });
      return;
    }
    registry.broadcastSessionUpdate?.();
    await respond({ replace_original: true, text: safeguardUnlockedNotice(clicker) });
  }
}
