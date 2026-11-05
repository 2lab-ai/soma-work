/**
 * #932 (epic #935) — communication and review rules that spend less of a person's attention.
 *
 * Source: dsh-superagent docs/000-philosophy.md ("use the least human attention for the most value") and
 * docs/004-prompts.md §Principles. Added to the skills and the common prompt; existing rules are kept as they are.
 * - Reviews are handled by outcome: a fixed and verified finding is resolved with its commit; a declined one gets one
 *   sentence why.
 * - Round trips with automated (bot) reviewers stop after 3 per PR.
 * - When a person's branch or PR already makes the same change, the bot's PR yields to it.
 * - A host-woken turn with nothing to check and nothing for a person to do ends without a message — a user's
 *   instruction always gets a reply.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf-8');

describe('review and communication rules (#932)', () => {
  const zcheck = read('local/skills/zcheck/SKILL.md');
  const zwork = read('local/skills/zwork/SKILL.md');
  const common = read('prompt/common.prompt');

  it('zcheck handles reviews by outcome: the fix commit for a fixed finding, one sentence for a declined one', () => {
    expect(zcheck).toMatch(/결과로 처리한다/);
    expect(zcheck).toMatch(/커밋 SHA/);
    expect(zcheck).toMatch(/받지 않는 지적은 이유 한 문장/);
  });

  it('zcheck stops round trips with bot reviewers after 3 per PR; people have no cap', () => {
    expect(zcheck).toMatch(/PR당 3라운드까지/);
    expect(zcheck).toMatch(/사람의 지적은 이 상한이 없다/);
  });

  it('the bot cap never defers a blocking defect: a P0/P1 is still checked and fixed before READY (#932 review)', () => {
    expect(zcheck).toMatch(/P0\/P1\(정확성·보안·데이터 손실\) 또는 태그 없는 지적은 상한과 무관하게/);
    expect(zcheck).toMatch(/결함을 후속 이슈로 미루고 READY를 내지 않는다/);
    // Rounds survive a session change; READY says what the cap deferred (#932 review, fable).
    expect(zcheck).toMatch(/라운드는 PR 타임라인/);
    expect(zcheck).toMatch(/미룬 봇 지적 수와 그 후속 이슈 링크/);
  });

  it("zwork yields to a person's branch or PR that already makes the same change", () => {
    expect(zwork).toMatch(/중복 양보/);
    expect(zwork).toMatch(/내 PR을 열지 않는다/);
    expect(zwork).toMatch(/Closing in favour of #N/);
    // Yielding is an exit: the controller gets 'yielded' and the review/approve/merge pipeline stops (#932 review).
    expect(zwork).toMatch(/\*\*yielded\*\*/);
    expect(zwork).toMatch(/파이프라인은 여기서 멈추고/);
    expect(zwork).toMatch(/그 사람의 PR에 `local:zcheck`를 돌리지 않고, 그 브랜치에 push하지 않는다/);
  });

  it('the callers honour a yielded result: z skips phase3/4, autoz skips zcheck and its review gate on that PR (#932 review)', () => {
    const z = read('local/skills/z/SKILL.md');
    const autoz = read('local/skills/autoz/SKILL.md');
    expect(z).toMatch(/\*\*yielded\*\*.*phase3·phase4를 건너뛴다/);
    expect(autoz).toMatch(/except when zwork returns \*\*yielded\*\*/);
  });

  it('the common prompt: a host-woken turn with nothing to do ends without a message; a user instruction always gets a reply', () => {
    expect(common).toMatch(/## Host-woken turns/);
    expect(common).toMatch(/end the turn without a message/);
    // Silence is only for a turn that changed nothing: finished work still reports (#932 review).
    expect(common).toMatch(/If it changed nothing — no new outcome/);
    expect(common).toMatch(/A turn that finished or changed work reports as usual/);
    expect(common).toMatch(/A user's instruction always gets a reply/);
    // The restart resume turn carries the user's request: never a quiet one (#932 review, fable).
    expect(common).toMatch(/The restart resume turn is not one of these/);
  });

  it('the earlier rules are still there (added to, not replaced)', () => {
    expect(zcheck).toContain('fix+commit+push+reply+resolve');
    expect(zcheck).toContain('PR당 **후속 이슈 하나**');
    expect(zcheck).toContain('0 unresolved까지 루프');
    expect(zwork).toContain('PR body MUST include `Closes #<issue>`');
    expect(common).toContain('## Task card');
    expect(common).toContain('## Slack Output Formatting');
  });
});
