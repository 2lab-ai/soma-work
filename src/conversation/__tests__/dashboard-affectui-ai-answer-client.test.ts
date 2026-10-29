/**
 * AI Answer → the session panel's assistant turns (.prd/affectui/re-ai-answer.md, #440), host half.
 * The answer card is @2lab.ai/ui <ui-ai-answer flat> — the element the inline
 * renderer was ported to. Executes the shipped client code cut out of
 * renderDashboardPage()'s template literal, cooked exactly as the browser
 * receives it, with injected fakes: the host contract.
 *
 *   slot     renderTurn / the writing row / a subagent's answer: the element
 *            (flat, ko) in the token wrapper (.ui-tok), with a light-DOM line
 *            until the library has loaded; Raw (요약 + 원문) at the turn's foot
 *   data     ansPaint — loading, failed (+ 다시 시도), the answer from the cache
 *            with the session's PR / issue titles (linkTitles), entry motion
 *            only when it just arrived (animate); the turn's summary above an
 *            answer that is empty or failed; agentAnswerData for a subagent
 *   live     lazy load (IntersectionObserver), the request in flight and its
 *            guards, the response time in the turn header, the writing row
 *   events   ui-retry → ansLoad (Copy and links are the element's own)
 *
 * What the element itself does is owned by the library's suite (@2lab.ai/ui
 * src/components/ai-answer/ai-answer.test.ts, "lib:" below); the pinned build's
 * styles are checked here (D15 · D16). Each moved test → where it lives now:
 *
 *   inline test                                       now
 *   D1 busy card / Raw / summary kept                 here (D1, host markup)
 *   D3 bare URLs, <url>, <url|label>                  lib: answerLinkify “turns a bare URL…”, “reads <url> and <url|label>”
 *   D3 markdown links, code, fences, schemes          lib: “leaves code spans, fences and non-http schemes alone”, answerMarkdown “escapes raw HTML and links only http(s)”
 *   D3 R1 ① code-span label keeps its URL             lib: “protects markdown links first — a code-span label keeps its URL…”
 *   D3 R1 ② balanced parentheses                      lib: “keeps balanced parentheses…”, links “restores parentheses of an encoded URL…”
 *   D3 R1 ③ fence inside a quote                      lib: “treats a fence inside a > quote as a fence, ended by the quote”
 *   D4 order, de-dup, later label; [1] stays text     lib: links “numbers links by first appearance…”, “leaves an undefined [1] as text…”
 *   D5 GitHub / other hosts                           lib: links “names GitHub PRs, issues, commits and repo paths; other hosts…”
 *   D5 precedence: session title > label > derived    lib: <ui-ai-answer> “renders the link row…” (linkTitles); host: here (D5, ansLinkTitles)
 *   D6 · D9 card: row, label, body, foot; no links    lib: “renders the link row above the body, the label, chips and the footer”, “says “Answer” and draws no row…”
 *   D6 stagger capped at 6                            lib: “renders the link row above the body…” (--ans-i); styles here (D15)
 *   D7 chips where the links were                     lib: links “a bare URL becomes only the chip; a labelled link keeps its words then the chip”
 *   D2 · D18 escaping                                 lib: “escapes every model / host string”, answerMarkdown “never lets emphasis reach into an href…”
 *   D8 lighting, row slide, delegated listeners       lib: “lights the pair on chip / card hover and focus…”, “slides only the link row…”
 *   D10 copy text, 복사됨 1500 ms, select fallback      lib: answerCopyText “copies the markdown as written plus numbered links”, “Copy emits ui-copy…”, “without a clipboard it selects…”, “speaks Korean…”
 *   D10 R1 textarea copy without the Clipboard API    the pinned build's #viaTextarea (here: D10 checks it ships; no lib test of its own yet)
 *   D11 response time                                 here (D11, unchanged: the header label stays host)
 *   D12 writing row                                   here (D12, the row now holds the element); lib: “streaming with no text yet draws only the writing row…”
 *   D13 state markup                                  lib: “shows loading, empty and failed states”, “emits ui-retry from “Try again” only when canRetry”; host data: here (D13)
 *   D13 R1 races, D14 repaint, D15 entry once         here (rewritten against the element's data); lib: “animate: false paints the answer without the entry motion…”
 *   D15 · D16 · D18 CSS                               here (D15 · D16, against the pinned build's styles); the page keeps no .ans-card styles
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { UI_LIB_FILE, uiLibDistDir } from '../ui-lib';

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
/** The page's <head> as written (module tags carry `${UI_LIB_VERSION}`). */
const HEAD = TEMPLATE.slice(TEMPLATE.indexOf('<head>'), TEMPLATE.indexOf('</head>'));

const T0 = 1_700_000_000_000;
const PR = 'https://github.com/2lab-ai/soma-work/pull/999';
const SESSION = {
  conversationId: 'conv-run',
  activityState: 'working',
  prUrl: PR,
  prTitle: 'feat(dashboard): model picker',
};
const TITLES = { [PR]: 'feat(dashboard): model picker' };
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
/** The turn's summary, as renderTurn puts it in Raw (task view T1.4): its title and body (a button: Summary failed's 🔄 Retry). */
type Summary = { title?: string; body?: string; button?: string } | null;
const SUMMARY: Summary = { title: 'Picker bars', body: 'Three bars per model.' };
/** What the element is titled with when the answer is empty or failed (#552 review P3). */
const SUMMARY_TITLE = 'Picker bars — Three bars per model.';
const SLOT_LOADING = '<ui-ai-answer flat lang="ko"><span class="ans-lite">불러오는 중…</span></ui-ai-answer>';
const SLOT_WRITING = '<ui-ai-answer flat lang="ko"><span class="ans-lite">응답 작성 중</span></ui-ai-answer>';

type Data = Record<string, unknown>;
/**
 * One answer in a turn as ansPaint sees it: the element (its data setter
 * counts writes; nothing is ever inserted beside it), and the turn body's Raw
 * (요약 + 원문).
 */
function answerDom(conv = 'conv-run', turn = 't2', summary: Summary = SUMMARY) {
  const rawSrc = { textContent: '' };
  const sum = summary && {
    querySelector: (sel: string) =>
      sel === '.turn-summary-title' && summary.title !== undefined
        ? { textContent: summary.title }
        : sel === '.turn-summary-body' && summary.body !== undefined
          ? {
              textContent: summary.body + (summary.button ?? ''),
              querySelector: (b: string) => (b === 'button' && summary.button ? { textContent: summary.button } : null),
            }
          : null,
  };
  const turnBody = {
    querySelector: (sel: string) => (sel === '.turn-raw-src' ? rawSrc : sel === '.turn-raw-summary' ? sum : null),
  };
  let inserts = 0;
  const sets: Data[] = [];
  let data: Data | undefined;
  const el = {
    get data() {
      return data;
    },
    set data(v: Data | undefined) {
      data = v;
      sets.push(v as Data);
    },
    insertAdjacentHTML: () => {
      inserts++;
    },
  };
  const details = {
    dataset: { conv, turn },
    parentNode: turnBody,
    querySelector: (sel: string) => (sel === 'ui-ai-answer' ? el : null),
  };
  return { details, el, sets, rawSrc, inserts: () => inserts };
}
const PAINT_FNS = [
  'esc',
  'ansLinkTitles',
  'ansSetData',
  'ansSession',
  'ansSummaryTitle',
  'ansCacheKey',
  'ansPaint',
  'ansLoad',
];
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('D1 · task view T1.4 — the answer is the face (<ui-ai-answer flat>); the summary and the source sit in Raw', () => {
  const turn = (extra: Record<string, unknown>, cid = 'conv-run') => {
    const api = load<{ renderTurn(t: unknown, i?: number, arr?: unknown[], cid?: string): string }>(
      ['esc', 'escJs', 'toNum', 'ansSlotHtml', 'renderTurn'],
      [],
      { panelConvId: cid, _artCache: {}, renderTurnArtifacts: () => '' },
    );
    return api.renderTurn({ id: 't2', role: 'assistant', timestamp: T0, ...extra }, 0, [], cid);
  };

  it('the element in the token wrapper with its loading line, a response-time slot, and Raw (요약 + 원문) at the foot', () => {
    const out = turn({ summaryTitle: 'Picker bars', summaryBody: 'Three bars per model.', summarized: true });
    expect(out).toContain(`<div class="turn-answer ui-tok" data-conv="conv-run" data-turn="t2">${SLOT_LOADING}</div>`);
    expect(out).toContain('<span class="ans-took"></span>');
    expect(out).toContain(
      '<details class="turn-raw"><summary class="turn-expand-btn">Raw</summary><div class="turn-raw-body">' +
        '<div class="turn-raw-label">요약</div><div class="turn-raw-summary"><div class="turn-summary-title">Picker bars</div>' +
        '<div class="turn-summary-body">Three bars per model.</div></div>' +
        '<div class="turn-raw-label">원문</div><pre class="turn-raw-src"></pre></div></details>',
    );
    // The answer first, Raw at the turn's foot (after the turn's files).
    expect(out.indexOf('class="turn-answer')).toBeLessThan(out.indexOf('class="turn-arts"'));
    expect(out.indexOf('class="turn-arts"')).toBeLessThan(out.indexOf('class="turn-raw"'));
    // The summary is not the face, and there is no inline card left.
    expect(out.slice(0, out.indexOf('class="turn-raw"'))).not.toContain('turn-summary-title');
    expect(out).not.toContain('ans-card');
    expect(out).not.toContain('답변 전문');
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
      expect(out).not.toContain('ui-ai-answer');
    }
  });

  it('the light-DOM line is escaped text (no markup reaches the slot)', () => {
    const { ansSlotHtml } = load<{ ansSlotHtml(s: string): string }>(['esc', 'ansSlotHtml'], []);
    expect(ansSlotHtml('<b>x</b>')).toBe(
      '<ui-ai-answer flat lang="ko"><span class="ans-lite">&lt;b&gt;x&lt;/b&gt;</span></ui-ai-answer>',
    );
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
    // SSOT 2026-10-29: the turns scroll in the 지시와 답변 section box.
    const scroll = { id: 'psec-conv' };
    const ansLoad = vi.fn();
    const api = load<{ attachRawToggleHandlers(): void }>(['ansCacheKey', 'attachRawToggleHandlers'], [], {
      document: {
        getElementById: (id: string) =>
          id === 'panel-turns'
            ? { querySelectorAll: (sel: string) => (sel === '.turn-answer[data-turn]' ? els : []) }
            : id === 'psec-conv'
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

  it('every answer loads as it nears the view: observed once, rooted at the 지시와 답변 box, 800px ahead', () => {
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

describe('D5 — the link titles the dashboard knows: the session’s PR and issue, only for its own conversation', () => {
  const api = () =>
    load<{ ansLinkTitles(s: unknown): Record<string, string>; ansSession(cid: string): unknown }>(
      ['ansLinkTitles', 'ansSession'],
      [],
      { panelSessionKey: 'k', _sessionCache: { k: SESSION } },
    );

  it('PR and issue titles; none without a session; the PR’s title wins when both are one URL', () => {
    const { ansLinkTitles } = api();
    expect(ansLinkTitles(SESSION)).toEqual(TITLES);
    const issue = { issueUrl: 'https://github.com/o/r/issues/7', issueTitle: 'Crash on open' };
    expect(ansLinkTitles(issue)).toEqual({ 'https://github.com/o/r/issues/7': 'Crash on open' });
    expect(ansLinkTitles({ ...SESSION, ...issue })).toEqual({
      ...TITLES,
      'https://github.com/o/r/issues/7': 'Crash on open',
    });
    expect(ansLinkTitles({ prUrl: PR, prTitle: 'PR title', issueUrl: PR, issueTitle: 'issue title' })).toEqual({
      [PR]: 'PR title',
    });
    expect(ansLinkTitles({ prUrl: PR })).toEqual({}); // no title, no entry
    expect(ansLinkTitles(null)).toEqual({});
  });

  it('a turn takes the panel session’s titles only when it belongs to that conversation', () => {
    const { ansSession } = api();
    expect(ansSession('conv-run')).toBe(SESSION);
    expect(ansSession('conv-other')).toBeNull();
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

  it('ansPendingHtml: a busy assistant row holding the element, no turn identity', () => {
    const { ansPendingHtml } = load<{ ansPendingHtml(): string }>(['esc', 'ansSlotHtml', 'ansPendingHtml'], []);
    const out = ansPendingHtml();
    expect(out).toContain('<div class="turn assistant ans-pending" aria-busy="true">');
    expect(out).toContain(`<div class="ui-tok">${SLOT_WRITING}</div>`);
    expect(out).not.toContain('data-ts');
    expect(out).not.toContain('data-turn-id');
    expect(out).not.toContain('turn-answer'); // never loaded, never timed
  });

  it('syncAnsPending adds the row last with the writing row only (streaming, no text); removes it when not writing; repaintPanelSession runs it', () => {
    const run = (state: string, row: unknown) => {
      const el: { data?: unknown } = {};
      const inserted = { querySelector: (sel: string) => (sel === 'ui-ai-answer' ? el : null) };
      const insert = vi.fn();
      const turnsEl = {
        querySelectorAll: () => [{ classList: { contains: (c: string) => c === 'user' } }],
        querySelector: () => row,
        insertAdjacentHTML: insert,
        get lastElementChild() {
          return row ?? (insert.mock.calls.length ? inserted : null);
        },
        appendChild: vi.fn(),
      };
      const api = load<{ syncAnsPending(): void }>(
        ['esc', 'ansSlotHtml', 'ansSetData', 'ansPendingShow', 'ansPendingHtml', 'syncAnsPending'],
        [],
        {
          document: { getElementById: () => turnsEl },
          panelOpen: true,
          panelSessionKey: 'k',
          panelConvId: 'c',
          _sessionCache: { k: { conversationId: 'c', activityState: state } },
        },
      );
      api.syncAnsPending();
      return { insert, turnsEl, el };
    };
    const added = run('working', null);
    expect(added.insert).toHaveBeenCalledWith('beforeend', expect.stringContaining('ans-pending'));
    expect(added.el.data).toEqual({ markdown: '', streaming: true });
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
        'esc',
        'ansSlotHtml',
        'ansSetData',
        'ansPendingShow',
        'ansPendingHtml',
        'syncAnsPending',
        'decorateAnswerTurns',
        'decoratePanelTurns',
        'ptUpsert',
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
        _ansIo: null, // #488: no answer observer in this harness
        panelOpen: true,
        panelSessionKey: 'k',
        panelConvId: 'c',
        _sessionCache: sessions,
        _artCache: {},
        artInTurn: () => false,
        renderTurnArtifacts: () => '',
        // SSOT 2026-10-29: 지시와 답변's data (the instruction already on the list) and its
        // section box — the follow / pill decision is not under test here.
        _panelTurnsList: [{ role: 'user', timestamp: T0 }],
        _panelTurnsMsg: '',
        _psec: 'conv',
        _panelAgent: '',
        psecBox: () => ({ scrollHeight: 0, scrollTop: 0, clientHeight: 0 }),
        psecAtBottom: () => true,
        psecOnAppended: () => {},
        paintConvTab: () => {},
        psecSyncControls: () => {},
        psecToNewest: () => {},
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

describe('D12 · review R1 (P1) — a failed send is found although the writing row is last', () => {
  // Dashboard batch 2: the composer is <ui-agent-steering>. A failed idle send now leaves the transcript (its row in
  // the composer says failed, with Retry) — the optimistic turn is still found by its own id.
  it('the optimistic turn is found by its id, not ":last-child"', async () => {
    const optimistic = { remove: vi.fn() };
    let optimisticId = '';
    const steer = { data: { running: false }, value: '', setItemState: vi.fn() };
    const bodies: string[] = [];
    const api = load<{ sendCommand(text: string, ref: string): Promise<void> }>(
      ['esc', 'escJs', 'pcCanSend', 'pcCommandBody', 'acPost', 'sendCommand'],
      [],
      {
        document: {
          getElementById: (id: string) => (id === 'cmd-steer' ? steer : null),
          // The 응답 작성 중 row is the last child: ':last-child' finds no user turn.
          querySelector: (sel: string) =>
            optimisticId && sel === `.turn.user[data-turn-id="${optimisticId}"]` ? optimistic : null,
        },
        appendTurnToPanel: (t: { id: string }) => {
          optimisticId = t.id;
        },
        fetch: (_url: string, init: { body: string }) => {
          bodies.push(init.body);
          return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({}) });
        },
        refreshCsrfToken: () => Promise.resolve(),
        dashToast: vi.fn(),
        panelSessionKey: 'k',
        _sessionCache: { k: { activityState: 'idle' } },
        _csrfToken: '',
        _lastSentContent: '',
        _lastSentTime: 0,
        // Task view T1.5 composer: no recording, no attached files.
        _pcRec: null,
        _pcFiles: [],
        _pcSending: false,
        _pcFiling: null, // #488: no stopped recording waiting to be filed
        pcStopRecording: () => {},
        pcRemoveFile: () => {},
      },
    );
    await api.sendCommand('a follow-up', 'as-1');
    expect(bodies).toEqual([JSON.stringify({ message: 'a follow-up' })]);
    expect(optimisticId).toMatch(/^optimistic-\d+$/);
    expect(optimistic.remove).toHaveBeenCalledTimes(1);
    expect(steer.setItemState).toHaveBeenCalledWith('as-1', 'failed', '(HTTP 400)');
    expect(clientFn('sendCommand')).not.toContain(':last-child');
  });
});

describe('D13 — loading, failed, empty: the element’s data, the summary above, Raw', () => {
  const harness = (cache: Record<string, string>, fetchImpl: unknown, summary: Summary = SUMMARY) => {
    const dom = answerDom('conv-run', 't2', summary);
    const api = load<{ ansLoad(d: unknown): void }>(PAINT_FNS, [], {
      _rawLoadedCache: cache,
      _ansInflight: {},
      _panelGen: 0,
      panelSessionKey: 'k',
      _sessionCache: { k: SESSION },
      fetch: fetchImpl,
      document: { getElementById: () => ({ contains: () => true }) },
    });
    return { api, ...dom };
  };

  it('a cached answer paints at once without a request, titled links, no entry motion; Raw holds it as written', () => {
    const fetch = vi.fn();
    const h = harness({ 'conv-run:t2': '**hi**' }, fetch);
    h.api.ansLoad(h.details);
    expect(fetch).not.toHaveBeenCalled();
    expect(h.sets).toEqual([{ markdown: '**hi**', linkTitles: TITLES, animate: false }]);
    expect(h.inserts()).toBe(0);
    expect(h.rawSrc.textContent).toBe('**hi**');
  });

  it('a failed request: loading, then “failed” with 다시 시도 headed by the summary; a good one fills the cache and enters', async () => {
    const bad = harness(
      {},
      vi.fn(() => Promise.resolve({ ok: false, status: 404 })),
    );
    bad.api.ansLoad(bad.details);
    expect(bad.el.data).toEqual({ markdown: '', loading: true });
    await flush();
    // Task view T1.4: the answer is the face, so a failure shows the summary first — as the element's
    // title (#552 review P3: no line re-inserted beside the element on every paint).
    expect(bad.el.data).toEqual({ markdown: '', error: 'HTTP 404', canRetry: true, title: SUMMARY_TITLE });
    expect(bad.inserts()).toBe(0);
    expect(bad.rawSrc.textContent).toBe('');

    const cache: Record<string, string> = {};
    const fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ raw: FIXTURE }) }));
    const ok = harness(cache, fetch);
    ok.api.ansLoad(ok.details);
    await flush();
    expect(fetch).toHaveBeenCalledWith('/api/conversations/conv-run/turns/t2/raw');
    expect(cache['conv-run:t2']).toBe(FIXTURE);
    expect(ok.el.data).toEqual({ markdown: FIXTURE, linkTitles: TITLES, animate: true });
    expect(ok.rawSrc.textContent).toBe(FIXTURE);
  });

  it('a network failure without a message still reads as failed (its name), never as an empty answer', async () => {
    const h = harness({}, () => Promise.reject(Object.assign(new Error(''), { name: 'TypeError' })));
    h.api.ansLoad(h.details);
    await flush();
    expect(h.el.data).toEqual({ markdown: '', error: 'TypeError', canRetry: true, title: SUMMARY_TITLE });
  });

  it('an empty answer: the element’s empty line headed by the summary; with no summary yet, only that line', async () => {
    const empty = harness({}, () => Promise.resolve({ ok: true, json: () => Promise.resolve({ raw: '  ' }) }));
    empty.api.ansLoad(empty.details);
    await flush();
    // the element says 기록된 답변 내용이 없습니다 under the summary
    expect(empty.el.data).toMatchObject({ markdown: '  ', title: SUMMARY_TITLE });
    expect(empty.inserts()).toBe(0);

    const bare = harness({ 'conv-run:t2': '' }, vi.fn(), null);
    bare.api.ansLoad(bare.details);
    expect(bare.el.data).toEqual({ markdown: '', linkTitles: TITLES, animate: false });
  });

  it('the summary as one heading line: its title, then its body’s own words — not a button’s, not the markup', async () => {
    const h = (summary: Summary) => {
      const x = harness({ 'conv-run:t2': '' }, vi.fn(), summary);
      x.api.ansLoad(x.details);
      return (x.el.data as Data).title;
    };
    expect(h({ title: 'Picker <b>bars</b>', body: '  Three\n bars.  ' })).toBe('Picker <b>bars</b> — Three bars.');
    expect(h({ body: 'Generating summary...' })).toBe('Generating summary...');
    // Summary failed + its 🔄 Retry (the button stays in Raw, where it works).
    expect(h({ title: 'Picker bars', body: 'Summary failed ', button: '🔄 Retry' })).toBe('Picker bars — Summary failed');
    expect(h({ title: '', body: '' })).toBeUndefined();
    expect(clientFn('ansPaint')).not.toContain('insertAdjacentHTML');
    expect(TEMPLATE).not.toContain('ans-fallback');
  });

  it('다시 시도 (ui-retry) fetches again, then the answer replaces the summary', async () => {
    let n = 0;
    const fetch = vi.fn(() =>
      ++n === 1
        ? Promise.resolve({ ok: false, status: 500 })
        : Promise.resolve({ ok: true, json: () => Promise.resolve({ raw: 'second try' }) }),
    );
    const h = harness({}, fetch);
    h.api.ansLoad(h.details);
    await flush();
    expect(h.el.data).toMatchObject({ error: 'HTTP 500', canRetry: true });
    // The page's listener, as shipped: only the answer element's ui-retry, inside a loadable turn.
    const at = TEMPLATE.indexOf("document.addEventListener('ui-retry'");
    const listener = cook(TEMPLATE.slice(at, TEMPLATE.indexOf('\n});\n', at) + 4));
    const handlers: Array<(e: unknown) => void> = [];
    new Function('document', 'ansLoad', listener)(
      { addEventListener: (name: string, fn: (e: unknown) => void) => name === 'ui-retry' && handlers.push(fn) },
      h.api.ansLoad,
    );
    expect(handlers).toHaveLength(1);
    const from = (tagName: string) => ({
      target: { tagName, closest: (sel: string) => (sel === '.turn-answer[data-turn]' ? h.details : null) },
    });
    handlers[0](from('UI-TOOL-CALL-CARD')); // another element's retry
    expect(fetch).toHaveBeenCalledTimes(1);
    handlers[0](from('UI-AI-ANSWER'));
    expect(h.el.data).toEqual({ markdown: '', loading: true });
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    // The answer replaces the summary: no title on a readable answer.
    expect(h.el.data).toEqual({ markdown: 'second try', linkTitles: TITLES, animate: true });
    expect(h.inserts()).toBe(0);
  });
});

describe('D13 · review R1 — a raw response lands only where it is still current', () => {
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
    const mk = (conv: string, turn: string) => {
      const d = answerDom(conv, turn);
      attached.add(d.details);
      return d;
    };
    const api = load<{ ansLoad(d: unknown): void; __set(n: string, v: unknown): void }>(PAINT_FNS, [], {
      _rawLoadedCache: cache,
      _ansInflight: {},
      _panelGen: 0,
      panelSessionKey: null,
      _sessionCache: {},
      fetch,
      document: { getElementById: () => ({ contains: (x: unknown) => attached.has(x) }) },
    });
    return { api, pending, attached, mk, fetch };
  };
  const md = (d: { el: { data?: Data } }) => String(d.el.data?.markdown ?? '');

  it('(1) the panel switched mid-flight: the late answer neither paints nor fills the cache', async () => {
    const cache: Record<string, string> = {};
    const h = race(cache);
    const d = h.mk('convA', 't2');
    h.api.ansLoad(d.details);
    h.api.__set('_panelGen', 1); // closePanel / openPanel
    h.pending[0].ok('**late A**');
    await flush();
    expect(d.el.data).toEqual({ markdown: '', loading: true });
    expect(cache).toEqual({});

    // A late failure does not paint either.
    const e = race({});
    const d2 = e.mk('convA', 't3');
    e.api.ansLoad(d2.details);
    e.api.__set('_panelGen', 1);
    e.pending[0].fail(500);
    await flush();
    expect(d2.el.data).toEqual({ markdown: '', loading: true });
  });

  it('(1b) an answer that left the list (re-rendered) is not painted', async () => {
    const cache: Record<string, string> = {};
    const h = race(cache);
    const d = h.mk('convA', 't2');
    h.api.ansLoad(d.details);
    h.attached.delete(d.details);
    h.pending[0].ok('answer A');
    await flush();
    expect(d.el.data).toEqual({ markdown: '', loading: true });
    expect(cache['convA:t2']).toBe('answer A'); // still this answer's text, under its own key
  });

  it('(2) two conversations with the same turn id never share an answer', async () => {
    const cache: Record<string, string> = { 'convA:t2': 'answer A' };
    const h = race(cache);
    const dB = h.mk('convB', 't2');
    h.api.ansLoad(dB.details);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.pending[0].url).toBe('/api/conversations/convB/turns/t2/raw');
    expect(md(dB)).not.toContain('answer A');
    h.pending[0].ok('answer B');
    await flush();
    expect(md(dB)).toBe('answer B');
    expect(cache).toEqual({ 'convA:t2': 'answer A', 'convB:t2': 'answer B' });
  });

  it('(3) an answer re-rendered mid-fetch (D14) joins the request in flight: one fetch, only the listed one paints', async () => {
    const cache: Record<string, string> = {};
    const h = race(cache);
    const d1 = h.mk('c', 't2');
    h.api.ansLoad(d1.details);
    h.attached.delete(d1.details); // the summary landed: the turn was re-rendered
    const d2 = h.mk('c', 't2');
    h.api.ansLoad(d2.details);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.pending[0].ok('the answer');
    await flush();
    expect(cache['c:t2']).toBe('the answer');
    expect(md(d2)).toBe('the answer');
    expect(md(d1)).toBe('');
  });

  it('(3b) an older response arriving after a newer one does not overwrite it', async () => {
    const cache: Record<string, string> = {};
    const h = race(cache);
    const d1 = h.mk('c', 't2');
    h.api.ansLoad(d1.details); // request 1 (this panel opening)
    h.api.__set('_panelGen', 1); // closed and reopened while it was in flight
    const d2 = h.mk('c', 't2');
    h.api.ansLoad(d2.details); // request 2
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.pending[1].ok('new answer');
    await flush();
    h.pending[0].ok('old answer');
    await flush();
    expect(cache['c:t2']).toBe('new answer');
    expect(md(d2)).toBe('new answer');
    expect(md(d1)).toBe('');
  });
});

describe('D15 · D14 — the entry plays when an answer arrives, not when it is painted again', () => {
  it('a fetched answer enters (animate: true); a fresh element painted from the cache does not (animate: false)', async () => {
    const cache: Record<string, string> = {};
    const fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ raw: FIXTURE }) }));
    const api = load<{ ansLoad(d: unknown): void }>(PAINT_FNS, [], {
      _rawLoadedCache: cache,
      _ansInflight: {},
      _panelGen: 0,
      panelSessionKey: 'k',
      _sessionCache: { k: SESSION },
      fetch,
      document: { getElementById: () => ({ contains: () => true }) },
    });
    const first = answerDom();
    api.ansLoad(first.details);
    await flush();
    expect(first.el.data).toMatchObject({ markdown: FIXTURE, animate: true });
    // The summary landed: the turn is re-rendered and its answer painted from the cache.
    const again = answerDom();
    api.ansLoad(again.details);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(again.sets).toEqual([{ markdown: FIXTURE, linkTitles: TITLES, animate: false }]);
    // Painted once per element: a later pass over the list writes nothing.
    api.ansLoad(again.details);
    expect(again.sets).toHaveLength(1);
  });

  it('ansSetData writes only what changed', () => {
    const { ansSetData } = load<{ ansSetData(el: unknown, d: unknown): void }>(['ansSetData'], []);
    const dom = answerDom();
    ansSetData(dom.el, { markdown: 'a' });
    ansSetData(dom.el, { markdown: 'a' });
    expect(dom.sets).toHaveLength(1);
    ansSetData(dom.el, { markdown: 'a', streaming: true });
    expect(dom.sets).toHaveLength(2);
  });
});

describe('D14 — the answer survives its summary landing; an open Raw stays open', () => {
  // updateTurnInPanel re-renders the turn (the new markup holds a fresh element);
  // attachRawToggleHandlers then paints the answer again from the cache, at once.
  const run = (rawWasOpen: boolean) => {
    const rawEl = { open: false };
    const dom = answerDom();
    const newEl = { querySelector: (sel: string) => (sel === '.turn-raw' ? rawEl : null) };
    const existing = {
      querySelector: (sel: string) => (sel === '.turn-raw[open]' && rawWasOpen ? {} : null),
      getAttribute: (n: string) => (n === 'data-turn-id' ? 't2' : null),
      replaceWith: vi.fn(),
    };
    const fetch = vi.fn();
    const io = vi.fn();
    const api = load<{ updateTurnInPanel(e: unknown, t: unknown): void }>(
      [...PAINT_FNS, 'attachRawToggleHandlers', 'ptUpsert', 'updateTurnInPanel'],
      [],
      {
        document: {
          createElement: () => ({ innerHTML: '', firstElementChild: newEl }),
          getElementById: (id: string) =>
            id === 'panel-turns'
              ? { querySelectorAll: (sel: string) => (sel === '.turn-answer[data-turn]' ? [dom.details] : []) }
              : null,
        },
        renderTurn: () => '<div></div>',
        decoratePanelTurns: () => {},
        _panelTurnsList: [{ id: 't2' }], // 지시와 답변's data (SSOT 2026-10-29): updated in place
        IntersectionObserver: io,
        _ansIo: null,
        _rawLoadedCache: { 'conv-run:t2': FIXTURE },
        _ansInflight: {},
        _panelGen: 0,
        panelSessionKey: 'k',
        _sessionCache: { k: SESSION },
        fetch,
      },
    );
    api.updateTurnInPanel(existing, { id: 't2' });
    return { rawEl, existing, fetch, io, ...dom };
  };

  it('the answer is painted again from the cache — no request, no observer, no entry replay', () => {
    const r = run(false);
    expect(r.existing.replaceWith).toHaveBeenCalled();
    expect(r.fetch).not.toHaveBeenCalled();
    expect(r.io).not.toHaveBeenCalled();
    expect(r.sets).toEqual([{ markdown: FIXTURE, linkTitles: TITLES, animate: false }]);
    expect(r.rawSrc.textContent).toBe(FIXTURE);
  });
  it('an open Raw stays open', () => {
    expect(run(true).rawEl.open).toBe(true);
  });
  it('a closed Raw stays closed', () => {
    expect(run(false).rawEl.open).toBe(false);
  });
});

describe('a subagent’s 지시와 답변 — its answer on the same element', () => {
  const html = (a: unknown, io: unknown, answer: string | null) =>
    load<{ agentConvHtml(a: unknown, io: unknown, prompt: string | null, answer: string | null): string }>(
      ['esc', 'ansSlotHtml', 'agentConvHtml'],
      [],
      {
        agentName: () => 'A1 Explore',
        agentStatusOf: (x: { status: string }) => x.status,
        AGENT_STATUS_LABEL: { running: '실행 중', completed: '완료' },
        formatTaskTime: () => '10:00',
      },
    ).agentConvHtml(a, io, 'the prompt', answer);
  const data = (a: unknown, io: unknown, answer: string | null, s: unknown = SESSION, failed = '') =>
    load<{ agentAnswerData(a: unknown, io: unknown, answer: string | null, s: unknown, failed: string): Data }>(
      ['ansLinkTitles', 'agentAnswerData'],
      [],
    ).agentAnswerData(a, io, answer, s, failed);
  const done = { status: 'completed', description: 'Map the picker', summary: 'Tray reads MODEL_STATS.' };
  const result = { seq: 7, text: 'Task ok' };

  it('a result: the element in the token wrapper, then Raw (요약 + 원문 as written); running: the element alone', () => {
    const out = html(done, { spawn: null, result }, `Done: ${PR} <b>`);
    expect(out).toContain(`<div class="turn-answer ui-tok">${SLOT_LOADING}</div><details class="turn-raw">`);
    expect(out).toContain('<div class="turn-raw-label">요약</div><div>Tray reads MODEL_STATS.</div>');
    expect(out).toContain(`<pre class="turn-raw-src">Done: ${PR} &lt;b&gt;</pre>`);
    expect(out).not.toContain('ans-card');
    const running = html({ ...done, status: 'running' }, { spawn: null, result: null }, null);
    expect(running).toContain(`<div class="ui-tok">${SLOT_WRITING}</div>`);
    expect(running).not.toContain('turn-raw');
    // Ended without a result: its summary, no element.
    expect(html(done, { spawn: null, result: null }, null)).not.toContain('ui-ai-answer');
  });

  it('agentAnswerData: writing → loading → the answer (summary when unreadable), titled, never animated', () => {
    expect(data({ ...done, status: 'running' }, { result: null }, null)).toEqual({ markdown: '', streaming: true });
    expect(data(done, { result }, null)).toEqual({ markdown: '', loading: true });
    expect(data(done, { result }, `Done: ${PR}`)).toEqual({
      markdown: `Done: ${PR}`,
      linkTitles: TITLES,
      animate: false,
    });
    // Denied or missing raw ('') reads as the agent's own summary — and Copy takes that text.
    expect(data(done, { result }, '')).toEqual({
      markdown: 'Tray reads MODEL_STATS.',
      linkTitles: TITLES,
      animate: false,
    });
    expect(data({ ...done, summary: '' }, { result }, '', null)).toEqual({
      markdown: '',
      linkTitles: {},
      animate: false,
    });
  });

  it('renderAgentConv writes the markup, then the element’s data — no copy cache, no listeners of its own', () => {
    const fn = clientFn('renderAgentConv');
    expect(fn).toMatch(
      /writePanelPart\(host, html\);\s*var el = host\.querySelector\('ui-ai-answer'\);\s*if \(el\) ansSetData\(el, agentAnswerData\(a, io, answer, s, failed\)\);/,
    );
    expect(fn).not.toContain('_rawLoadedCache');
  });

  // #552 review P3: a raw that failed to load read as the agent's summary (or as "no answer recorded"),
  // with no way to ask again — the main agent's answers say failed and offer 다시 시도.
  it('a raw that failed to load: failed with 다시 시도, headed by the agent’s summary — never an empty answer', () => {
    const big = { seq: 7, text: 'Task ok', rawBytes: 4096 };
    expect(data(done, { result: big }, '', SESSION, 'HTTP 502')).toEqual({
      markdown: '',
      error: 'HTTP 502',
      canRetry: true,
      title: 'Tray reads MODEL_STATS.',
    });
    expect(data({ ...done, summary: '' }, { result: big }, '', SESSION, 'TypeError')).toEqual({
      markdown: '',
      error: 'TypeError',
      canRetry: true,
    });
    // The answer slot names the work-log entry its raw comes from: the retry path is by seq.
    expect(html(done, { spawn: null, result: big }, '')).toContain(
      `<div class="turn-answer ui-tok" data-seq="7">${SLOT_LOADING}</div>`,
    );
  });

  it('agentConvRawOf keeps the failure; 다시 시도 (ui-retry by seq) forgets it and loads again', async () => {
    let reply: { status: string; raw?: string; error?: string } = { status: 'error', error: 'HTTP 502' };
    const loads: number[] = [];
    let renders = 0;
    const later: Array<() => void> = [];
    const m = load<{
      agentConvRawOf(seq: number): string | null;
      agentConvFailure(seq: number): string;
      agentConvRetry(seq: string): void;
    }>(['agentConvRawOf', 'agentConvFailure', 'agentConvRetry'], ['_agentConvRaw', '_agentConvFailed'], {
      _wl: { convId: 'c' },
      _panelGen: 1,
      wlFetchJson: () => {},
      wlRawLoad: (_st: unknown, seq: number) => {
        loads.push(seq);
        return Promise.resolve(reply);
      },
      renderAgentConv: () => renders++,
      setTimeout: (fn: () => void) => later.push(fn),
    });
    expect(m.agentConvRawOf(7)).toBeNull();
    await flush();
    expect(m.agentConvRawOf(7)).toBe('');
    expect(m.agentConvFailure(7)).toBe('HTTP 502');
    expect(renders).toBe(1);
    // A later render does not ask again by itself before the pause (#488).
    m.agentConvRawOf(7);
    expect(loads).toEqual([7]);
    // 다시 시도: forgotten, the tab is painted again — and that render loads it.
    reply = { status: 'ok', raw: 'the answer' };
    m.agentConvRetry('7');
    expect(m.agentConvFailure(7)).toBe('');
    expect(renders).toBe(2);
    expect(m.agentConvRawOf(7)).toBeNull();
    await flush();
    expect(m.agentConvRawOf(7)).toBe('the answer');
    expect(loads).toEqual([7, 7]);
    // The pause of the first failure ends after the retry landed: it forgets nothing.
    for (const fn of later) fn();
    expect(m.agentConvRawOf(7)).toBe('the answer');
    expect(loads).toEqual([7, 7]);
    // Nothing to retry: no repaint.
    m.agentConvRetry('8');
    expect(renders).toBe(3);
    expect(clientFn('renderAgentConv')).toContain("var failed = io.result && io.result.rawBytes ? agentConvFailure(io.result.seq) : '';");
  });

  it('ui-retry from a subagent’s answer goes to its seq; a turn’s answer to ansLoad', () => {
    const at = TEMPLATE.indexOf("document.addEventListener('ui-retry'");
    const listener = cook(TEMPLATE.slice(at, TEMPLATE.indexOf('\n});\n', at) + 4));
    const handlers: Array<(e: unknown) => void> = [];
    const retried: string[] = [];
    const loaded: unknown[] = [];
    new Function('document', 'ansLoad', 'agentConvRetry', listener)(
      { addEventListener: (_n: string, fn: (e: unknown) => void) => handlers.push(fn) },
      (d: unknown) => loaded.push(d),
      (seq: string) => retried.push(seq),
    );
    const sub = { getAttribute: (n: string) => (n === 'data-seq' ? '7' : null) };
    handlers[0]({
      target: { tagName: 'UI-AI-ANSWER', closest: (sel: string) => (sel === '.turn-answer[data-seq]' ? sub : null) },
    });
    expect(retried).toEqual(['7']);
    expect(loaded).toEqual([]);
  });
});

describe('the page loads the element; the inline renderer is gone', () => {
  it('ai-answer.js is a module script next to the other elements, served from the installed library', () => {
    expect(HEAD).toContain(`<script type="module" src="/dashboard/ui/ai-answer.js?v=\${UI_LIB_VERSION}"></script>`);
    const dir = uiLibDistDir();
    expect(dir).toBeTruthy();
    expect(existsSync(join(dir as string, 'ai-answer.js'))).toBe(true);
    const imports = readFileSync(join(dir as string, 'ai-answer.js'), 'utf-8').match(/from\s*"\.\/([^"]+)"/g) ?? [];
    for (const imp of imports) {
      const file = /"\.\/([^"]+)"/.exec(imp)?.[1] as string;
      expect(UI_LIB_FILE.test(file), file).toBe(true);
      expect(existsSync(join(dir as string, file)), file).toBe(true);
    }
  });

  it('the answer wrappers hand the element the dashboard tokens; the light-DOM line is quiet', () => {
    expect(CSS).toMatch(/\.wl-toolcall, \.ui-tok \{[^}]*--ui-surface-raised: var\(--surface-raised\)/);
    expect(CSS).toContain('.ans-lite { font-size: 12px; color: var(--text-tertiary); }');
    expect(CSS).toContain('.turn-header .ans-took { font-size: 11px;');
  });

  it('no inline answer card: its renderer, listeners and styles are gone', () => {
    for (const gone of [
      'ansUnesc',
      'ansKey',
      'ansDecode',
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
      'ansLight',
      'ansBind',
      'copyAnswer',
    ]) {
      expect(declarationCount(gone), gone).toBe(0);
    }
    expect(TEMPLATE).not.toContain('ansBind(');
    expect(TEMPLATE).not.toContain('data-ans-retry');
    for (const cls of ['.ans-card', '.ans-src', '.ans-cite', '.ans-foot', '.ans-shimmer', '.ans-dot', '.ans-label']) {
      expect(CSS, cls).not.toContain(cls);
    }
    expect(CSS).not.toMatch(/@keyframes ans-|@container ans/);
  });
});

describe('D15 · D16 · D18 — the pinned build’s motion, layout and touch (the dashboard relies on them)', () => {
  const dist = () => readFileSync(join(uiLibDistDir() as string, 'ai-answer.js'), 'utf-8');

  it('flat: no frame inside the turn; container widths and motion numbers', () => {
    const css = dist();
    expect(css).toMatch(
      /:host\(\[flat\]\) \.ans-card \{[^}]*border: 0; border-radius: 0; background: none; box-shadow: none;/,
    );
    expect(css).toContain('container: ans / inline-size');
    expect(css).toMatch(/\.ans-src \{[^}]*width: 148px/);
    expect(css).toMatch(/@container ans \(min-width: 520px\) \{[^@]*\.ans-src \{ width: 172px; \}/);
    expect(css).toContain('animation: ans-pop var(--dur-move) var(--ease-out) both');
    expect(css).toContain('animation-delay: calc(var(--ans-i, 0) * 60ms)');
    expect(css).toContain('animation: ans-in var(--dur-fade) var(--ease-out) both');
    expect(css).toContain('animation: ans-sweep 1.6s linear infinite');
    expect(css).toContain('animation: ans-pulse 1s ease-in-out infinite');
  });

  it('reduced motion switches the infinite and entry animations off explicitly; touch grows the chip', () => {
    const css = dist();
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.ans-shimmer, \.ans-dot, \.ans-src, \.ans-card\.is-in > \* \{ animation: none !important; \}/,
    );
    expect(css).toMatch(
      /@media \(pointer: coarse\) \{[^@]*\.ans-cite::after \{ content: ''; position: absolute; inset: -10px -4px; \}/,
    );
  });

  it('D10 R1 — without the Clipboard API the element copies the text through a hidden textarea first', () => {
    const js = dist();
    expect(js).toContain('execCommand("copy")');
    expect(js.indexOf('createElement("textarea")')).toBeGreaterThan(-1);
  });
});

describe('client hygiene', () => {
  it('R1 P1 — the answer UI never calls a link a source: no 출처 / 인용 in the host answer code', () => {
    for (const name of [
      'ansSlotHtml',
      'ansLinkTitles',
      'ansPaint',
      'ansPendingHtml',
      'agentAnswerData',
      'agentConvHtml',
    ]) {
      expect(clientFn(name), name).not.toMatch(/출처|인용/);
    }
  });

  it('each client function is declared exactly once', () => {
    for (const name of [
      'ansSlotHtml',
      'ansLinkTitles',
      'ansSetData',
      'ansSession',
      'ansSummaryTitle',
      'ansPaint',
      'ansCacheKey',
      'ansLoad',
      '_ansInflight',
      '_ansIo',
      'ansTookLabel',
      'ansTookFor',
      'decorateAnswerTurns',
      'ansPendingShow',
      'ansPendingHtml',
      'syncAnsPending',
      'agentAnswerData',
    ]) {
      expect(declarationCount(name), name).toBe(1);
    }
  });
});
