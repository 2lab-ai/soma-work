/**
 * `lang` / `/z lang` Block Kit topic — #772.
 *
 * One display language per user, Korean by default: it decides the language
 * of the dashboard, of the bot's text in Slack threads and of the model's
 * answers (told with `<display-lang>` on the next instruction). The same
 * setting as the dashboard's top-right en / ko toggle and the settings page.
 *
 * Only an accepted user can change it: the store's setters create a missing
 * record as accepted, so a write for an unknown user would skip the new-user
 * approval.
 */

import { type DisplayLang, parseDisplayLang, setCurrentDisplayLang } from '@soma/common/i18n';
import { userSettingsStore } from '../../../user-settings-store';
import type { ApplyResult, RenderResult, ZTopicBinding } from '../../actions/z-settings-actions';
import { buildSettingCard } from '../ui-builder';

const NAME: Record<DisplayLang, string> = { ko: '한국어', en: 'English' };

/** What a switch says — in the language just chosen. */
const SWITCHED: Record<DisplayLang, ApplyResult> = {
  ko: {
    ok: true,
    summary: '🌐 표시 언어: 한국어',
    description:
      '대시보드, 슬랙 스레드의 봇 문구, 모델의 답변이 한국어로 바뀝니다. 열려 있는 대시보드는 새로 고치면 바뀝니다.',
  },
  en: {
    ok: true,
    summary: '🌐 Display language: English',
    description:
      "The dashboard, the bot's text in Slack threads and the model's answers now use English. Refresh an open dashboard to see it.",
  },
};

export async function renderLangCard(args: { userId: string; issuedAt: number }): Promise<RenderResult> {
  const lang = userSettingsStore.getUserDisplayLanguage(args.userId);
  const blocks = buildSettingCard({
    topic: 'lang',
    icon: '🌐',
    title: '표시 언어 · Display language',
    currentLabel: `${NAME[lang]} (${lang})`,
    currentDescription: '대시보드, 슬랙 스레드의 봇 문구, 모델의 답변이 쓰는 언어입니다.',
    options: [
      { id: 'ko', label: '한국어 (ko)', description: '기본값' },
      { id: 'en', label: 'English (en)', description: 'Dashboard, thread and answers in English' },
    ],
    additionalCommands: [
      '`lang ko` · `lang en` — 바꾸기',
      '_대시보드 오른쪽 위 en / ko 토글과 같은 설정입니다. 모델은 다음 지시부터 이 언어로 답합니다._',
    ],
    issuedAt: args.issuedAt,
  });
  return { text: `🌐 표시 언어: ${NAME[lang]}`, blocks };
}

export async function applyLang(args: { userId: string; value: string }): Promise<ApplyResult> {
  const lang = parseDisplayLang(args.value);
  if (!lang) {
    return {
      ok: false,
      summary: `❌ \`ko\` 또는 \`en\`만 받습니다: \`${args.value}\``,
      description: '`lang ko` — 한국어 · `lang en` — English',
    };
  }
  if (userSettingsStore.getUserSettings(args.userId)?.accepted !== true) {
    return { ok: false, summary: '🚫 관리자 승인을 받은 뒤에 바꿀 수 있습니다.' };
  }
  try {
    userSettingsStore.setUserDisplayLanguage(args.userId, lang);
  } catch (error) {
    return { ok: false, summary: '❌ 저장 실패', description: (error as Error).message };
  }
  // The rest of this event (this answer included) speaks the language just chosen.
  setCurrentDisplayLang(lang);
  return SWITCHED[lang];
}

export function createLangTopicBinding(): ZTopicBinding {
  return {
    topic: 'lang',
    apply: (args) => applyLang({ userId: args.userId, value: args.value }),
    renderCard: (args) => renderLangCard({ userId: args.userId, issuedAt: args.issuedAt }),
  };
}
