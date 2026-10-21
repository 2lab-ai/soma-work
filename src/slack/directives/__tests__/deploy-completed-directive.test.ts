import { ChannelMessageDirectiveHandler } from '@soma/slack/directives/channel-message-directive';
import { DeployCompletedDirectiveHandler } from '@soma/slack/directives/deploy-completed-directive';
import { describe, expect, it } from 'vitest';

const AFTER = '0123456789abcdef0123456789abcdef01234567';
const BEFORE = 'fedcba9876543210fedcba9876543210fedcba98';

describe('DeployCompletedDirectiveHandler', () => {
  describe('extract', () => {
    it('returns no payloads for plain text', () => {
      const result = DeployCompletedDirectiveHandler.extract('hello');
      expect(result.payloads).toEqual([]);
      expect(result.rejections).toEqual([]);
      expect(result.cleanedText).toBe('hello');
    });

    it('extracts a valid directive from a json code block and strips it', () => {
      const text = `Deploy done
\`\`\`json
{"type":"deploy_completed","repo":"acme/app","target":"deploy/dev2","before":"${BEFORE}","after":"${AFTER}"}
\`\`\`
Thread summary`;

      const result = DeployCompletedDirectiveHandler.extract(text);
      expect(result.payloads).toEqual([
        { repo: 'acme/app', target: 'deploy/dev2', before: BEFORE, after: AFTER, confirmed: true },
      ]);
      expect(result.cleanedText).toBe('Deploy done\n\nThread summary');
    });

    it('extracts a valid raw JSON directive and strips it', () => {
      const text = `Merged.
{"type":"deploy_completed","repo":"acme/app","target":"deploy/dev2","after":"abc1234"}
Next?`;

      const result = DeployCompletedDirectiveHandler.extract(text);
      expect(result.payloads).toEqual([{ repo: 'acme/app', target: 'deploy/dev2', after: 'abc1234', confirmed: true }]);
      expect(result.cleanedText).toBe('Merged.\n\nNext?');
    });

    it('accepts a directive-only text and leaves nothing visible', () => {
      const result = DeployCompletedDirectiveHandler.extract(
        `{"type":"deploy_completed","repo":"acme/app","target":"develop","after":"${AFTER}"}`,
      );
      expect(result.payloads).toHaveLength(1);
      expect(result.cleanedText).toBe('');
    });

    it('rejects a directive without `after`, leaves it visible and reports it with the raw fields', () => {
      const text = '{"type":"deploy_completed","repo":"acme/app","target":"deploy/dev2"}';
      const result = DeployCompletedDirectiveHandler.extract(text);
      expect(result.payloads).toEqual([]);
      expect(result.cleanedText).toBe(text);
      expect(result.rejections).toEqual([
        { problem: 'after must be a 7-40 char hex sha', repo: 'acme/app', target: 'deploy/dev2' },
      ]);
    });

    it.each([
      ['non-hex after', { after: 'not-a-sha' }],
      ['too-short after', { after: 'abc12' }],
      ['too-long after', { after: `${AFTER}0` }],
      ['non-hex before', { after: AFTER, before: 'zzzzzzz' }],
      ['repo without owner', { after: AFTER, repo: 'app' }],
      ['repo with a space', { after: AFTER, repo: 'acme/my app' }],
      ['empty target', { after: AFTER, target: '  ' }],
      ['non-string target', { after: AFTER, target: 7 }],
      ['non-boolean confirmed', { after: AFTER, confirmed: 'yes' }],
    ])('rejects an invalid directive (%s)', (_label, over) => {
      const directive = { type: 'deploy_completed', repo: 'acme/app', target: 'deploy/dev2', ...over };
      const result = DeployCompletedDirectiveHandler.extract(`ok\n${JSON.stringify(directive)}`);
      expect(result.payloads).toEqual([]);
      expect(result.rejections).toHaveLength(1);
      expect(result.rejections[0].problem).toMatch(/must be/);
    });

    it('reads `confirmed`: absent or true = confirmed, false = merged but deployment unconfirmed', () => {
      const base = { type: 'deploy_completed', repo: 'acme/app', target: 'deploy/dev2', after: AFTER };
      expect(DeployCompletedDirectiveHandler.extract(JSON.stringify(base)).payloads[0].confirmed).toBe(true);
      expect(
        DeployCompletedDirectiveHandler.extract(JSON.stringify({ ...base, confirmed: true })).payloads[0].confirmed,
      ).toBe(true);
      const unconfirmed = DeployCompletedDirectiveHandler.extract(JSON.stringify({ ...base, confirmed: false }));
      expect(unconfirmed.payloads).toEqual([
        { repo: 'acme/app', target: 'deploy/dev2', after: AFTER, confirmed: false },
      ]);
      expect(unconfirmed.cleanedText).toBe('');
    });

    it('reports unparseable JSON and a raw directive whose "type" is not the first key', () => {
      const broken = DeployCompletedDirectiveHandler.extract('{"type":"deploy_completed","repo":"acme/app", oops');
      expect(broken.payloads).toEqual([]);
      expect(broken.rejections).toEqual([{ problem: 'unparseable JSON, or "type" is not the first key' }]);

      const reordered = DeployCompletedDirectiveHandler.extract(
        `{"repo":"acme/app","type":"deploy_completed","target":"deploy/dev2","after":"${AFTER}"}`,
      );
      expect(reordered.payloads).toEqual([]);
      expect(reordered.rejections).toEqual([{ problem: 'unparseable JSON, or "type" is not the first key' }]);
    });

    it('reports a broken json code block once, not once per scan', () => {
      const text = '```json\n{"type":"deploy_completed","repo":"acme/app","target":"deploy/dev2","after":"zz"}\n```';
      const result = DeployCompletedDirectiveHandler.extract(text);
      expect(result.rejections).toHaveLength(1);
      expect(result.rejections[0]).toMatchObject({ problem: 'after must be a 7-40 char hex sha', after: 'zz' });
    });

    it('does not treat prose that names the directive without quotes as an attempt', () => {
      const result = DeployCompletedDirectiveHandler.extract(
        'No `deploy_completed` signal was sent: the deploy failed.',
      );
      expect(result.payloads).toEqual([]);
      expect(result.rejections).toEqual([]);
    });

    it('treats a null or empty `before` as unknown, not invalid', () => {
      for (const before of [null, '']) {
        const directive = { type: 'deploy_completed', repo: 'acme/app', target: 'deploy/dev2', before, after: AFTER };
        const result = DeployCompletedDirectiveHandler.extract(JSON.stringify(directive));
        expect(result.payloads).toEqual([{ repo: 'acme/app', target: 'deploy/dev2', after: AFTER, confirmed: true }]);
        expect(result.rejections).toEqual([]);
      }
    });

    it('never throws on malformed JSON', () => {
      const text = '{"type":"deploy_completed","repo":"acme/app", oops';
      expect(() => DeployCompletedDirectiveHandler.extract(text)).not.toThrow();
      expect(DeployCompletedDirectiveHandler.extract(text).payloads).toEqual([]);
    });

    it('extracts every directive when a multi-repo deploy emits two', () => {
      const text = `Repo 1 deployed.
{"type":"deploy_completed","repo":"acme/app","target":"deploy/dev2","after":"aaaaaaa"}
Repo 2 deployed.
\`\`\`json
{"type":"deploy_completed","repo":"acme/api","target":"deploy/dev2","after":"bbbbbbb"}
\`\`\`
All done.`;

      const result = DeployCompletedDirectiveHandler.extract(text);
      expect(result.payloads.map((p) => p.repo).sort()).toEqual(['acme/api', 'acme/app']);
      expect(result.cleanedText).toBe('Repo 1 deployed.\n\nRepo 2 deployed.\n\nAll done.');
    });

    it('keeps a valid one and leaves an invalid sibling visible', () => {
      const bad = '{"type":"deploy_completed","repo":"acme/api","target":"deploy/dev2","after":"nope"}';
      const text = `{"type":"deploy_completed","repo":"acme/app","target":"deploy/dev2","after":"aaaaaaa"}\n${bad}`;
      const result = DeployCompletedDirectiveHandler.extract(text);
      expect(result.payloads.map((p) => p.repo)).toEqual(['acme/app']);
      expect(result.cleanedText).toBe(bad);
      expect(result.rejections).toEqual([
        { problem: 'after must be a 7-40 char hex sha', repo: 'acme/api', target: 'deploy/dev2', after: 'nope' },
      ]);
    });

    it('trims fields and lower-cases the SHAs', () => {
      const result = DeployCompletedDirectiveHandler.extract(
        '{"type":"deploy_completed","repo":" Acme/App ","target":" deploy/dev2 ","before":"ABCDEF1","after":"ABCDEF2"}',
      );
      expect(result.payloads).toEqual([
        { repo: 'Acme/App', target: 'deploy/dev2', before: 'abcdef1', after: 'abcdef2', confirmed: true },
      ]);
    });

    it('does not touch a channel_message directive', () => {
      const text = '{"type":"channel_message","text":"Release notes"}';
      const result = DeployCompletedDirectiveHandler.extract(text);
      expect(result.payloads).toEqual([]);
      expect(result.rejections).toEqual([]);
      expect(result.cleanedText).toBe(text);
    });

    it('coexists with channel_message: each handler strips only its own directive', () => {
      const text = `Deployed.
\`\`\`json
{"type":"channel_message","text":"Release notes"}
\`\`\`
{"type":"deploy_completed","repo":"acme/app","target":"deploy/dev2","after":"${AFTER}"}
Done.`;

      // Same order as the stream processor: channel_message first, then deploy_completed.
      const channel = ChannelMessageDirectiveHandler.extract(text);
      expect(channel.messageText).toBe('Release notes');
      const deploy = DeployCompletedDirectiveHandler.extract(channel.cleanedText);
      expect(deploy.payloads).toEqual([{ repo: 'acme/app', target: 'deploy/dev2', after: AFTER, confirmed: true }]);
      expect(deploy.cleanedText).toBe('Deployed.\n\nDone.');
    });
  });
});
