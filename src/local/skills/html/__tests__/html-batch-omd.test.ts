import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Every test here spawns python3 or a browser; the 5 s default is too tight on a loaded runner.
vi.setConfig({ testTimeout: 60_000 });

const SKILL_ROOT = resolve(__dirname, '..');
const UIUX_ROOT = resolve(SKILL_ROOT, '..', 'ui-ux');
const BATCH = resolve(SKILL_ROOT, 'renderer', 'batch.py');
const BATCH_QA = resolve(SKILL_ROOT, 'renderer', 'batch-qa.mjs');
const md = () => readFileSync(resolve(SKILL_ROOT, 'SKILL.md'), 'utf8');
const scratch = mkdtempSync(join(tmpdir(), 'html-batch-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function resolver(uiuxRoot: string, design: string) {
  const m = md().match(/<<'RESOLVE'\n([\s\S]*?)\nRESOLVE/);
  expect(m).not.toBeNull();
  return spawnSync('python3', ['-', uiuxRoot, design], { input: (m as RegExpMatchArray)[1], encoding: 'utf8' });
}

describe('local:html — design-md-v3 references through the Step 3.4 resolver', () => {
  it('resolves omd-<id> from the generated oh-my-design index, with format and upstream', () => {
    const r = resolver(UIUX_ROOT, 'omd-toss');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('reference=omd-toss');
    expect(r.stdout).toContain('format=design-md-v3');
    expect(r.stdout).toContain('family=oh-my-design');
    expect(r.stdout).toMatch(/^upstream=[0-9a-f]{40}$/m);
    expect(r.stdout.match(/^design_md=(.+)$/m)?.[1]).toBe(resolve(UIUX_ROOT, 'references', 'omd', 'toss', 'DESIGN.md'));
  });

  it('keeps bare names: openai is still the hand-kept reference and bare toss is unknown', () => {
    expect(resolver(UIUX_ROOT, 'openai').stdout).toContain(
      `design_md=${resolve(UIUX_ROOT, 'references', 'openai', 'design.md')}`,
    );
    const bare = resolver(UIUX_ROOT, 'toss');
    expect(bare.status).not.toBe(0);
    expect(bare.stderr).toMatch(/unknown design=toss/);
  });

  it('a name present in both indexes is an error, never a silent precedence', () => {
    const root = join(scratch, 'ui-ux-dup');
    mkdirSync(join(root, 'references', 'omd'), { recursive: true });
    cpSync(resolve(UIUX_ROOT, 'references', 'index.json'), join(root, 'references', 'index.json'));
    const omd = JSON.parse(readFileSync(resolve(UIUX_ROOT, 'references', 'omd', 'index.json'), 'utf8'));
    omd.references.push({ ...omd.references[0], name: 'openai' });
    writeFileSync(join(root, 'references', 'omd', 'index.json'), JSON.stringify(omd));
    const r = resolver(root, 'default');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/duplicate reference name: openai/);
  });

  it('Step 3.4 runs the designmd_tokens.py adapter for design-md-v3 and discloses derived values and font layers', () => {
    const text = md();
    expect(text).toMatch(/designmd_tokens\.py/);
    expect(text).toMatch(/format=design-md-v3/);
    expect(text).toMatch(/derived/i);
    expect(text).toMatch(/brand face/i);
    expect(text).toMatch(/substitute/i);
    expect(text).toMatch(/safe default/i);
  });
});

describe('local:html — CJK line breaking is a hard rule owned by the html skill', () => {
  it('Step 4 sets keep-all + strict for Korean only, and never keep-all for Japanese/Chinese', () => {
    const s4 = md().slice(md().search(/^### 4\. Generate HTML/m));
    expect(s4).toMatch(/:lang\(ko\)[^\n]*word-break: keep-all/);
    expect(s4).toMatch(/line-break: strict/);
    expect(s4).toMatch(/:lang\(ja\)|:lang\(zh/);
    expect(s4).toMatch(/never `?keep-all`? for Japanese|not keep-all/i);
  });
});

describe('local:html — batch mode (one authored page, many references)', () => {
  const tpl = join(scratch, 'page.html');
  writeFileSync(
    tpl,
    `<!--__AUDIT__-->
<!doctype html><html lang="ko"><head><meta charset="utf-8"><!--__FONT_LINKS__--><style>/*__TOKENS__*/
body{background:var(--color-bg);color:var(--color-text);font-family:var(--font-sans)}</style></head>
<body><main><h1>있어요 테스트</h1><p>본문</p></main><!--__ATTRIBUTION__--></body></html>`,
  );

  it('documents batch mode in SKILL.md and ships batch.py + batch-qa.mjs', () => {
    expect(md()).toMatch(/^### Batch mode/m);
    expect(existsSync(BATCH)).toBe(true);
    expect(existsSync(BATCH_QA)).toBe(true);
  });

  it('renders one page per reference through the same resolver + adapter, with full audit data', () => {
    const out = join(scratch, 'out');
    const r = spawnSync(
      'python3',
      [BATCH, '--page', tpl, '--refs', 'omd-toss,omd-pixiv', '--out', out, '--uiux', UIUX_ROOT],
      {
        encoding: 'utf8',
      },
    );
    expect(r.status, r.stderr).toBe(0);
    const page = readFileSync(join(out, 'omd-toss.html'), 'utf8');
    expect(page).toMatch(/<!-- ui-ux: driver=reference · reference=omd-toss · format=design-md-v3/);
    expect(page).toMatch(/upstream=[0-9a-f]{40}/);
    expect(page).toMatch(/design_sha256=[0-9a-f]{64}/);
    expect(page).toMatch(/content_sha256=[0-9a-f]{64}/);
    expect(page).toMatch(/adapter=designmd_tokens\.py [0-9.]+/);
    expect(page).toMatch(/--color-bg:/);
    expect(page).toMatch(/레퍼런스 토큰 적용본/);
    expect(page).toMatch(/Toss Product Sans/);
    expect(page).toMatch(/유도/);
    expect(page).not.toMatch(/__TOKENS__|__AUDIT__|__ATTRIBUTION__|__FONT_LINKS__/);
    const results = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8'));
    expect(results.references.map((x: { name: string }) => x.name)).toEqual(['omd-toss', 'omd-pixiv']);
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toMatch(/omd-pixiv\.html/);
  });

  it('fails on an unknown reference instead of skipping it', () => {
    const r = spawnSync(
      'python3',
      [BATCH, '--page', tpl, '--refs', 'omd-toss,omd-nope', '--out', join(scratch, 'bad'), '--uiux', UIUX_ROOT],
      {
        encoding: 'utf8',
      },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unknown design=omd-nope/);
  });

  it('batch-qa passes clean pages (no false-red from its own CDP probes)', () => {
    const out = join(scratch, 'clean');
    const b = spawnSync(
      'python3',
      [BATCH, '--page', tpl, '--refs', 'omd-toss,omd-pixiv', '--out', out, '--uiux', UIUX_ROOT],
      {
        encoding: 'utf8',
      },
    );
    expect(b.status, b.stderr).toBe(0);
    const r = spawnSync('node', [BATCH_QA, out, '--concurrency', '2'], { encoding: 'utf8', timeout: 240000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/checked 2, passed 2, failed 0/);
  }, 300_000);

  it('regenerating a batch drops the old QA record, so the list never shows a stale pass', () => {
    const out = join(scratch, 'clean');
    expect(existsSync(join(out, 'qa.json'))).toBe(true);
    const b = spawnSync(
      'python3',
      [BATCH, '--page', tpl, '--refs', 'omd-toss,omd-pixiv', '--out', out, '--uiux', UIUX_ROOT],
      {
        encoding: 'utf8',
      },
    );
    expect(b.status, b.stderr).toBe(0);
    expect(existsSync(join(out, 'qa.json'))).toBe(false);
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toMatch(/QA 전/);
  });

  it('batch-qa compares <main> with the authored page, not with the pages under test', () => {
    const out = join(scratch, 'tampered');
    const b = spawnSync(
      'python3',
      [BATCH, '--page', tpl, '--refs', 'omd-toss,omd-pixiv', '--out', out, '--uiux', UIUX_ROOT],
      {
        encoding: 'utf8',
      },
    );
    expect(b.status, b.stderr).toBe(0);
    for (const f of ['omd-toss.html', 'omd-pixiv.html']) {
      const p = join(out, f);
      writeFileSync(p, readFileSync(p, 'utf8').replace('본문', '잘림'));
    }
    const r = spawnSync('node', [BATCH_QA, out, '--concurrency', '2'], { encoding: 'utf8', timeout: 240000 });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/main text differs from the authored page/);
  }, 300_000);

  it('the result list trusts a QA record only for the page bytes on disk now', () => {
    const out = join(scratch, 'index-trust');
    const b = spawnSync(
      'python3',
      [BATCH, '--page', tpl, '--refs', 'omd-toss,omd-pixiv', '--out', out, '--uiux', UIUX_ROOT],
      { encoding: 'utf8' },
    );
    expect(b.status, b.stderr).toBe(0);
    // A passing QA record for exactly the bytes batch.py wrote …
    const sha = (f: string) =>
      createHash('sha256')
        .update(readFileSync(join(out, f)))
        .digest('hex');
    const pages = ['omd-toss', 'omd-pixiv'].map((n) => ({
      name: n,
      file: `${n}.html`,
      page_sha256: sha(`${n}.html`),
      ok: true,
      problems: [],
    }));
    writeFileSync(join(out, 'qa.json'), JSON.stringify({ checked: 2, passed: 2, pages }));
    const index = () => {
      const r = spawnSync('python3', [BATCH, '--index-only', '--out', out], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      return readFileSync(join(out, 'index.html'), 'utf8');
    };
    expect(index()).toMatch(/2개 중 QA 통과 2개/);
    // … no longer counts once the page is edited after QA.
    writeFileSync(
      join(out, 'omd-pixiv.html'),
      readFileSync(join(out, 'omd-pixiv.html'), 'utf8').replace('본문', '수정'),
    );
    const after = index();
    expect(after).toMatch(/2개 중 QA 통과 1개/);
    expect(after).toMatch(/omd-pixiv\.html[^\n]*QA 대기/);
  });

  it('batch-qa refuses to run when the authored page changed after the batch was rendered', () => {
    const out = join(scratch, 'tpl-changed');
    const page = join(scratch, 'page-changed.html');
    writeFileSync(page, readFileSync(tpl, 'utf8'));
    const b = spawnSync('python3', [BATCH, '--page', page, '--refs', 'omd-toss', '--out', out, '--uiux', UIUX_ROOT], {
      encoding: 'utf8',
    });
    expect(b.status, b.stderr).toBe(0);
    writeFileSync(page, readFileSync(page, 'utf8').replace('본문', '다른 본문'));
    const r = spawnSync('node', [BATCH_QA, out], { encoding: 'utf8', timeout: 60000 });
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/authored page changed since the batch was rendered/);
  });

  it('batch-qa exits non-zero when the output set differs from the expected set', () => {
    const out = join(scratch, 'out');
    rmSync(join(out, 'omd-pixiv.html'));
    const r = spawnSync('node', [BATCH_QA, out], { encoding: 'utf8', timeout: 60000 });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/missing: omd-pixiv/);
  });
});
