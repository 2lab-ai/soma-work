/**
 * #1072 — the head's wait line in English. The rail goes out through the Slack
 * display translation (display-translate → translateText with en-text.json),
 * so every bot-written part of a waiting head's first line has a catalog entry:
 * the badge, "<token>부터 기다림" and "마지막 활동 <token>". The date token stays
 * as written — Slack renders it in the reader's own language.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerDisplayCatalog, translateText } from '@soma/common/i18n';
import { describe, expect, it } from 'vitest';
import { ActionPanelBuilder } from '../action-panel-builder';

const CATALOG = join(__dirname, '..', '..', '..', 'packages', 'common', 'src', 'i18n-catalog');
registerDisplayCatalog('en', JSON.parse(readFileSync(join(CATALOG, 'en-text.json'), 'utf8')));

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HANGUL = /[가-힣]/;

function token(atMs: number): string {
  const sec = Math.floor(atMs / 1000);
  return `<!date^${sec}^{ago}|${new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')}>`;
}

function firstLine(params: Partial<Parameters<typeof ActionPanelBuilder.build>[0]>): string {
  const rail = ActionPanelBuilder.build({ sessionKey: 'C1:1700.000000', now: NOW, ...params }).blocks[0].text.text;
  return String(rail).split('\n')[0];
}

describe('ActionPanelBuilder — the wait line in English (#1072)', () => {
  it('a question waiting: badge, since when, last activity — all English, the tokens untouched', () => {
    const line = firstLine({
      waitingForChoice: true,
      activityState: 'waiting',
      waitingSince: NOW - 3 * MINUTE,
      lastProgressAt: NOW - 2 * MINUTE,
    });

    expect(translateText(line, 'en')).toBe(
      `🟡 *Waiting for input* · Started waiting ${token(NOW - 3 * MINUTE)} · Last activity ${token(NOW - 2 * MINUTE)}`,
    );
  });

  it('대기 중 (waiting, no question on the panel) too', () => {
    const line = firstLine({ activityState: 'waiting', waitingSince: NOW - 40 * MINUTE, lastProgressAt: NOW });

    expect(HANGUL.test(translateText(line, 'en'))).toBe(false);
    expect(translateText(line, 'en')).toContain(`Started waiting ${token(NOW - 40 * MINUTE)}`);
  });

  it('a Korean reader sees the source line unchanged', () => {
    const line = firstLine({ waitingForChoice: true, activityState: 'waiting', waitingSince: NOW - 3 * MINUTE });

    expect(translateText(line, 'ko')).toBe(line);
    expect(line).toContain(`${token(NOW - 3 * MINUTE)}부터 기다림`);
  });
});
