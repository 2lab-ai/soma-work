/**
 * AI Answer → the session panel's assistant turns (.prd/affectui/re-ai-answer.md, #440).
 * Executes the shipped client code cut out of renderDashboardPage()'s template
 * literal, cooked exactly as the browser receives it (the harness of
 * dashboard-three-surfaces-client.test.ts). Each block cites the D-decision it pins.
 *
 *   face     = the answer itself (task view T1.4, SSOT 2026-10-27), loaded as it
 *              nears the view; the turn summary and the answer as written sit
 *              in "Raw" at the turn's foot
 *   answer   = rendered markdown; the links the answer holds as numbered link
 *              cards and link chips that light each other — called 링크, never
 *              출처/인용: appearing in the answer does not prove a source (R1 P1)
 *   take-out = copy (answer + numbered links), the response time, a
 *              "응답 작성 중" row while the session is writing
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function declarationCount(name: string): number {
  const re = new RegExp(`^(?:async function|function|var|let|const) ${name.replace(/[$]/g, '\\$')}\\b`, 'gm');
  return (TEMPLATE.match(re) ?? []).length;
}
const FN_CACHE = new Map<string, string>();
function clientFn(name: string): string {
  const hit = FN_CACHE.get(name);
  if (hit !== undefined) return hit;
  const n = declarationCount(name);
  if (n > 1) throw new Error(`client ${name} is declared ${n} times`);
  let start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) start = TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  const src = cook(TEMPLATE.slice(start + 1, end + 2));
  FN_CACHE.set(name, src);
  return src;
}
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
/** `__set(name, value)` reassigns an injected binding (e.g. `_panelGen`) after load, as the page would. */
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const setter = '__set: function(n, v) { eval(n + " = v"); }';
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${[...fns, setter].join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
/** The <style> block as served. */
const CSS = cook(TEMPLATE.slice(TEMPLATE.indexOf('<style>'), TEMPLATE.indexOf('</style>')));
/** Bodies of every `@media (prefers-reduced-motion: reduce) { … }` block. */
function reduceBlocks(css: string): string[] {
  const out: string[] = [];
  const head = '@media (prefers-reduced-motion: reduce) {';
  let at = css.indexOf(head);
  while (at >= 0) {
    let depth = 0;
    let i = at + head.length - 1;
    for (; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) break;
    }
    out.push(css.slice(at, i + 1));
    at = css.indexOf(head, i);
  }
  return out;
}

const T0 = 1_700_000_000_000;
const PR = 'https://github.com/2lab-ai/soma-work/pull/999';
const SESSION = {
  conversationId: 'conv-run',
  activityState: 'working',
  prUrl: PR,
  prTitle: 'feat(dashboard): model picker',
};
/** The harness fixture's assistant turn t2 (conv-run). */
const FIXTURE = [
  'The picker now has **three bars** per model and the tray shows the first-token time and price.',
  '',
  '- Speed, quality and cost come from the model catalog [1]',
  '- Effort unfolds under the thinking switch [2]',
  '- The tray multiplies the latency by the effort [1,2]',
  '',
  `See \`src/conversation/dashboard.ts\` and ${PR} for the diff.`,
].join('\n');

type Src = { n: number; href: string; name: string; title: string; chip: string };
type Ans = {
  ansLinkify(raw: string): string;
  ansSourceOf(href: string, label: string, s: unknown): Src;
  ansSourcesHtml(srcs: Src[]): string;
  renderAnswer(raw: string, s: unknown): { html: string; sources: Src[] };
  ansStateHtml(kind: string, detail?: string): string;
  renderAnswerCard(raw: string, s: unknown): string;
  ansCopyText(raw: string, srcs: Array<Pick<Src, 'n' | 'title' | 'href'>>): string;
};
const ANS_FNS = [
  'esc',
  'escAttr',
  'safeHref',
  'mdInline',
  'renderMarkdownDoc',
  'ansUnesc',
  'ansKey',
  'ansDecode',
  'ansCacheKey',
  'ansParens',
  'ansLinkifyText',
  'ansLinkify',
  'ansSourceOf',
  'ansCiteHtml',
  'ansSourcesHtml',
  'renderAnswer',
  'ansStateHtml',
  'renderAnswerCard',
  'ansCopyText',
];
let ANS: Ans | undefined;
/** The pure answer functions (no injected state) — cooked once. */
const ans = (): Ans => {
  ANS ??= load<Ans>(ANS_FNS, []);
  return ANS;
};

describe('D1 · task view T1.4 — the answer is the face; the summary and the source sit in Raw', () => {
  const turn = (extra: Record<string, unknown>, cid = 'conv-run') => {
    const api = load<{ renderTurn(t: unknown, i?: number, arr?: unknown[], cid?: string): string }>(
      ['esc', 'escJs', 'toNum', 'ansStateHtml', 'renderTurn'],
      [],
      { panelConvId: cid, _artCache: {}, renderTurnArtifacts: () => '' },
    );
    return api.renderTurn({ id: 't2', role: 'assistant', timestamp: T0, ...extra }, 0, [], cid);
  };

  it('a busy answer card, a response-time slot, and Raw (요약 + 원문) at the foot', () => {
    const out = turn({ summaryTitle: 'Picker bars', summaryBody: 'Three bars per model.', summarized: true });
    expect(out).toContain(
      '<div class="turn-answer" data-conv="conv-run" data-turn="t2"><div class="ans-card" aria-busy="true"><span class="ans-loading">불러오는 중…</span></div></div>',
    );
    expect(out).toContain('<span class="ans-took"></span>');
    expect(out).toContain(
      '<details class="turn-raw"><summary class="turn-expand-btn">Raw</summary><div class="turn-raw-body">' +
        '<div class="turn-raw-label">요약</div><div class="turn-raw-summary"><div class="turn-summary-title">Picker bars</div>' +
        '<div class="turn-summary-body">Three bars per model.</div></div>' +
        '<div class="turn-raw-label">원문</div><pre class="turn-raw-src"></pre></div></details>',
    );
    // The answer first, Raw at the turn's foot (after the turn's files).
    expect(out.indexOf('class="turn-answer"')).toBeLessThan(out.indexOf('class="turn-arts"'));
    expect(out.indexOf('class="turn-arts"')).toBeLessThan(out.indexOf('class="turn-raw"'));
    // The summary is no longer the face, and the lazy "답변 전문" disclosure is gone.
    expect(out.slice(0, out.indexOf('class="turn-raw"'))).not.toContain('turn-summary-title');
    expect(out).not.toContain('turn-raw-details');
    expect(out).not.toContain('답변 전문');
    expect(out).not.toContain('Show raw response');
  });

  it('Summary failed + Retry and "Generating summary..." are kept (in Raw)', () => {
    expect(turn({ summarized: true })).toMatch(
      /<div class="turn-raw-summary"><div class="turn-summary-body"[^>]*>Summary failed <button[^>]*resummarize\(/,
    );
    expect(turn({})).toMatch(
      /<div class="turn-raw-summary"><div class="turn-summary-body"[^>]*>Generating summary\.\.\./,
    );
  });

  it('a turn with no answer to load (no id or no conversation) shows its summary as before', () => {
    for (const out of [
      turn({ id: undefined, summaryTitle: 'Picker bars', summaryBody: 'Three bars per model.' }),
      turn({ summaryTitle: 'Picker bars', summaryBody: 'Three bars per model.' }, ''),
    ]) {
      expect(out).toContain(
        '<div class="turn-summary-title">Picker bars</div><div class="turn-summary-body">Three bars per model.</div>',
      );
      expect(out).not.toContain('turn-answer');
      expect(out).not.toContain('turn-raw');
      expect(out).not.toContain('ans-card');
    }
  });

  type Io = { observe(el: unknown): void; unobserve(el: unknown): void };
  const loader = (els: unknown[], cache: Record<string, string>, withIo: boolean) => {
    const observed: unknown[] = [];
    const unobserved: unknown[] = [];
    const made: Array<{ cb: (entries: unknown[]) => void; opts: unknown }> = [];
    class FakeIo implements Io {
      constructor(cb: (entries: unknown[]) => void, opts: unknown) {
        made.push({ cb, opts });
      }
      observe(el: unknown) {
        observed.push(el);
      }
      unobserve(el: unknown) {
        unobserved.push(el);
      }
    }
    const scroll = { id: 'panel-scroll' };
    const ansLoad = vi.fn();
    const api = load<{ attachRawToggleHandlers(): void }>(['ansCacheKey', 'attachRawToggleHandlers'], [], {
      document: {
        getElementById: (id: string) =>
          id === 'panel-turns'
            ? { querySelectorAll: (sel: string) => (sel === '.turn-answer[data-turn]' ? els : []) }
            : id === 'panel-scroll'
              ? scroll
              : null,
      },
      IntersectionObserver: withIo ? FakeIo : undefined,
      _ansIo: null,
      _rawLoadedCache: cache,
      ansLoad,
    });
    return { api, observed, unobserved, made, scroll, ansLoad };
  };
  const answerEl = (turnId: string) => ({ dataset: { conv: 'conv-run', turn: turnId } });

  it('every answer loads as it nears the view: observed once, rooted at the panel scroll, 800px ahead', () => {
    const a = answerEl('t2');
    const b = answerEl('t4');
    const cached = answerEl('t6');
    const h = loader([a, b, cached], { 'conv-run:t6': 'cached answer' }, true);
    h.api.attachRawToggleHandlers();
    expect(h.made).toHaveLength(1);
    expect(h.made[0].opts).toEqual({ root: h.scroll, rootMargin: '800px 0px' });
    expect(h.observed).toEqual([a, b]);
    // A cached answer paints at once — it does not wait for the view.
    expect(h.ansLoad.mock.calls).toEqual([[cached]]);
    // Another insert path runs it again: nothing is observed or loaded twice.
    h.api.attachRawToggleHandlers();
    expect(h.made).toHaveLength(1);
    expect(h.observed).toEqual([a, b]);
    expect(h.ansLoad).toHaveBeenCalledTimes(1);
    // Nearing the view loads it, once.
    h.made[0].cb([
      { isIntersecting: false, target: b },
      { isIntersecting: true, target: a },
    ]);
    expect(h.unobserved).toEqual([a]);
    expect(h.ansLoad.mock.calls).toEqual([[cached], [a]]);
  });

  it('without IntersectionObserver every answer loads at once', () => {
    const a = answerEl('t2');
    const b = answerEl('t4');
    const h = loader([a, b], {}, false);
    h.api.attachRawToggleHandlers();
    expect(h.observed).toEqual([]);
    expect(h.ansLoad.mock.calls).toEqual([[a], [b]]);
  });
});

describe('D3 — links the answer holds become markdown links (code stays as written)', () => {
  it('bare URLs, trailing punctuation, <url> and <url|label>', () => {
    const a = ans();
    expect(a.ansLinkify('See https://github.com/x/y/pull/1 now')).toBe(
      'See [https://github.com/x/y/pull/1](https://github.com/x/y/pull/1) now',
    );
    expect(a.ansLinkify('(see https://a.com/b).')).toBe('(see [https://a.com/b](https://a.com/b)).');
    expect(a.ansLinkify('wiki https://en.wikipedia.org/wiki/Foo_(bar), ok')).toBe(
      // mdInline's link target stops at the first ")": parens travel encoded (review R1 ②).
      'wiki [https://en.wikipedia.org/wiki/Foo_(bar)](https://en.wikipedia.org/wiki/Foo_%28bar%29), ok',
    );
    expect(a.ansLinkify('<https://a.com/x|the doc> and <https://b.com>')).toBe(
      '[the doc](https://a.com/x) and [https://b.com](https://b.com)',
    );
  });

  it('markdown links, inline code, fences and non-http schemes are left alone', () => {
    const a = ans();
    for (const s of [
      '[PR](https://a.com/p) and ![img](https://a.com/i.png)',
      'run `curl https://a.com/x` first',
      '```\nhttps://a.com/in-fence\n```',
      'javascript:alert(1) and ftp://a.com',
    ]) {
      expect(a.ansLinkify(s)).toBe(s);
    }
    expect(a.renderAnswer('javascript:alert(1)', null).html).not.toContain('href="javascript');
    expect(a.renderAnswer('```\nhttps://a.com/in-fence\n```', null).sources).toEqual([]);
  });
});

describe('D3 · review R1 — links the plain renderer kept stay links', () => {
  it('① a markdown link whose label is a code span keeps its URL (no stray ")")', () => {
    const a = ans();
    const raw = 'See [`src/foo.ts`](https://github.com/o/r/blob/main/src/foo.ts).';
    expect(a.ansLinkify(raw)).toBe(raw);
    const { html, sources } = a.renderAnswer(raw, null);
    expect(sources.map((x) => x.href)).toEqual(['https://github.com/o/r/blob/main/src/foo.ts']);
    expect(html).toContain(
      'See <code>src/foo.ts</code><a class="ans-cite" data-ans-src="1" href="https://github.com/o/r/blob/main/src/foo.ts"',
    );
    expect(html).toMatch(/<\/a>\.<\/p>$/);
    // A code span that merely contains link syntax is still code.
    expect(a.renderAnswer('run `[x](https://a.com)` now', null).sources).toEqual([]);
  });

  it('② balanced parentheses survive — bare and in a markdown link target', () => {
    const a = ans();
    const bare = a.renderAnswer('wiki https://en.wikipedia.org/wiki/Foo_(bar), ok', null);
    expect(bare.sources.map((x) => x.href)).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
    expect(bare.html).toContain(
      'wiki <a class="ans-cite" data-ans-src="1" href="https://en.wikipedia.org/wiki/Foo_(bar)"',
    );
    expect(bare.html).toMatch(/<\/a>, ok<\/p>$/);
    const md = a.renderAnswer('[Foo](https://en.wikipedia.org/wiki/Foo_(bar))', null);
    expect(md.sources.map((x) => x.href)).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
    expect(md.html).toMatch(/^<p>Foo<a class="ans-cite"[^>]*>en\.wikipedia\.org<\/a><\/p>$/);
    expect(md.sources[0].title).toBe('Foo');
  });

  it('③ a fenced block inside a quote stays code; the fence ends with the quote', () => {
    const a = ans();
    const raw = '> ```sh\n> curl https://example.com\n> ```';
    expect(a.ansLinkify(raw)).toBe(raw);
    const r = a.renderAnswer(raw, null);
    expect(r.sources).toEqual([]);
    expect(r.html).toContain(
      '<blockquote><pre class="md-code"><code data-lang="sh">curl https://example.com</code></pre></blockquote>',
    );
    // An unclosed fence inside a quote ends where the quote ends.
    expect(a.ansLinkify('> ```\n> x\nsee https://a.com')).toBe('> ```\n> x\nsee [https://a.com](https://a.com)');
  });
});

describe('D4 — links: numbered by first appearance, one per URL, none invented', () => {
  it('order and de-duplication (a trailing slash is the same URL)', () => {
    const r = ans().renderAnswer('a https://b.com/x/ and https://c.org then [again](https://b.com/x)', null);
    expect(r.sources.map((s) => [s.n, s.href])).toEqual([
      [1, 'https://b.com/x/'],
      [2, 'https://c.org'],
    ]);
    expect((r.html.match(/data-ans-src="\d"/g) ?? []).join(' ')).toBe(
      'data-ans-src="1" data-ans-src="2" data-ans-src="1"',
    );
    // The first label that is not the URL itself titles the link card.
    expect(r.sources[0].title).toBe('again');
  });

  it('no links → no cards and no chips; a bare [1] stays text', () => {
    const r = ans().renderAnswer('plain [1] text [1,2]', null);
    expect(r.sources).toEqual([]);
    expect(r.html).toContain('plain [1] text [1,2]');
    expect(r.html).not.toContain('ans-cite');
  });
});

describe('D5 — name, title and chip label come from the URL, its label, or the session', () => {
  const of = (href: string, label = '', s: unknown = null) => {
    const { name, title, chip } = ans().ansSourceOf(href, label, s);
    return { name, title, chip };
  };
  it('GitHub pull / issue / commit / repo path', () => {
    expect(of(PR)).toEqual({ name: 'GitHub', title: 'PR #999 · 2lab-ai/soma-work', chip: '#999' });
    expect(of('https://github.com/o/r/issues/12')).toEqual({ name: 'GitHub', title: '이슈 #12 · o/r', chip: '#12' });
    expect(of('https://github.com/o/r/commit/abcdef1234567')).toEqual({
      name: 'GitHub',
      title: '커밋 abcdef1 · o/r',
      chip: 'abcdef1',
    });
    expect(of('https://github.com/o/r/blob/main/src/a%20b.ts')).toEqual({
      name: 'GitHub',
      title: 'o/r · blob/main/src/a b.ts',
      chip: 'GitHub',
    });
  });
  it('other hosts: host without www., path (or the host) as title', () => {
    expect(of('https://www.notion.so/Offsite-plan-123')).toEqual({
      name: 'notion.so',
      title: '/Offsite-plan-123',
      chip: 'notion.so',
    });
    expect(of('https://example.com/')).toEqual({ name: 'example.com', title: 'example.com', chip: 'example.com' });
  });
  it('precedence: session title > link label > derived', () => {
    expect(of(PR, 'the diff').title).toBe('the diff');
    expect(of(PR, 'the diff', SESSION).title).toBe('feat(dashboard): model picker');
    expect(of(`${PR}/`, '', SESSION).title).toBe('feat(dashboard): model picker');
    const issue = { issueUrl: 'https://github.com/o/r/issues/7', issueTitle: 'Crash on open' };
    expect(of('https://github.com/o/r/issues/7', '', issue).title).toBe('Crash on open');
  });
});

describe('D6 · D9 — the answer card: link row, label, body, foot', () => {
  it('two links: numbered list, label "답변 · 링크 2", copy + polite status', () => {
    const out = ans().renderAnswerCard('One https://a.com/x and two https://b.com/y.', null);
    expect(out).toContain('<ol class="ans-srcs" aria-label="답변에 포함된 링크 2개">');
    expect((out.match(/class="ans-src"/g) ?? []).length).toBe(2);
    expect(out).toContain(
      '<a class="ans-src" data-ans-src="2" href="https://b.com/y" target="_blank" rel="noopener noreferrer" title="https://b.com/y">',
    );
    expect(out).toContain('<span class="ans-src-name">b.com</span><span class="ans-src-num">2</span>');
    expect(out).toContain('<span class="ans-src-title">/y</span>');
    expect(out).toContain('<div class="ans-label">답변 · 링크 2</div>');
    expect(out).toContain('<div class="ans-body md-doc">');
    expect(out).toContain('<button type="button" class="btn-action ans-copy">복사</button>');
    expect(out).toContain('<span class="ans-status" role="status" aria-live="polite"></span>');
    // Links come before the answer, where the reference puts its sources.
    expect(out.indexOf('ans-srcs')).toBeLessThan(out.indexOf('ans-body'));
  });

  it('no links: no row, label "답변"; an empty answer says so', () => {
    const out = ans().renderAnswerCard('Just text.', null);
    expect(out).not.toContain('ans-srcs');
    expect(out).toContain('<div class="ans-label">답변</div>');
    expect(ans().renderAnswerCard('  ', null)).toContain('기록된 답변 내용이 없습니다');
  });

  it('link cards stagger by index, capped at 6', () => {
    const srcs = Array.from({ length: 8 }, (_, i) => ({
      n: i + 1,
      href: `https://h${i}.com`,
      name: `h${i}.com`,
      title: 't',
      chip: 'c',
    }));
    const out = ans().ansSourcesHtml(srcs);
    expect(out).toContain('<li style="--ans-i:0">');
    expect(out).toContain('<li style="--ans-i:6">');
    expect(out).not.toContain('--ans-i:7');
  });
});

describe('D7 — link chips sit where the links were', () => {
  it('the fixture answer: markdown rendered, the bare PR URL is one chip named after its card', () => {
    const { html, sources } = ans().renderAnswer(FIXTURE, SESSION);
    expect(sources).toHaveLength(1);
    expect(html).toContain('<strong>three bars</strong>');
    expect(html).toContain('<code>src/conversation/dashboard.ts</code>');
    expect(html).toContain('<li>Effort unfolds under the thinking switch [2]</li>');
    expect(html).toContain(
      `and <a class="ans-cite" data-ans-src="1" href="${PR}" target="_blank" rel="noopener noreferrer" aria-label="링크 1: feat(dashboard): model picker (GitHub)">#999</a> for the diff.`,
    );
    expect(html).not.toContain('>https://github.com');
  });

  it('a labelled link keeps its words as text, followed by the chip', () => {
    const { html } = ans().renderAnswer('See [the diff](https://a.com/d).', null);
    expect(html).toContain('See the diff<a class="ans-cite" data-ans-src="1" href="https://a.com/d"');
    expect(html).not.toContain('<a href=');
  });
});

describe('D2 · D18 — everything model-written is escaped', () => {
  it('markup, quotes and scripts cannot escape', () => {
    const { html } = ans().renderAnswer('**a** <script>alert(1)</script> [say "hi"](https://a.com/x)', null);
    expect(html).toContain('<strong>a</strong>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script');
    expect(html).toContain('say &quot;hi&quot;<a class="ans-cite"');
    expect(html).toContain('aria-label="링크 1: say &quot;hi&quot; (a.com)"');
  });
});

describe('D8 — a chip lights its card, a card lights its chips', () => {
  type El = {
    attr: string;
    classList: { set: Set<string>; toggle(c: string, on: boolean): void };
    getAttribute(n: string): string;
  };
  const el = (n: string): El => {
    const set = new Set<string>();
    return {
      attr: n,
      classList: { set, toggle: (c, on) => (on ? set.add(c) : set.delete(c)) },
      getAttribute: () => n,
    };
  };
  const card = (srcLeft: number, scrollTo = vi.fn()) => {
    const els = [el('1'), el('2'), el('2')];
    const src = { getBoundingClientRect: () => ({ left: srcLeft, right: srcLeft + 148 }) };
    const row = {
      scrollLeft: 0,
      scrollTo,
      getBoundingClientRect: () => ({ left: 0, right: 300 }),
      querySelector: () => src,
    };
    return { els, row, scrollTo, querySelectorAll: () => els, querySelector: () => row };
  };
  const api = (reduce: boolean) =>
    load<{ ansLight(card: unknown, n: string | null, on: boolean): void }>(['ansLight'], [], {
      reduceMotion: () => reduce,
    });

  it('lights only the same number, clears all on leave', () => {
    const c = card(10);
    api(false).ansLight(c, '2', true);
    expect(c.els.map((e) => e.classList.set.has('is-lit'))).toEqual([false, true, true]);
    api(false).ansLight(c, null, false);
    expect(c.els.some((e) => e.classList.set.has('is-lit'))).toBe(false);
  });

  it('slides only the link row (never the panel) to a lit card out of view', () => {
    const c = card(320);
    api(false).ansLight(c, '2', true);
    expect(c.scrollTo).toHaveBeenCalledWith({ left: 184, behavior: 'smooth' });
    const r = card(320);
    api(true).ansLight(r, '2', true);
    expect(r.scrollTo).toHaveBeenCalledWith({ left: 184, behavior: 'auto' });
    const inView = card(10);
    api(false).ansLight(inView, '2', true);
    expect(inView.scrollTo).not.toHaveBeenCalled();
    expect(clientFn('ansLight')).not.toContain('scrollIntoView');
  });

  it('one set of delegated listeners on #panel-turns, bound once', () => {
    const root = { addEventListener: vi.fn() };
    const a = load<{ ansBind(r: unknown): void }>(['ansBind'], []);
    a.ansBind(root);
    a.ansBind(root);
    expect(root.addEventListener.mock.calls.map((c) => c[0]).sort()).toEqual(
      ['click', 'focusin', 'focusout', 'mouseout', 'mouseover'].sort(),
    );
    expect(TEMPLATE).toContain("ansBind(document.getElementById('panel-turns'));");
  });
});

describe('D10 — copy: the answer plus its numbered links', () => {
  it('ansCopyText keeps the markdown and appends 링크', () => {
    const a = ans();
    expect(a.ansCopyText('Body **text**\n', [{ n: 1, title: 'T', href: 'https://a' }])).toBe(
      'Body **text**\n\n링크:\n[1] T – https://a',
    );
    expect(a.ansCopyText('Body', [])).toBe('Body');
  });

  const harness = (clipboard: unknown, doc: Record<string, unknown> = {}) => {
    const status = { textContent: '' };
    const body = {};
    const btn: Record<string, unknown> = { textContent: '복사' };
    // Task view T1.4: the answer is the turn's .turn-answer (no "답변 전문" disclosure).
    const answer = { dataset: { turn: 't2', conv: 'conv-run' } };
    const cardEl = { querySelector: (sel: string) => (sel === '.ans-status' ? status : body) };
    btn.closest = (sel: string) => (sel === '.turn-answer' ? answer : sel === '.ans-card' ? cardEl : null);
    const addRange = vi.fn();
    const timers: number[] = [];
    const api = load<{ copyAnswer(b: unknown): void }>([...ANS_FNS, 'ansSession', 'copyAnswer'], [], {
      _rawLoadedCache: { 'conv-run:t2': FIXTURE },
      panelSessionKey: 'k',
      _sessionCache: { k: SESSION },
      navigator: { clipboard },
      document: { createRange: () => ({ selectNodeContents: vi.fn() }), ...doc },
      window: { getSelection: () => ({ removeAllRanges: vi.fn(), addRange }) },
      setTimeout: (_f: unknown, ms: number) => {
        timers.push(ms);
        return 1;
      },
      clearTimeout: () => {},
    });
    return { api, btn, status, addRange, timers };
  };

  it('success: "복사됨" for 1500 ms and a polite announcement', async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    const h = harness({ writeText });
    h.api.copyAnswer(h.btn);
    await Promise.resolve();
    await Promise.resolve();
    expect(writeText.mock.calls[0][0]).toContain(`for the diff.\n\n링크:\n[1] feat(dashboard): model picker – ${PR}`);
    expect(h.btn.textContent).toBe('복사됨');
    expect(h.status.textContent).toBe('답변과 링크 1개를 복사했습니다');
    expect(h.timers).toContain(1500);
  });

  it('no clipboard (or refused): the answer is selected instead', async () => {
    const h = harness(undefined);
    h.api.copyAnswer(h.btn);
    expect(h.addRange).toHaveBeenCalled();
    expect(h.status.textContent).toBe('선택했습니다 — ⌘C / Ctrl+C로 복사');
    const r = harness({ writeText: () => Promise.reject(new Error('denied')) });
    r.api.copyAnswer(r.btn);
    await Promise.resolve();
    await Promise.resolve();
    expect(r.addRange).toHaveBeenCalled();
  });

  it('review R1 (P3): without the Clipboard API the RAW text is copied from a temporary textarea', () => {
    const ta: Record<string, unknown> = { style: {}, setAttribute: vi.fn(), select: vi.fn(), remove: vi.fn() };
    const appendChild = vi.fn();
    const execCommand = vi.fn(() => true);
    const h = harness(undefined, { createElement: () => ta, body: { appendChild }, execCommand });
    h.api.copyAnswer(h.btn);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(String(ta.value)).toContain(`and ${PR} for the diff.\n\n링크:\n[1] feat(dashboard): model picker – ${PR}`);
    expect(ta.remove).toHaveBeenCalled();
    expect(h.addRange).not.toHaveBeenCalled();
    expect(h.btn.textContent).toBe('복사됨');
    expect(h.status.textContent).toBe('답변과 링크 1개를 복사했습니다');
  });
});

describe('D11 — response time = this answer − the instruction before it', () => {
  it('ansTookLabel', () => {
    const { ansTookLabel } = load<{ ansTookLabel(ms: number): string }>(['ansTookLabel'], []);
    expect(ansTookLabel(0)).toBe('');
    expect(ansTookLabel(-5)).toBe('');
    expect(ansTookLabel(Number.NaN)).toBe('');
    expect(ansTookLabel(500)).toBe('응답 1초 미만');
    expect(ansTookLabel(42_000)).toBe('응답 42초');
    expect(ansTookLabel(252_000)).toBe('응답 4분 12초');
    expect(ansTookLabel(3_780_000)).toBe('응답 1시간 3분');
  });

  it('only when the turn before is a user turn', () => {
    const { ansTookFor } = load<{ ansTookFor(r: string, p: number, t: number): string }>(
      ['toNum', 'ansTookLabel', 'ansTookFor'],
      [],
    );
    expect(ansTookFor('user', T0, T0 + 60_000)).toBe('응답 1분 0초');
    expect(ansTookFor('assistant', T0, T0 + 60_000)).toBe('');
    expect(ansTookFor('user', 0, T0)).toBe('');
  });

  it('decorateAnswerTurns fills each answer from the DOM order, and decoratePanelTurns runs it', () => {
    const node = (role: string, ts: number) => {
      const took = { textContent: '', attrs: {} as Record<string, string> };
      return {
        took,
        classList: { contains: (c: string) => c === role },
        getAttribute: () => String(ts),
        querySelector: () =>
          role === 'assistant'
            ? {
                get textContent() {
                  return took.textContent;
                },
                set textContent(v: string) {
                  took.textContent = v;
                },
                setAttribute: (k: string, v: string) => {
                  took.attrs[k] = v;
                },
                removeAttribute: (k: string) => {
                  delete took.attrs[k];
                },
              }
            : null,
      };
    };
    const nodes = [node('user', T0), node('assistant', T0 + 60_000), node('assistant', T0 + 90_000)];
    const sync = vi.fn();
    const api = load<{ decorateAnswerTurns(): void }>(
      ['toNum', 'formatTaskTime', 'ansTookLabel', 'ansTookFor', 'decorateAnswerTurns'],
      [],
      {
        document: { getElementById: () => ({ querySelectorAll: () => nodes }) },
        syncAnsPending: sync,
      },
    );
    api.decorateAnswerTurns();
    expect(nodes[1].took.textContent).toBe('응답 1분 0초');
    expect(nodes[1].took.attrs.title).toMatch(/^지시 .+ → 응답 .+$/);
    expect(nodes[2].took.textContent).toBe('');
    expect(nodes[2].took.attrs.title).toBeUndefined();
    expect(sync).toHaveBeenCalled();
    expect(clientFn('decoratePanelTurns')).toContain('decorateAnswerTurns();');
  });

  it("review R1 (P3): no time against an optimistic instruction (this browser's clock)", () => {
    const took = { textContent: 'x', setAttribute: vi.fn(), removeAttribute: vi.fn() };
    const nodes = [
      {
        classList: { contains: (c: string) => c === 'user' },
        getAttribute: (n: string) => (n === 'data-ts' ? String(T0) : 'optimistic-1700000000000'),
        querySelector: () => null,
      },
      {
        classList: { contains: (c: string) => c === 'assistant' },
        getAttribute: (n: string) => (n === 'data-ts' ? String(T0 + 60_000) : 't9'),
        querySelector: () => took,
      },
    ];
    const api = load<{ decorateAnswerTurns(): void }>(
      ['toNum', 'formatTaskTime', 'ansTookLabel', 'ansTookFor', 'decorateAnswerTurns'],
      [],
      {
        document: { getElementById: () => ({ querySelectorAll: () => nodes }) },
        syncAnsPending: () => {},
      },
    );
    api.decorateAnswerTurns();
    expect(took.textContent).toBe('');
    expect(took.removeAttribute).toHaveBeenCalledWith('title');
  });
});

describe('D12 — "응답 작성 중" while the session writes the answer', () => {
  it('ansPendingShow: working, this conversation, the last turn is the instruction', () => {
    const { ansPendingShow } = load<{ ansPendingShow(s: unknown, cid: unknown, last: string): boolean }>(
      ['ansPendingShow'],
      [],
    );
    const s = { conversationId: 'c', activityState: 'working' };
    expect(ansPendingShow(s, 'c', 'user')).toBe(true);
    expect(ansPendingShow({ ...s, activityState: 'idle' }, 'c', 'user')).toBe(false);
    expect(ansPendingShow(s, 'other', 'user')).toBe(false);
    expect(ansPendingShow(s, 'c', 'assistant')).toBe(false);
    expect(ansPendingShow(null, 'c', 'user')).toBe(false);
  });

  it('ansPendingHtml: a busy assistant row, shimmer label, hidden pulse dot, no turn identity', () => {
    const { ansPendingHtml } = load<{ ansPendingHtml(): string }>(['ansPendingHtml'], []);
    const out = ansPendingHtml();
    expect(out).toContain('<div class="turn assistant ans-pending" aria-busy="true">');
    expect(out).toContain('<span class="ans-shimmer">응답 작성 중</span><i class="ans-dot" aria-hidden="true"></i>');
    expect(out).not.toContain('data-ts');
    expect(out).not.toContain('data-turn-id');
  });

  it('syncAnsPending adds the row last, removes it when not writing; repaintPanelSession runs it', () => {
    const run = (state: string, row: unknown) => {
      const insert = vi.fn();
      const turnsEl = {
        querySelectorAll: () => [{ classList: { contains: (c: string) => c === 'user' } }],
        querySelector: () => row,
        insertAdjacentHTML: insert,
        lastElementChild: row,
        appendChild: vi.fn(),
      };
      const api = load<{ syncAnsPending(): void }>(['ansPendingShow', 'ansPendingHtml', 'syncAnsPending'], [], {
        document: { getElementById: () => turnsEl },
        panelOpen: true,
        panelSessionKey: 'k',
        panelConvId: 'c',
        _sessionCache: { k: { conversationId: 'c', activityState: state } },
      });
      api.syncAnsPending();
      return { insert, turnsEl };
    };
    const added = run('working', null);
    expect(added.insert).toHaveBeenCalledWith('beforeend', expect.stringContaining('ans-pending'));
    const old = { remove: vi.fn() };
    run('idle', old);
    expect(old.remove).toHaveBeenCalled();
    expect(clientFn('repaintPanelSession')).toContain('syncAnsPending();');
  });
});

describe('D12 — the writing row through the real insert paths (cross-spec review R1)', () => {
  /** A tiny list DOM: one node per inserted turn, parsed from the markup the client writes. */
  type Node = {
    cls: Set<string>;
    ts: number | null;
    took: { textContent: string; setAttribute(): void; removeAttribute(): void };
    classList: { contains(c: string): boolean };
    getAttribute(n: string): string | null;
    querySelector(sel: string): unknown;
    remove(): void;
    replaceWith(n: Node): void;
  };
  const world = () => {
    const children: Node[] = [];
    const parse = (html: string): Node => {
      const cls = new Set((/class="([^"]*)"/.exec(html)?.[1] ?? '').split(' '));
      const ts = /data-ts="(\d+)"/.exec(html);
      const took = { textContent: '', setAttribute: () => {}, removeAttribute: () => {} };
      const node: Node = {
        cls,
        ts: ts ? Number(ts[1]) : null,
        took,
        classList: { contains: (c) => cls.has(c) },
        getAttribute: (n) => (n === 'data-ts' && node.ts !== null ? String(node.ts) : null),
        querySelector: (sel) => (sel === '.ans-took' ? took : sel === '.turn-arts' ? { innerHTML: '' } : null),
        remove: () => {
          const i = children.indexOf(node);
          if (i >= 0) children.splice(i, 1);
        },
        replaceWith: (n) => {
          children[children.indexOf(node)] = n;
        },
      };
      return node;
    };
    const turnsEl = {
      children,
      querySelectorAll: (sel: string) => (sel === '.turn[data-ts]' ? children.filter((c) => c.ts !== null) : []),
      querySelector: (sel: string) =>
        sel === '.ans-pending' ? (children.find((c) => c.cls.has('ans-pending')) ?? null) : null,
      insertAdjacentHTML: (pos: string, html: string) => {
        if (pos === 'beforeend') children.push(parse(html));
        else children.unshift(parse(html));
      },
      get lastElementChild() {
        return children[children.length - 1] ?? null;
      },
      appendChild: (n: Node) => {
        children.splice(children.indexOf(n), 1);
        children.push(n);
      },
    };
    const sessions: Record<string, { conversationId: string; activityState: string }> = {
      k: { conversationId: 'c', activityState: 'working' },
    };
    const renderTurn = (t: { role: string; timestamp: number }) =>
      `<div class="turn ${t.role}" data-turn-id="x" data-ts="${t.timestamp}"></div>`;
    const api = load<{
      appendTurnToPanel(t: unknown): void;
      updateTurnInPanel(e: unknown, t: unknown): void;
      decoratePanelTurns(): void;
      syncAnsPending(): void;
    }>(
      [
        'toNum',
        'formatTaskTime',
        'ansTookLabel',
        'ansTookFor',
        'ansPendingShow',
        'ansPendingHtml',
        'syncAnsPending',
        'decorateAnswerTurns',
        'decoratePanelTurns',
        'appendTurnToPanel',
        'updateTurnInPanel',
      ],
      [],
      {
        document: {
          getElementById: (id: string) =>
            id === 'panel-turns' ? turnsEl : { scrollHeight: 0, scrollTop: 0, clientHeight: 0 },
          createElement: () => {
            const tmp = { firstElementChild: null as Node | null };
            return Object.defineProperty(tmp, 'innerHTML', {
              set: (html: string) => {
                tmp.firstElementChild = parse(html);
              },
            });
          },
        },
        renderTurn,
        attachRawToggleHandlers: () => {},
        ansLoad: () => {},
        panelOpen: true,
        panelSessionKey: 'k',
        panelConvId: 'c',
        _sessionCache: sessions,
        _artCache: {},
        artInTurn: () => false,
        renderTurnArtifacts: () => '',
      },
    );
    const order = () =>
      children.map((c) => (c.cls.has('ans-pending') ? 'pending' : c.cls.has('user') ? 'user' : 'assistant')).join(' ');
    return { api, children, sessions, order, parse };
  };

  it('opened on an instruction: the row is added, stays last when another instruction lands, survives a re-render, goes when the answer lands', () => {
    const w = world();
    w.children.push(w.parse(`<div class="turn user" data-ts="${T0}"></div>`));
    w.api.decoratePanelTurns(); // openPanel / loadMore path
    expect(w.order()).toBe('user pending');

    w.api.appendTurnToPanel({ role: 'user', timestamp: T0 + 5_000 }); // lands AFTER the row …
    expect(w.order()).toBe('user user pending'); // … and the row moves back to the end

    w.api.updateTurnInPanel(w.children[0], { role: 'user', timestamp: T0 }); // a turn re-rendered in place
    expect(w.order()).toBe('user user pending');

    w.api.appendTurnToPanel({ role: 'assistant', timestamp: T0 + 65_000 }); // the answer lands
    expect(w.order()).toBe('user user assistant');
    expect(w.children[2].took.textContent).toBe('응답 1분 0초');
  });

  it('the session leaving "working" removes the row (repaintPanelSession → syncAnsPending)', () => {
    const w = world();
    w.children.push(w.parse(`<div class="turn user" data-ts="${T0}"></div>`));
    w.api.decoratePanelTurns();
    expect(w.order()).toBe('user pending');
    w.sessions.k.activityState = 'idle';
    w.api.syncAnsPending();
    expect(w.order()).toBe('user');
  });
});

describe('D12 · review R1 (P1) — a failed send is marked although the writing row is last', () => {
  it('the optimistic turn is found by its id, not ":last-child"', async () => {
    const optimistic = { style: {} as Record<string, string>, insertAdjacentHTML: vi.fn() };
    let optimisticId = '';
    const el: Record<string, Record<string, unknown>> = {
      'cmd-input': { value: 'a follow-up while it works', disabled: false, focus: () => {} },
      'cmd-send': { disabled: false, textContent: 'Send' },
    };
    const bodies: string[] = [];
    const api = load<{ sendCommand(): Promise<void> }>(
      ['esc', 'escJs', 'pcCanSend', 'pcCommandBody', 'sendCommand'],
      [],
      {
        document: {
          getElementById: (id: string) => el[id] ?? null,
          // The 응답 작성 중 row is the last child: ':last-child' finds no user turn.
          querySelector: (sel: string) =>
            optimisticId && sel === `.turn.user[data-turn-id="${optimisticId}"]` ? optimistic : null,
        },
        appendTurnToPanel: (t: { id: string }) => {
          optimisticId = t.id;
        },
        fetch: (_url: string, init: { body: string }) => {
          bodies.push(init.body);
          return Promise.resolve({ ok: false, status: 400 });
        },
        refreshCsrfToken: () => Promise.resolve(),
        panelSessionKey: 'k',
        _sessionCache: { k: { activityState: 'working' } },
        renderPanelComposer: () => {},
        _csrfToken: '',
        _lastSentContent: '',
        _lastSentTime: 0,
        // Task view T1.5 composer: no recording, no attached files.
        _pcRec: null,
        _pcFiles: [],
        _pcSending: false,
        pcStopRecording: () => {},
        pcAutosize: () => {},
        pcRemoveFile: () => {},
      },
    );
    await api.sendCommand();
    expect(bodies).toEqual([JSON.stringify({ message: 'a follow-up while it works' })]);
    expect(optimisticId).toMatch(/^optimistic-\d+$/);
    expect(optimistic.insertAdjacentHTML).toHaveBeenCalledWith('beforeend', expect.stringContaining('Failed to send.'));
    expect(optimistic.style.opacity).toBe('0.7');
    expect(clientFn('sendCommand')).not.toContain(':last-child');
  });
});

describe('D13 — loading, error, empty', () => {
  it('state markup', () => {
    const a = ans();
    expect(a.ansStateHtml('loading')).toBe('<span class="ans-loading">불러오는 중…</span>');
    const err = a.ansStateHtml('error', 'HTTP 404');
    expect(err).toContain('답변을 불러오지 못했습니다 (HTTP 404)');
    expect(err).toContain('<button type="button" class="btn-action" data-ans-retry="1">다시 시도</button>');
    expect(a.ansStateHtml('empty')).toContain('기록된 답변 내용이 없습니다');
  });

  /** The turn's summary, as renderTurn puts it in Raw (task view T1.4). */
  const SUMMARY =
    '<div class="turn-summary-title">Picker bars</div><div class="turn-summary-body">Three bars per model.</div>';
  const paintHarness = (cache: Record<string, string>, fetchImpl: unknown, summary = SUMMARY) => {
    const card = {
      innerHTML: '',
      attrs: { 'aria-busy': 'true' } as Record<string, string>,
      classList: { add: vi.fn(), remove: vi.fn() },
    };
    const cardApi = {
      ...card,
      setAttribute: (k: string, v: string) => {
        cardApi.attrs[k] = v;
      },
      removeAttribute: (k: string) => {
        delete cardApi.attrs[k];
      },
    };
    // The turn body: the answer, then Raw (요약 + 원문) at its foot.
    const rawSrc = { textContent: '' };
    const rawSummary = { innerHTML: summary };
    const turnBody = {
      querySelector: (sel: string) =>
        sel === '.turn-raw-src' ? rawSrc : sel === '.turn-raw-summary' ? rawSummary : null,
    };
    const details: Record<string, unknown> = {
      dataset: { turn: 't2', conv: 'conv-run' },
      parentNode: turnBody,
      querySelector: (sel: string) => (sel === '.ans-card' ? cardApi : null),
    };
    const api = load<{ ansLoad(d: unknown): void }>(
      [...ANS_FNS, 'ansSession', 'ansFallbackHtml', 'ansPaint', 'ansLoad'],
      [],
      {
        _rawLoadedCache: cache,
        _ansInflight: {},
        _panelGen: 0,
        panelSessionKey: 'k',
        _sessionCache: { k: SESSION },
        fetch: fetchImpl,
        reduceMotion: () => true,
        document: { getElementById: () => ({ contains: () => true }) },
      },
    );
    return { api, card: cardApi, details, rawSrc };
  };

  it('a cached answer paints at once without a request, and Raw holds it as written', () => {
    const fetch = vi.fn();
    const h = paintHarness({ 'conv-run:t2': '**hi**' }, fetch);
    h.api.ansLoad(h.details);
    expect(fetch).not.toHaveBeenCalled();
    expect(h.card.innerHTML).toContain('<strong>hi</strong>');
    expect(h.card.innerHTML).not.toContain('ans-fallback');
    expect(h.card.attrs['aria-busy']).toBeUndefined();
    expect(h.rawSrc.textContent).toBe('**hi**');
  });

  it('a failed request shows the summary, the status and a retry; a good one fills the cache', async () => {
    const bad = paintHarness(
      {},
      vi.fn(() => Promise.resolve({ ok: false, status: 404 })),
    );
    bad.api.ansLoad(bad.details);
    expect(bad.card.innerHTML).toBe('<span class="ans-loading">불러오는 중…</span>');
    expect(bad.card.attrs['aria-busy']).toBe('true');
    await new Promise((r) => setTimeout(r, 0));
    // Task view T1.4: the answer is the face, so a failure falls back to the summary first.
    expect(bad.card.innerHTML.startsWith(`<div class="ans-fallback">${SUMMARY}</div>`)).toBe(true);
    expect(bad.card.innerHTML).toContain('답변을 불러오지 못했습니다 (HTTP 404)');
    expect(bad.card.innerHTML).toContain('data-ans-retry');
    expect(bad.card.attrs['aria-busy']).toBeUndefined();
    expect(bad.rawSrc.textContent).toBe('');

    const cache: Record<string, string> = {};
    const fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ raw: FIXTURE }) }));
    const ok = paintHarness(cache, fetch);
    ok.api.ansLoad(ok.details);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetch).toHaveBeenCalledWith('/api/conversations/conv-run/turns/t2/raw');
    expect(cache['conv-run:t2']).toBe(FIXTURE);
    expect(ok.card.innerHTML).toContain('ans-cite');
    expect(ok.card.innerHTML).not.toContain('ans-fallback');
    expect(ok.card.attrs['aria-busy']).toBeUndefined();
    expect(ok.rawSrc.textContent).toBe(FIXTURE);
  });

  it('an empty answer says so under the summary; with no summary yet, only the state', async () => {
    const empty = paintHarness({}, () => Promise.resolve({ ok: true, json: () => Promise.resolve({ raw: '  ' }) }));
    empty.api.ansLoad(empty.details);
    await new Promise((r) => setTimeout(r, 0));
    expect(empty.card.innerHTML).toBe(`<div class="ans-fallback">${SUMMARY}</div>${ans().ansStateHtml('empty')}`);
    expect(empty.card.attrs['aria-busy']).toBeUndefined();

    const bare = paintHarness({ 'conv-run:t2': '' }, vi.fn(), '');
    bare.api.ansLoad(bare.details);
    expect(bare.card.innerHTML).toBe(ans().ansStateHtml('empty'));
  });
});

describe('D13 · review R1 — a raw response lands only where it is still current', () => {
  type Card = { innerHTML: string; attrs: Record<string, string> };
  type Details = { dataset: { conv: string; turn: string }; card: Card; querySelector(): unknown };
  const race = (cache: Record<string, string>) => {
    const pending: Array<{ url: string; ok(raw: string): void; fail(status: number): void }> = [];
    const fetch = vi.fn(
      (url: string) =>
        new Promise((resolve) =>
          pending.push({
            url,
            ok: (raw) => resolve({ ok: true, json: () => Promise.resolve({ raw }) }),
            fail: (status) => resolve({ ok: false, status }),
          }),
        ),
    );
    const attached = new Set<unknown>();
    const mk = (conv: string, turn: string): Details => {
      const card: Card = { innerHTML: '', attrs: {} };
      const api = {
        ...card,
        setAttribute: (k: string, v: string) => {
          d.card.attrs[k] = v;
        },
        removeAttribute: (k: string) => {
          delete d.card.attrs[k];
        },
        classList: { add: () => {}, remove: () => {} },
      };
      const d: Details = { dataset: { conv, turn }, card: api, querySelector: () => api };
      attached.add(d);
      return d;
    };
    const api = load<{ ansLoad(d: unknown): void; __set(n: string, v: unknown): void }>(
      [...ANS_FNS, 'ansSession', 'ansFallbackHtml', 'ansPaint', 'ansLoad'],
      [],
      {
        _rawLoadedCache: cache,
        _ansInflight: {},
        _panelGen: 0,
        panelSessionKey: null,
        _sessionCache: {},
        fetch,
        reduceMotion: () => true,
        document: { getElementById: () => ({ contains: (x: unknown) => attached.has(x) }) },
      },
    );
    return { api, pending, attached, mk, fetch };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('(1) the panel switched mid-flight: the late answer neither paints nor fills the cache', async () => {
    const cache: Record<string, string> = {};
    const h = race(cache);
    const d = h.mk('convA', 't2');
    h.api.ansLoad(d);
    h.api.__set('_panelGen', 1); // closePanel / openPanel
    h.pending[0].ok('**late A**');
    await flush();
    expect(d.card.innerHTML).toContain('불러오는 중…');
    expect(cache).toEqual({});

    // A late failure does not paint either.
    const e = race({});
    const d2 = e.mk('convA', 't3');
    e.api.ansLoad(d2);
    e.api.__set('_panelGen', 1);
    e.pending[0].fail(500);
    await flush();
    expect(d2.card.innerHTML).not.toContain('불러오지 못했습니다');
  });

  it('(1b) a disclosure that left the list (re-rendered) is not painted', async () => {
    const cache: Record<string, string> = {};
    const h = race(cache);
    const d = h.mk('convA', 't2');
    h.api.ansLoad(d);
    h.attached.delete(d);
    h.pending[0].ok('answer A');
    await flush();
    expect(d.card.innerHTML).toContain('불러오는 중…');
    expect(cache['convA:t2']).toBe('answer A'); // still this answer's text, under its own key
  });

  it('(2) two conversations with the same turn id never share an answer', async () => {
    const cache: Record<string, string> = { 'convA:t2': 'answer A' };
    const h = race(cache);
    const dB = h.mk('convB', 't2');
    h.api.ansLoad(dB);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.pending[0].url).toBe('/api/conversations/convB/turns/t2/raw');
    expect(dB.card.innerHTML).not.toContain('answer A');
    h.pending[0].ok('answer B');
    await flush();
    expect(dB.card.innerHTML).toContain('answer B');
    expect(cache).toEqual({ 'convA:t2': 'answer A', 'convB:t2': 'answer B' });
  });

  it('(3) a disclosure re-rendered mid-fetch (D14) joins the request in flight: one fetch, only the listed one paints', async () => {
    const cache: Record<string, string> = {};
    const h = race(cache);
    const d1 = h.mk('c', 't2');
    h.api.ansLoad(d1);
    h.attached.delete(d1); // the summary landed: the turn was re-rendered
    const d2 = h.mk('c', 't2');
    h.api.ansLoad(d2);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.pending[0].ok('the answer');
    await flush();
    expect(cache['c:t2']).toBe('the answer');
    expect(d2.card.innerHTML).toContain('the answer');
    expect(d1.card.innerHTML).not.toContain('the answer');
  });

  it('(3b) an older response arriving after a newer one does not overwrite it', async () => {
    const cache: Record<string, string> = {};
    const h = race(cache);
    const d1 = h.mk('c', 't2');
    h.api.ansLoad(d1); // request 1 (this panel opening)
    h.api.__set('_panelGen', 1); // closed and reopened while it was in flight
    const d2 = h.mk('c', 't2');
    h.api.ansLoad(d2); // request 2
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.pending[1].ok('new answer');
    await flush();
    h.pending[0].ok('old answer');
    await flush();
    expect(cache['c:t2']).toBe('new answer');
    expect(d2.card.innerHTML).toContain('new answer');
    expect(d1.card.innerHTML).not.toContain('old answer');
  });
});

describe('D15 · review R1 (fable P3) — the entry animation plays on load only', () => {
  // Task view T1.4: no disclosure to close and reopen — a turn re-rendered (its
  // summary landed, D14) paints its answer again from the cache, without the entry.
  const harness = (reduce: boolean) => {
    const classes = new Set<string>();
    const card = {
      innerHTML: '',
      offsetWidth: 0,
      setAttribute: () => {},
      removeAttribute: () => {},
      classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
    };
    const answerEl = () => ({ dataset: { conv: 'conv-run', turn: 't2' }, querySelector: () => card });
    const cache: Record<string, string> = {};
    const fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ raw: FIXTURE }) }));
    const api = load<{ ansLoad(d: unknown): void }>(
      [...ANS_FNS, 'ansSession', 'ansFallbackHtml', 'ansPaint', 'ansLoad'],
      [],
      {
        _rawLoadedCache: cache,
        _ansInflight: {},
        _panelGen: 0,
        panelSessionKey: 'k',
        _sessionCache: { k: SESSION },
        fetch,
        reduceMotion: () => reduce,
        document: { getElementById: () => ({ contains: () => true }) },
      },
    );
    return { api, classes, card, answerEl, fetch };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('a fetched answer enters once; a repaint from the cache drops is-in, so it does not replay', async () => {
    const h = harness(false);
    h.api.ansLoad(h.answerEl());
    await flush();
    expect(h.classes.has('is-in')).toBe(true);
    // The summary landed: the turn is re-rendered and its answer painted from the cache.
    h.api.ansLoad(h.answerEl());
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.card.innerHTML).toContain('ans-cite');
    expect(h.classes.has('is-in')).toBe(false);
  });

  it('reduced motion: a fetched answer does not animate in', async () => {
    const h = harness(true);
    h.api.ansLoad(h.answerEl());
    await flush();
    expect(h.card.innerHTML).toContain('ans-cite');
    expect(h.classes.has('is-in')).toBe(false);
  });
});

describe('D14 — the answer survives its summary landing; an open Raw stays open', () => {
  // updateTurnInPanel re-renders the turn (the new markup holds a loading card);
  // attachRawToggleHandlers then paints the answer again from the cache, at once.
  const run = (rawWasOpen: boolean) => {
    const rawEl = { open: false };
    const classes = new Set<string>();
    const card = {
      innerHTML: '<span class="ans-loading">불러오는 중…</span>',
      attrs: { 'aria-busy': 'true' } as Record<string, string>,
      setAttribute: (k: string, v: string) => {
        card.attrs[k] = v;
      },
      removeAttribute: (k: string) => {
        delete card.attrs[k];
      },
      classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
    };
    const rawSrc = { textContent: '' };
    const turnBody = {
      querySelector: (sel: string) =>
        sel === '.turn-raw-src' ? rawSrc : sel === '.turn-raw-summary' ? { innerHTML: 'summary' } : null,
    };
    const answerEl = {
      dataset: { conv: 'conv-run', turn: 't2' },
      parentNode: turnBody,
      querySelector: (sel: string) => (sel === '.ans-card' ? card : null),
    };
    const newEl = { querySelector: (sel: string) => (sel === '.turn-raw' ? rawEl : null) };
    const existing = {
      querySelector: (sel: string) => (sel === '.turn-raw[open]' && rawWasOpen ? {} : null),
      replaceWith: vi.fn(),
    };
    const fetch = vi.fn();
    const io = vi.fn();
    const api = load<{ updateTurnInPanel(e: unknown, t: unknown): void }>(
      [
        ...ANS_FNS,
        'ansSession',
        'ansFallbackHtml',
        'ansPaint',
        'ansLoad',
        'attachRawToggleHandlers',
        'updateTurnInPanel',
      ],
      [],
      {
        document: {
          createElement: () => ({ innerHTML: '', firstElementChild: newEl }),
          getElementById: (id: string) =>
            id === 'panel-turns'
              ? { querySelectorAll: (sel: string) => (sel === '.turn-answer[data-turn]' ? [answerEl] : []) }
              : null,
        },
        renderTurn: () => '<div></div>',
        decoratePanelTurns: () => {},
        IntersectionObserver: io,
        _ansIo: null,
        _rawLoadedCache: { 'conv-run:t2': FIXTURE },
        _ansInflight: {},
        _panelGen: 0,
        panelSessionKey: 'k',
        _sessionCache: { k: SESSION },
        fetch,
        reduceMotion: () => false,
      },
    );
    api.updateTurnInPanel(existing, { id: 't2' });
    return { rawEl, card, classes, rawSrc, existing, fetch, io };
  };

  it('the answer is painted again from the cache — no request, no observer, no entry replay', () => {
    const r = run(false);
    expect(r.existing.replaceWith).toHaveBeenCalled();
    expect(r.fetch).not.toHaveBeenCalled();
    expect(r.io).not.toHaveBeenCalled();
    expect(r.card.innerHTML).toContain('<strong>three bars</strong>');
    expect(r.card.attrs['aria-busy']).toBeUndefined();
    expect(r.classes.has('is-in')).toBe(false);
    expect(r.rawSrc.textContent).toBe(FIXTURE);
  });
  it('an open Raw stays open', () => {
    expect(run(true).rawEl.open).toBe(true);
  });
  it('a closed Raw stays closed', () => {
    expect(run(false).rawEl.open).toBe(false);
  });
});

describe('D15 · D16 · D18 — motion, layout and tokens', () => {
  it('container, widths, motion numbers', () => {
    expect(CSS).toContain('container: ans / inline-size');
    expect(CSS).toContain('@container ans (min-width: 520px)');
    expect(CSS).toMatch(/\.ans-src \{[^}]*width: 148px/);
    expect(CSS).toMatch(/@container ans \(min-width: 520px\) \{[^@]*\.ans-src \{ width: 172px; \}/);
    expect(CSS).toContain('animation: ans-pop var(--dur-move) var(--ease-out) both');
    expect(CSS).toContain('animation-delay: calc(var(--ans-i, 0) * 60ms)');
    expect(CSS).toContain('animation: ans-in var(--dur-fade) var(--ease-out) both');
    expect(CSS).toContain('animation: ans-sweep 1.6s linear infinite');
    expect(CSS).toContain('animation: ans-pulse 1s ease-in-out infinite');
  });

  it('reduced motion switches the infinite and entry animations off explicitly', () => {
    const block = reduceBlocks(CSS).find((b) => b.includes('.ans-shimmer'));
    expect(block).toBeDefined();
    expect(block).toMatch(
      /\.ans-shimmer, \.ans-dot, \.ans-src, \.ans-card\.is-in > \* \{ animation: none !important; \}/,
    );
  });

  it('touch: the chip hit area grows', () => {
    expect(CSS).toMatch(
      /@media \(pointer: coarse\) \{[^@]*\.ans-cite::after \{ content: ''; position: absolute; inset: -10px -4px; \}/,
    );
  });

  it('no new colours: every .ans-* rule uses theme variables only', () => {
    const rules = [...CSS.matchAll(/([^{}]*\.ans-[^{}]*)\{([^{}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(10);
    for (const [, sel, body] of rules) {
      expect(`${sel.trim()} { ${body} }`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    }
  });
});

describe('client hygiene', () => {
  it('R1 P1 — the answer UI never calls a link a source: no 출처 / 인용 in the answer code', () => {
    for (const name of [
      'ansCiteHtml',
      'ansSourcesHtml',
      'renderAnswerCard',
      'ansCopyText',
      'copyAnswer',
      'ansStateHtml',
    ]) {
      expect(clientFn(name), name).not.toMatch(/출처|인용/);
    }
  });

  it('each new client function is declared exactly once', () => {
    for (const name of [
      ...ANS_FNS.slice(5),
      'ansSession',
      'ansFallbackHtml',
      'ansPaint',
      'ansLoad',
      '_ansInflight',
      '_ansIo',
      'ansLight',
      'ansBind',
      'copyAnswer',
      'ansTookLabel',
      'ansTookFor',
      'decorateAnswerTurns',
      'ansPendingShow',
      'ansPendingHtml',
      'syncAnsPending',
    ]) {
      expect(declarationCount(name)).toBe(1);
    }
  });
});
