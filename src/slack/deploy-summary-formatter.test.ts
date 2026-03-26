/**
 * DeploySummaryFormatter tests (RED - contract tests)
 * Trace: docs/deploy-channel-split/trace.md
 */

import { describe, it, expect } from 'vitest';
import { DeploySummaryFormatter } from './deploy-summary-formatter';

describe('DeploySummaryFormatter', () => {
  // === Scenario 3: Deploy Success Summary ===

  // Trace: Scenario 3, Section 3b — formatSuccessLine
  describe('format - success', () => {
    it('summary_format_success_one_line: formats successful deploy as one-line summary', () => {
      const resultText = JSON.stringify({
        type: 'deploy_summary',
        env: 'Dev2',
        version: '0.1.0-d198882',
        build: 'ok',
        deploy: 'ok',
        e2e: 'ok',
      });

      const result = DeploySummaryFormatter.format(resultText);

      expect(result.text).toBe('[Dev2] 0.1.0-d198882 | build: ok | deploy: ok | e2e: ok');
      expect(result.attachments).toBeUndefined();
    });

    // Trace: Scenario 3, Section 3b — all status combinations
    it('summary_format_all_statuses: handles various status combinations', () => {
      const resultText = JSON.stringify({
        type: 'deploy_summary',
        env: 'Prod',
        version: '1.2.3-abc1234',
        build: 'ok',
        deploy: 'ok',
        e2e: 'ok',
      });

      const result = DeploySummaryFormatter.format(resultText);

      expect(result.text).toContain('[Prod]');
      expect(result.text).toContain('1.2.3-abc1234');
      expect(result.text).toContain('build: ok');
      expect(result.text).toContain('deploy: ok');
      expect(result.text).toContain('e2e: ok');
    });

    // Trace: Scenario 3, Section 5 — unparseable result
    it('summary_unparseable_result_fallback: returns raw text when parse fails', () => {
      const rawText = 'Deploy completed successfully with some custom output';

      const result = DeploySummaryFormatter.format(rawText);

      expect(result.text).toBe(rawText);
      expect(result.attachments).toBeUndefined();
    });
  });

  // === Scenario 4: Deploy Failure Summary ===

  // Trace: Scenario 4, Section 3b — formatFailureLine + buildErrorAttachment
  describe('format - failure', () => {
    it('summary_format_failure_with_attachment: formats failure with red attachment', () => {
      const resultText = JSON.stringify({
        type: 'deploy_summary',
        env: 'Dev2',
        version: '0.1.0-b517504',
        build: 'ok',
        deploy: 'fail',
        e2e: 'skip',
        error: {
          environment: 'Dev2',
          platform: 'linux/amd64',
          namespace: 'ghcr.io/insightquest-io/gucci',
          images: 9,
          duration: '9s',
          conclusion: 'failure',
          runUrl: 'https://github.com/insightquest-io/Gucci/actions/runs/23236408002',
          runNumber: '#338',
          message: 'see thread for full logs.',
        },
      });

      const result = DeploySummaryFormatter.format(resultText);

      expect(result.text).toBe('[Dev2] 0.1.0-b517504 | build: ok | deploy: fail');
      expect(result.attachments).toBeDefined();
      expect(result.attachments).toHaveLength(1);
    });

    // Trace: Scenario 4, Section 3b — attachment color
    it('summary_error_attachment_red_color: attachment uses danger color', () => {
      const resultText = JSON.stringify({
        type: 'deploy_summary',
        env: 'Dev2',
        version: '0.1.0-b517504',
        build: 'ok',
        deploy: 'fail',
        error: {
          environment: 'Dev2',
          conclusion: 'failure',
        },
      });

      const result = DeploySummaryFormatter.format(resultText);

      expect(result.attachments![0].color).toBe('danger');
    });

    // Trace: Scenario 4, Section 3b — field mapping
    it('summary_error_attachment_fields: includes all error fields with mrkdwn formatting', () => {
      const resultText = JSON.stringify({
        type: 'deploy_summary',
        env: 'Dev2',
        version: '0.1.0-b517504',
        build: 'ok',
        deploy: 'fail',
        error: {
          environment: 'Dev2',
          platform: 'linux/amd64',
          namespace: 'ghcr.io/insightquest-io/gucci',
          images: 9,
          duration: '9s',
          conclusion: 'failure',
          runUrl: 'https://github.com/insightquest-io/Gucci/actions/runs/23236408002',
          runNumber: '#338',
          message: 'see thread for full logs.',
        },
      });

      const result = DeploySummaryFormatter.format(resultText);
      const attachmentText = result.attachments![0].text;

      expect(attachmentText).toContain('*Environment:*');
      expect(attachmentText).toContain('*Platform:*');
      expect(attachmentText).toContain('*Namespace:*');
      expect(attachmentText).toContain('*Images:*');
      expect(attachmentText).toContain('*Duration:*');
      expect(attachmentText).toContain('*Conclusion:*');
      expect(attachmentText).toContain('*Error:*');
      expect(attachmentText).toContain('Dev2');
      expect(attachmentText).toContain('linux/amd64');
    });

    // Trace: Scenario 4, Section 5 — partial metadata
    it('summary_partial_metadata_graceful: handles missing error fields gracefully', () => {
      const resultText = JSON.stringify({
        type: 'deploy_summary',
        env: 'Dev2',
        version: '0.1.0-x',
        build: 'ok',
        deploy: 'fail',
        error: {
          environment: 'Dev2',
          conclusion: 'failure',
          // other fields missing
        },
      });

      const result = DeploySummaryFormatter.format(resultText);

      expect(result.text).toContain('deploy: fail');
      expect(result.attachments).toBeDefined();
      // Should not throw, should omit missing fields
      expect(result.attachments![0].text).toContain('Dev2');
    });
  });
});
