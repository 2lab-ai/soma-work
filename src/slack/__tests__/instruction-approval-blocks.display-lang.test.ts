/**
 * #774 / #767 — the owner's approval DM in English: every line the bot wrote
 * is the catalog's, while the requester's words (the quoted instructions) and
 * the session title stay exactly as written.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerDisplayCatalog } from '@soma/common/i18n';
import { describe, expect, it } from 'vitest';
import { translateMessagePayload } from '../display-translate';
import {
  buildInstructionApprovalDm,
  buildInstructionApprovalEndedDm,
  buildInstructionApprovalResolvedDm,
  type InstructionApprovalView,
} from '../instruction-approval-blocks';

// The catalog src/index.ts loads, registered into the module instance display-translate uses.
const CATALOG = join(__dirname, '..', '..', '..', 'packages', 'common', 'src', 'i18n-catalog');
registerDisplayCatalog('en', JSON.parse(readFileSync(join(CATALOG, 'en-text.json'), 'utf8')));

const HANGUL = /[가-힣]/;

function textsOf(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) for (const n of node) textsOf(n, out);
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'text' && typeof v === 'string') out.push(v);
      else textsOf(v, out);
    }
  }
  return out;
}

/** Korean left on lines the bot wrote — the requester's quoted words are theirs. */
function koreanBotLines(message: unknown): string[] {
  return textsOf(message)
    .flatMap((t) => t.split('\n'))
    .filter((line) => HANGUL.test(line) && !line.startsWith('> '));
}

const base: InstructionApprovalView = {
  requestId: 'r1',
  ownerId: 'UOWNER',
  requesterId: 'UREQ',
  requesterName: 'kim',
  texts: ['배포 상태 확인해줘', '', '로그도 봐줘', '네 번째', '다섯 번째'],
  threadUrl: 'https://slack.example/t',
  dashboardUrl: 'https://dash.example/d',
};

describe('instruction approval DM in English', () => {
  it('the waiting DM: count, place line (default title), attachments-only item, more-items line, buttons', () => {
    const en = translateMessagePayload(buildInstructionApprovalDm(base), 'en');
    expect(koreanBotLines(en)).toEqual([]);
    const all = textsOf(en).join('\n');
    expect(all).toContain('🙋 <@UREQ> sent 5 instructions to your task. Run them?');
    expect(all).toContain('> 배포 상태 확인해줘'); // the requester's words, as written
    expect(all).toContain('_and 2 more_');
    expect(all).toContain('_(attachments only)_'); // the bot's placeholder for an empty instruction
    expect(all).toContain('<https://slack.example/t|Task thread>');
  });

  it('a session title is the requester’s text and stays as written', () => {
    const en = translateMessagePayload(buildInstructionApprovalDm({ ...base, sessionTitle: '배포 점검' }), 'en');
    expect(textsOf(en).join('\n')).toContain('<https://slack.example/t|배포 점검>');
  });

  it('answered DMs, from Slack and from the dashboard, and the ended DM', () => {
    for (const decision of ['approve', 'approve_session', 'approve_always', 'deny'] as const) {
      for (const decidedVia of [undefined, 'dashboard'] as const) {
        const view = { ...base, texts: ['한 개'], decision, decidedVia } as InstructionApprovalView;
        const en = translateMessagePayload(buildInstructionApprovalResolvedDm(view), 'en');
        expect(koreanBotLines(en), `${decision} via ${decidedVia}`).toEqual([]);
      }
    }
    const ended = translateMessagePayload(
      buildInstructionApprovalEndedDm(base, '응답 시간이 지났거나 세션이 끝났습니다'),
      'en',
    );
    expect(koreanBotLines(ended)).toEqual([]);
    expect(ended.text).toBe(
      "⌛ The approval request for <@UREQ>'s instruction has ended (the time to respond has passed or the session has ended). It did not run.",
    );
  });
});
