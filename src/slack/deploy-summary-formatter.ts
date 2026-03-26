/**
 * DeploySummaryFormatter - Formats deploy completion output
 * Parses Claude's structured deploy summary and produces:
 *   - One-line summary for the original channel
 *   - Red error attachment on failure
 *
 * Trace: docs/deploy-channel-split/trace.md (Scenarios 3, 4)
 */

export interface DeploySummary {
  env: string;
  version: string;
  build: string;
  deploy: string;
  e2e?: string;
  error?: DeployErrorDetail;
}

export interface DeployErrorDetail {
  environment?: string;
  platform?: string;
  namespace?: string;
  images?: number;
  duration?: string;
  conclusion?: string;
  runUrl?: string;
  runNumber?: string;
  message?: string;
}

export interface DeployFormatResult {
  text: string;
  attachments?: Array<{ color: string; text: string; mrkdwn_in: string[] }>;
}

export class DeploySummaryFormatter {
  /**
   * Parse result text and produce a formatted summary.
   * If parsing fails, returns the raw text as-is (graceful degradation).
   */
  static format(resultText: string): DeployFormatResult {
    try {
      const parsed = JSON.parse(resultText);
      if (parsed.type !== 'deploy_summary') {
        return { text: resultText };
      }

      const summary: DeploySummary = {
        env: parsed.env,
        version: parsed.version,
        build: parsed.build,
        deploy: parsed.deploy,
        e2e: parsed.e2e,
        error: parsed.error,
      };

      const hasFailure = summary.build === 'fail' || summary.deploy === 'fail' || summary.e2e === 'fail';

      if (hasFailure) {
        return DeploySummaryFormatter.formatFailure(summary);
      }
      return DeploySummaryFormatter.formatSuccess(summary);
    } catch {
      // Unparseable → return raw text (Trace: Scenario 3, Section 5)
      return { text: resultText };
    }
  }

  private static formatSuccess(summary: DeploySummary): DeployFormatResult {
    return { text: DeploySummaryFormatter.buildSummaryLine(summary) };
  }

  private static formatFailure(summary: DeploySummary): DeployFormatResult {
    const text = DeploySummaryFormatter.buildSummaryLine(summary);

    if (!summary.error) {
      return { text, attachments: [{ color: 'danger', text: `${text} — no error details available`, mrkdwn_in: ['text'] }] };
    }

    const attachment = DeploySummaryFormatter.buildErrorAttachment(summary);
    return { text, attachments: [attachment] };
  }

  /**
   * Build the one-line summary.
   * Format: [env] version | build: status | deploy: status | e2e: status
   * If e2e is undefined or 'skip', the e2e segment is omitted.
   */
  private static buildSummaryLine(summary: DeploySummary): string {
    const parts = [
      `[${summary.env}] ${summary.version}`,
      `build: ${summary.build}`,
      `deploy: ${summary.deploy}`,
    ];

    if (summary.e2e && summary.e2e !== 'skip') {
      parts.push(`e2e: ${summary.e2e}`);
    }

    return parts.join(' | ');
  }

  /**
   * Build Slack danger attachment with error details.
   * Only includes fields that are present (Trace: Scenario 4, Section 5).
   */
  private static buildErrorAttachment(summary: DeploySummary): { color: string; text: string; mrkdwn_in: string[] } {
    const err = summary.error!;
    const lines: string[] = [];

    lines.push(`[${summary.env}] ${summary.version} deploy failed.`);

    if (err.environment) lines.push(`*Environment:* ${err.environment}`);
    if (err.platform) lines.push(`*Platform:* ${err.platform}`);
    if (err.namespace) lines.push(`*Namespace:* ${err.namespace}`);
    if (err.images !== undefined) lines.push(`*Images:* ${err.images}`);
    if (err.duration) lines.push(`*Duration:* ${err.duration}`);
    if (err.conclusion) lines.push(`*Conclusion:* ${err.conclusion}`);
    if (err.runUrl) {
      const label = err.runNumber || 'link';
      lines.push(`Run: <${err.runUrl}|${label}>`);
    }
    if (err.message) lines.push(`*Error:* ${err.message}`);

    return {
      color: 'danger',
      text: lines.join('\n'),
      mrkdwn_in: ['text'],
    };
  }
}
