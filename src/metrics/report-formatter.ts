/**
 * ReportFormatter — Formats aggregated reports into Slack Block Kit messages.
 * Trace: docs/daily-weekly-report/trace.md, Scenario 5
 */

import {
  AggregatedMetrics,
  DailyReport,
  WeeklyReport,
  UserRanking,
} from './types';

const MAX_RANKINGS_IN_BLOCKS = 10;

interface FormattedReport {
  blocks: any[];
  text: string;  // Fallback plain text
}

function metricsToSections(m: AggregatedMetrics): any[] {
  return [
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*:computer: 세션*\n생성 \`${m.sessionsCreated}\` · 슬립 \`${m.sessionsSlept}\` · 닫기 \`${m.sessionsClosed}\`` },
        { type: 'mrkdwn', text: `*:speech_balloon: 대화*\n턴 \`${m.turnsUsed}\`` },
      ],
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*:octocat: GitHub*\n이슈 \`${m.issuesCreated}\` · PR \`${m.prsCreated}\` · 커밋 \`${m.commitsCreated}\` · 코드 \`+${m.codeLinesAdded}\`` },
        { type: 'mrkdwn', text: `*:white_check_mark: 머지*\nPR \`${m.prsMerged}\` · 코드 \`+${m.mergeLinesAdded}\`` },
      ],
    },
  ];
}

function metricsToPlainText(m: AggregatedMetrics): string {
  return [
    `세션: 생성 ${m.sessionsCreated} / 슬립 ${m.sessionsSlept} / 닫기 ${m.sessionsClosed}`,
    `GitHub: 이슈 ${m.issuesCreated} / PR ${m.prsCreated} / 커밋 ${m.commitsCreated} / 코드 +${m.codeLinesAdded}`,
    `머지: PR ${m.prsMerged} / 코드 +${m.mergeLinesAdded}`,
    `대화: 턴 ${m.turnsUsed}`,
  ].join('\n');
}

export class ReportFormatter {
  /**
   * Format a daily report into Slack Block Kit.
   */
  formatDaily(report: DailyReport): FormattedReport {
    const blocks: any[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `:bar_chart: 일간 리포트 — ${report.date}`, emoji: true },
      },
      ...metricsToSections(report.metrics),
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `생성: ${new Date().toISOString().slice(0, 19)}Z` },
        ],
      },
    ];

    const text = `일간 리포트 — ${report.date}\n${metricsToPlainText(report.metrics)}`;

    return { blocks, text };
  }

  /**
   * Format a weekly report into Slack Block Kit with user rankings.
   */
  formatWeekly(report: WeeklyReport): FormattedReport {
    const blocks: any[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `:trophy: 주간 리포트 — ${report.weekStart} ~ ${report.weekEnd}`, emoji: true },
      },
      ...metricsToSections(report.metrics),
    ];

    // Rankings section (truncated to top 10)
    const displayRankings = report.rankings.slice(0, MAX_RANKINGS_IN_BLOCKS);

    if (displayRankings.length > 0) {
      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'header',
        text: { type: 'plain_text', text: ':medal: 사용자 랭킹', emoji: true },
      });

      for (const r of displayRankings) {
        const medal = r.rank === 1 ? ':first_place_medal:' : r.rank === 2 ? ':second_place_medal:' : r.rank === 3 ? ':third_place_medal:' : `#${r.rank}`;
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${medal} *${r.userName}*\n` +
              `턴 \`${r.metrics.turnsUsed}\` · PR \`${r.metrics.prsCreated}\` · 머지 \`${r.metrics.prsMerged}\` · 커밋 \`${r.metrics.commitsCreated}\` · 코드 \`+${r.metrics.codeLinesAdded}\``,
          },
        });
      }
    }

    blocks.push({
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `생성: ${new Date().toISOString().slice(0, 19)}Z` },
      ],
    });

    const text = `주간 리포트 — ${report.weekStart} ~ ${report.weekEnd}\n${metricsToPlainText(report.metrics)}`;

    return { blocks, text };
  }
}
