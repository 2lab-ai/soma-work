/**
 * AI Answer → the session panel's assistant turns (.prd/affectui/re-ai-answer.md, #440), host half.
 * The answer card is @2lab.ai/ui <ui-ai-answer flat> — the element the inline
 * renderer was ported to. Executes the shipped client code cut out of
 * renderDashboardPage()'s template literal, cooked exactly as the browser
 * receives it, with injected fakes: the host contract.
 *
 *   turns    D3: 지시와 답변 is <ui-conversation> — an assistant turn (convTurnsOf):
 *            loading until fetched, the answer as written (Raw's source), the
 *            session's PR / issue titles (linkTitles), failed (+ 다시 시도),
 *            the summary (Raw · the heading of an answer that is empty or
 *            failed), the response time; a subagent's two turns (agentConvTurns)
 *   section  convPaint — the bot's name, the writing row, paging (hasMore,
 *            loading, empty, a failed page), the clamp
 *   live     lazy load (IntersectionObserver on the element's turn nodes), the
 *            request in flight and its guards (convLoadAnswer)
 *   events   ui-load-older → loadMorePanelTurns, ui-retry → convRetry
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
/** The page's chrome words (STRINGS — tone pass P8: Korean, "…", no emoji), as served. */
const STRINGS = new Function(
  `${cook(TEMPLATE.slice(TEMPLATE.indexOf('var STRINGS = {'), TEMPLATE.indexOf('\n};\n', TEMPLATE.indexOf('var STRINGS = {')) + 3))}\nreturn STRINGS;`,
)() as Record<string, string>;
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
const CSS = cook(
  TEMPLATE.slice(TEMPLATE.indexOf('<style>'), TEMPLATE.indexOf('</style>', TEMPLATE.indexOf('<style>'))),
);
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
type Data = Record<string, unknown>;
const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * D3 — 지시와 답변 is @2lab.ai/ui <ui-conversation>: an assistant turn's answer is the element's nested
 * <ui-ai-answer flat>, its Raw (요약 · 원문) and its response time the element's too. The host contract: the
 * turns the page hands it (convTurnsOf), the section's data (convPaint), the answers it loads (convLoadAnswer)
 * and what it does on the element's requests (convRetry, ui-load-older).
 */
const CONV_FNS = [
  'esc',
  'toNum',
  'decodeSlackEntities',
  'formatTokens',
  'formatDuration',
  'sysOneLine',
  'sysBetween',
  'sysResumeContext',
  'sysTurnInfo',
  'cpState',
  'cpFacts',
  'cpDoneText',
  'estimateTokens',
  'splitInvokedSkills',
  'ansCacheKey',
  'artInTurn',
  'resumKey',
  'convSummaryOf',
  'convSysTurn',
  'convTurnsOf',
];
const CONV_VARS = ['SYS_RESTART_HEADS', 'SYS_RESUME_CONTEXT', 'SYS_RETRY_MARK', 'CP_DEFAULT_EST_MS', 'CP_MAX_MS'];
type Turn = Record<string, unknown> & { id: string; role: string };
type Built = { turns: Turn[]; slots: { name: string; kind: string; list: unknown[] }[] };
const convOf = load<{ convTurnsOf(list: unknown[], c: Record<string, unknown>): Built }>(CONV_FNS, CONV_VARS, {
  STRINGS,
}).convTurnsOf;
const ctx = (c: Record<string, unknown> = {}) => ({
  cid: 'conv-run',
  bot: 'Soma',
  now: T0 + 60_000,
  working: true,
  answers: {},
  failed: {},
  arts: [],
  titles: TITLES,
  ...c,
});
const INSTR = {
  id: 't1',
  role: 'user',
  timestamp: T0,
  userName: 'Z',
  rawContent: 'picker를 고쳐줘',
  origin: { by: 'user' },
};
const ANSWER = {
  id: 't2',
  role: 'assistant',
  timestamp: T0 + 252_000,
  summaryTitle: 'Picker bars',
  summaryBody: 'Three bars per model.',
};
const answerOf = (c: Record<string, unknown> = {}, a: Record<string, unknown> = ANSWER) =>
  convOf([INSTR, a], ctx(c)).turns[1];

describe('D1 · task view T1.4 — the answer is the face (<ui-conversation>’s <ui-ai-answer flat>); summary and source in Raw', () => {
  it('loading until fetched; then the answer as written (Raw’s source), titled links; the summary rides along', () => {
    expect(answerOf()).toEqual({
      id: 't2',
      role: 'assistant',
      name: 'Soma',
      at: T0 + 252_000,
      summary: { title: 'Picker bars', text: 'Three bars per model.' },
      responseMs: 252_000,
      loading: true,
    });
    const ready = answerOf({ answers: { 'conv-run:t2': FIXTURE } });
    expect(ready).toMatchObject({ markdown: FIXTURE, linkTitles: TITLES, summary: { title: 'Picker bars' } });
    expect(ready).not.toHaveProperty('loading');
  });

  it('failed: 다시 시도 (canRetry), headed by the summary; an empty answer is the summary’s', () => {
    expect(answerOf({ failed: { 'conv-run:t2': 'HTTP 502' } })).toMatchObject({
      markdown: '',
      error: 'HTTP 502',
      canRetry: true,
      summary: { title: 'Picker bars', text: 'Three bars per model.' },
    });
    expect(answerOf({ answers: { 'conv-run:t2': '' } })).toMatchObject({ markdown: '' });
  });

  it('요약 만드는 중… is the summary’s text; 요약 실패 its error with the element’s Retry (summary.canRetry, G-04)', () => {
    const failed = { id: 't2', role: 'assistant', timestamp: T0 + 1000, summarized: true };
    expect(answerOf({}, failed).summary).toEqual({ error: STRINGS.summaryFailed, canRetry: true });
    expect(answerOf({}, { id: 't2', role: 'assistant', timestamp: T0 + 1000 }).summary).toEqual({
      text: STRINGS.summaryPending,
    });
    // The title stays over the failure.
    expect(answerOf({}, { ...failed, summaryTitle: 'Picker bars' }).summary).toEqual({
      title: 'Picker bars',
      error: STRINGS.summaryFailed,
      canRetry: true,
    });
    // No conversation or no id to ask for: the failure without a Retry.
    expect(convOf([INSTR, failed], ctx({ cid: '' })).turns[1].summary).toEqual({ error: STRINGS.summaryFailed });
    expect(convOf([INSTR, { ...failed, id: '' }], ctx()).turns[1].summary).toEqual({ error: STRINGS.summaryFailed });
    // Asked for (c.resum): 다시 시도 중… until the next poll brings the summary; no second Retry meanwhile.
    expect(answerOf({ resum: { 'conv-run|t2': true } }, failed).summary).toEqual({ text: STRINGS.retrying });
    // The retry no longer rides in the attachments slot (D3-GAPS G1-3 closed by 0.12.0).
    const b = convOf([INSTR, failed], ctx());
    expect(b.turns[1]).not.toHaveProperty('attachments');
    expect(b.slots).toEqual([]);
    expect(DASHBOARD_TS).not.toContain('convResumHtml');
    expect(DASHBOARD_TS).not.toContain('data-resum');
  });

  it('the element’s Retry on a summary (ui-retry what: summary) → POST …/resummarize/:turnId with the CSRF token; a refusal puts the Retry back', async () => {
    const paints: string[] = [];
    let token = 'tok';
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 403 })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 500 });
    const m = new Function(
      'fetch',
      'refreshCsrfToken',
      'getToken',
      'convPaint',
      `var _panelAgent = null, _panelTurnsCid = 'conv-run', panelConvId = null;
       ${clientVar('_resumSent')}
       ${clientFn('resumKey').replace(/_csrfToken/g, 'getToken()')}
       ${clientFn('convResummarize')}
       ${clientFn('resummarize').replace(/_csrfToken/g, 'getToken()')}
       return { convResummarize, resummarize, sent: _resumSent, setAgent: function(a) { _panelAgent = a; } };`,
    )(
      fetch,
      async () => {
        token = 'fresh';
      },
      () => token,
      () => paints.push(JSON.stringify(Object.keys(m.sent))),
    ) as {
      convResummarize(id: unknown): void;
      resummarize(cid: string, id: string): Promise<void>;
      sent: Record<string, boolean>;
      setAgent(a: string | null): void;
    };
    m.convResummarize('t2');
    expect(paints).toEqual(['["conv-run|t2"]']); // on its way: the summary reads 다시 시도 중…
    await flush();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toBe('/api/dashboard/session/conv-run/resummarize/t2');
    expect(fetch.mock.calls[0][1]).toEqual({ method: 'POST', headers: { 'X-CSRF-Token': 'tok' } });
    expect(fetch.mock.calls[1][1]).toEqual({ method: 'POST', headers: { 'X-CSRF-Token': 'fresh' } });
    expect(m.sent['conv-run|t2']).toBe(true); // stays until the poll brings the summary
    m.convResummarize('t2'); // a second press while asked for: nothing
    expect(fetch).toHaveBeenCalledTimes(2);
    await m.resummarize('conv-run', 't3'); // refused: the Retry comes back
    expect(m.sent['conv-run|t3']).toBeUndefined();
    expect(paints).toEqual(['["conv-run|t2"]', '["conv-run|t2","conv-run|t3"]', '["conv-run|t2"]']);
    // A subagent's turns carry no summary: no ask; and the element's listener routes what: 'summary' here.
    m.setAgent('toolu_1');
    m.convResummarize('t9');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(DASHBOARD_TS).toContain("if (d.what === 'summary') convResummarize(d.id);");
  });

  it('a turn with no answer to load (no id or no conversation) shows its summary, never loading', () => {
    const noCid = convOf([ANSWER], ctx({ cid: '' })).turns[0];
    expect(noCid).toMatchObject({ markdown: '', summary: { title: 'Picker bars' } });
    expect(noCid).not.toHaveProperty('loading');
    const noId = convOf([{ ...ANSWER, id: '' }], ctx()).turns[0];
    expect(noId.id).toBe(`assistant:${T0 + 252_000}:0`);
    expect(noId).not.toHaveProperty('loading');
  });

  it('an artifact goes under the first answer whose turn window holds its turn start (attachments-<id>)', () => {
    const art = { id: 'A1', name: 'r.md', turnStartedAt: T0 + 10 };
    const late = { id: 'A2', name: 'late.md', turnStartedAt: T0 + 999_999 };
    const b = convOf([INSTR, ANSWER], ctx({ arts: [art, late] }));
    expect(b.turns[1].attachments).toBe(true);
    expect(b.slots).toEqual([{ name: 'attachments-t2', kind: 'arts', list: [art], start: T0, end: T0 + 252_000 }]);
  });
});

describe('the section’s data and the element’s requests (convPaint, convRetry, loaders)', () => {
  type Env = Record<string, unknown>;
  function paint(env: Env = {}) {
    const sets: Record<string, unknown>[] = [];
    const slots: unknown[] = [];
    const el = { data: undefined };
    const m = load<{ convPaint(): void }>(
      ['botNameOf', 'ansLinkTitles', 'ansSession', 'ansPendingShow', 'convPaint'],
      ['CONV_EMPTY', '_resumSent'],
      {
        convEl: () => el,
        _psec: 'conv',
        _panelAgent: '',
        renderAgentConv: () => sets.push({ agent: true }),
        BOT_NAME: 'Soma (Dev)',
        panelSessionKey: 'k',
        panelConvId: 'conv-run',
        _sessionCache: { k: { ...SESSION, botName: 'Soma Dev (Beta)' } },
        _panelTurnsCid: 'conv-run',
        _panelTurnsList: [INSTR],
        _panelTurnsMsg: '',
        _panelTurnsHasMore: true,
        _panelTurnsLoading: false,
        _panelTurnsWhy: '',
        _panelOlderWhy: '',
        _panelDetail: false,
        _rawLoadedCache: {},
        _ansFailed: {},
        _artCache: {},
        convTurnsOf: (list: unknown[], c: Env) => ({ turns: list.map((t) => ({ ...(t as object), c })), slots: [] }),
        convSlots: (_el: unknown, s: unknown) => slots.push(s),
        convSetData: (_el: unknown, d: Record<string, unknown>) => sets.push(d),
        ...env,
      },
    );
    m.convPaint();
    return sets[sets.length - 1] as Record<string, unknown> & { turns: Record<string, unknown>[] };
  }

  it('SSOT 2026-10-29 T8 — the answers carry the Slack bot’s name: the session’s, else this instance’s, else Assistant', () => {
    expect(paint().assistantName).toBe('Soma Dev (Beta)');
    expect((paint().turns[0].c as Env).bot).toBe('Soma Dev (Beta)');
    expect(paint({ _sessionCache: { k: SESSION } }).assistantName).toBe('Soma (Dev)');
    expect(
      paint({ _sessionCache: { k: SESSION, other: { botName: 'Other Bot' } }, BOT_NAME: null }).assistantName,
    ).toBe('어시스턴트');
  });

  it('D12 — the writing row: the session works and the latest turn is the instruction (the element keeps it last)', () => {
    expect(paint().pending).toBe(true);
    expect(paint({ _panelTurnsList: [INSTR, ANSWER] }).pending).toBe(false);
    expect(paint({ _sessionCache: { k: { ...SESSION, activityState: 'idle' } } }).pending).toBe(false);
    // repaintPanelSession → convPaint: the row follows the session state.
    expect(clientFn('repaintPanelSession')).toContain('convPaint();');
  });

  it('paging: hasMore, the page in flight (first or older), the empty state, a failure with 다시 시도', () => {
    expect(paint()).toMatchObject({ hasMore: true, loading: false, label: '지시와 답변', startText: '대화의 시작' });
    expect(paint({ _panelTurnsLoading: true }).loading).toBe(true);
    expect(paint({ _panelTurnsMsg: 'loading', _panelTurnsList: [] }).loading).toBe(true);
    // G-13 — in Korean.
    expect(paint({ _panelTurnsMsg: 'none', _panelTurnsList: [] }).emptyText).toBe('아직 대화가 없습니다');
    expect(paint({ _panelTurnsMsg: 'unrecorded', _panelTurnsList: [] }).emptyText).toBe('기록된 대화가 없습니다');
    expect(paint({ _panelTurnsMsg: 'failed', _panelTurnsList: [], _panelTurnsWhy: 'HTTP 500' }).error).toBe('HTTP 500');
    expect(paint({ _panelOlderWhy: 'HTTP 502' }).error).toBe('HTTP 502');
    expect(paint()).not.toHaveProperty('error');
  });

  it('T1.3 — a long instruction folds to 12 lines; 자세히 shows it whole', () => {
    expect(paint().clampLines).toBe(12);
    expect(paint({ _panelDetail: true }).clampLines).toBe(200);
  });

  it('a subagent’s tab paints its own 지시와 답변 on the same element', () => {
    expect(paint({ _panelAgent: 'a1' })).toEqual({ agent: true });
  });

  it('ui-load-older → loadMorePanelTurns (refused while nothing is older or a page is on its way); ui-retry → convRetry', () => {
    const src = cook(
      TEMPLATE.slice(
        TEMPLATE.indexOf('(function initConversation() {'),
        TEMPLATE.indexOf('})();', TEMPLATE.indexOf('(function initConversation() {')) + 5,
      ),
    );
    const on: Record<string, (e: unknown) => void> = {};
    let loads = 0;
    const retried: unknown[] = [];
    const env = { _panelAgent: '', _panelTurnsHasMore: true, _panelTurnsLoading: false };
    new Function('convEl', 'loadMorePanelTurns', 'convRetry', 'window', 'env', `with (env) { ${src} }`)(
      () => ({ addEventListener: (n: string, fn: (e: unknown) => void) => (on[n] = fn) }),
      () => loads++,
      (id: unknown) => retried.push(id),
      {},
      env,
    );
    let prevented = 0;
    const ev = { preventDefault: () => prevented++ };
    on['ui-load-older'](ev);
    expect(loads).toBe(1);
    env._panelTurnsLoading = true;
    on['ui-load-older'](ev);
    env._panelTurnsLoading = false;
    env._panelTurnsHasMore = false;
    on['ui-load-older'](ev);
    expect(loads).toBe(1);
    expect(prevented).toBe(2);
    on['ui-retry']({ detail: { id: 't2' } });
    on['ui-retry']({ detail: { id: null } });
    expect(retried).toEqual(['t2', null]);
  });

  it('convRetry: an answer (its turn id) loads again; the list (null) its failed page — the first, or the older one', () => {
    const calls: string[] = [];
    const failed: Record<string, string> = { 'conv-run:t2': 'HTTP 502' };
    const m = load<{ convRetry(id: unknown): void; __set(n: string, v: unknown): void }>(
      ['ansCacheKey', 'convRetry'],
      [],
      {
        _panelAgent: '',
        _panelTurnsMsg: 'failed',
        _panelTurnsWhy: 'HTTP 500',
        _panelOlderWhy: '',
        _panelTurnsCid: 'conv-run',
        panelConvId: 'conv-run',
        _ansFailed: failed,
        convEl: () => ({ _agentSeq: 7 }),
        convPaint: () => calls.push('paint'),
        loadPanelTurns: () => calls.push('first'),
        loadMorePanelTurns: () => calls.push('older'),
        convLoadAnswer: (cid: string, id: string) => calls.push(`answer ${cid} ${id}`),
        agentConvRetry: (seq: number) => calls.push(`agent ${seq}`),
      },
    );
    m.convRetry(null);
    expect(calls).toEqual(['paint', 'first']);
    m.__set('_panelTurnsMsg', '');
    m.__set('_panelOlderWhy', 'HTTP 502');
    m.convRetry(null);
    expect(calls.slice(2)).toEqual(['paint', 'older']);
    m.convRetry('t2');
    expect(failed).toEqual({});
    expect(calls.slice(4)).toEqual(['paint', 'answer conv-run t2']);
    m.convRetry('t2'); // nothing failed: nothing to do
    expect(calls).toHaveLength(6);
    m.__set('_panelAgent', 'a1');
    m.convRetry('agent:a1:result');
    expect(calls[6]).toBe('agent 7');
  });

  it('D12 · review R1 (P1) — an instruction that could not be sent leaves the data by its id', () => {
    let paints = 0;
    const list = [INSTR, { id: 'optimistic-1', role: 'user' }, { id: 'x', role: 'assistant' }];
    const m = load<{ dropTurnFromPanel(id: string): boolean }>(['dropTurnFromPanel'], [], {
      _panelTurnsList: list,
      convPaint: () => paints++,
    });
    expect(m.dropTurnFromPanel('optimistic-1')).toBe(true);
    expect(list.map((t) => t.id)).toEqual(['t1', 'x']);
    expect(m.dropTurnFromPanel('nope')).toBe(false);
    expect(paints).toBe(1);
    const send = TEMPLATE.slice(TEMPLATE.indexOf("optimisticId = 'optimistic-' + Date.now();"));
    expect(send.slice(0, send.indexOf('function pcGiveBack'))).toContain(
      'if (optimisticId) dropTurnFromPanel(optimisticId);',
    );
  });

  // D4 E-30: the note's files are the composer's File objects (ui-submit detail.files). They go as base64; a failed
  // send keeps them by its ref, so the row's Retry — which re-emits the ref without files — sends them again; a sent
  // note forgets them. A file that cannot be read gives the text and files back to the composer.
  it("a note's files go as base64; a failed send keeps them for the row's Retry; an unreadable one is given back", async () => {
    const steer = { data: { running: true }, value: '', setItemState: vi.fn() };
    const composer = { files: [] as unknown[], addFiles: vi.fn() };
    const bodies: string[] = [];
    const statuses = [500, 200];
    const noteFiles: Record<string, unknown[]> = {};
    const toast = vi.fn();
    const file = { name: 'shot.png', type: 'image/png' };
    let unreadable = false;
    const api = load<{ sendCommand(text: string, ref: string, files?: unknown[]): Promise<void> }>(
      ['esc', 'escJs', 'pcCanSend', 'pcCommandBody', 'acPost', 'pcGiveBack', 'sendCommand'],
      [],
      {
        document: {
          getElementById: (id: string) => (id === 'cmd-steer' ? steer : id === 'pc-composer' ? composer : null),
          querySelector: () => null,
        },
        appendTurnToPanel: () => {},
        dropTurnFromPanel: () => false,
        fetch: (_url: string, init: { body: string }) => {
          bodies.push(init.body);
          const status = statuses.shift() ?? 200;
          return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve({}) });
        },
        refreshCsrfToken: () => Promise.resolve(),
        dashToast: toast,
        panelSessionKey: 'k',
        _sessionCache: { k: { activityState: 'working' } },
        _csrfToken: '',
        _lastSentContent: '',
        _lastSentTime: 0,
        _pcSending: false,
        _pcInFlight: 0,
        _pcFailed: {},
        _pcNoteFiles: noteFiles,
        ntReadFile: (f: { name: string; type: string }) =>
          unreadable
            ? Promise.reject(new Error(`read:${f.name}`))
            : Promise.resolve({ name: f.name, mimetype: f.type, data: 'QUJD' }),
      },
    );
    await api.sendCommand('look', 'as-1', [file]);
    const sent = { message: 'look', attachments: [{ name: 'shot.png', mimetype: 'image/png', data: 'QUJD' }] };
    expect(JSON.parse(bodies[0])).toEqual(sent);
    expect(steer.setItemState).toHaveBeenCalledWith('as-1', 'failed', '(HTTP 500)');
    expect(noteFiles).toEqual({ 'as-1': [file] });
    // Retry: the same ref, no files — the kept ones go; sent, they are forgotten.
    await api.sendCommand('look', 'as-1');
    expect(JSON.parse(bodies[1])).toEqual(sent);
    expect(noteFiles).toEqual({});
    // A file that cannot be read: nothing is posted, the row goes, text and file return to the composer.
    unreadable = true;
    await api.sendCommand('again', 'as-2', [file]);
    expect(bodies).toHaveLength(2);
    expect(steer.setItemState).toHaveBeenCalledWith('as-2', 'cancelled');
    expect(steer.value).toBe('again');
    expect(composer.addFiles).toHaveBeenCalledWith([file]);
    expect(toast).toHaveBeenLastCalledWith({ title: '파일을 읽지 못했어요', description: 'shot.png', tone: 'error' });
    expect(noteFiles).toEqual({});
  });
});

describe('D11 — response time = this answer − the instruction before it (the element’s head chip)', () => {
  it('only after an instruction, never against an optimistic one (this browser’s clock)', () => {
    expect(answerOf().responseMs).toBe(252_000);
    const twoAnswers = convOf([INSTR, ANSWER, { ...ANSWER, id: 't3', timestamp: T0 + 300_000 }], ctx()).turns;
    expect(twoAnswers[2]).not.toHaveProperty('responseMs');
    const opt = convOf([{ ...INSTR, id: 'optimistic-1' }, ANSWER], ctx()).turns[1];
    expect(opt).not.toHaveProperty('responseMs');
    expect(convOf([{ ...INSTR, timestamp: 0 }, ANSWER], ctx()).turns[1]).not.toHaveProperty('responseMs');
  });
});

describe('D13 · review R1 — an answer lands only where it is still current (convLoadAnswer)', () => {
  function loader(gen = 1) {
    const reqs: { url: string; resolve(v: unknown): void; reject(e: unknown): void }[] = [];
    const cache: Record<string, string> = {};
    const failed: Record<string, string> = {};
    let paints = 0;
    const m = load<{ convLoadAnswer(cid: string, id: string): void; __set(n: string, v: unknown): void }>(
      ['ansCacheKey', 'convLoadAnswer'],
      ['_ansInflight'],
      {
        _panelGen: gen,
        _rawLoadedCache: cache,
        _ansFailed: failed,
        convPaintSoon: () => paints++,
        fetch: (url: string) =>
          new Promise((resolve, reject) => reqs.push({ url, resolve, reject })).then((v) => v as never),
      },
    );
    return { m, reqs, cache, failed, paints: () => paints };
  }
  const ok = (raw: string) => ({ ok: true, json: () => Promise.resolve({ raw }) });

  it('fetches the turn’s raw once; the answer fills the cache and the section paints', async () => {
    const l = loader();
    l.m.convLoadAnswer('conv-run', 't2');
    l.m.convLoadAnswer('conv-run', 't2'); // a turn rebuilt mid-fetch joins the request in flight
    expect(l.reqs.map((r) => r.url)).toEqual(['/api/conversations/conv-run/turns/t2/raw']);
    l.reqs[0].resolve(ok(FIXTURE));
    await flush();
    expect(l.cache).toEqual({ 'conv-run:t2': FIXTURE });
    expect(l.paints()).toBe(1);
    l.m.convLoadAnswer('conv-run', 't2'); // cached: no request
    expect(l.reqs).toHaveLength(1);
  });

  it('a failure is kept (with its reason, else its name) until 다시 시도 — never an empty answer', async () => {
    const l = loader();
    l.m.convLoadAnswer('conv-run', 't2');
    l.reqs[0].resolve({ ok: false, status: 502 });
    await flush();
    expect(l.failed).toEqual({ 'conv-run:t2': 'HTTP 502' });
    expect(l.cache).toEqual({});
    l.m.convLoadAnswer('conv-run', 't2'); // failed: waits for 다시 시도
    expect(l.reqs).toHaveLength(1);
    const n = loader();
    n.m.convLoadAnswer('conv-run', 't9');
    n.reqs[0].reject(new TypeError(''));
    await flush();
    expect(n.failed['conv-run:t9']).toBe('TypeError');
  });

  it('(1) the panel switched mid-flight: the late answer neither fills the cache nor paints', async () => {
    const l = loader(1);
    l.m.convLoadAnswer('conv-run', 't2');
    l.m.__set('_panelGen', 2);
    l.reqs[0].resolve(ok(FIXTURE));
    await flush();
    expect(l.cache).toEqual({});
    expect(l.paints()).toBe(0);
  });

  it('(2) two conversations with the same turn id never share an answer', async () => {
    const l = loader();
    l.m.convLoadAnswer('conv-a', 't2');
    l.m.convLoadAnswer('conv-b', 't2');
    expect(l.reqs).toHaveLength(2);
    l.reqs[1].resolve(ok('B'));
    l.reqs[0].resolve(ok('A'));
    await flush();
    expect(l.cache).toEqual({ 'conv-a:t2': 'A', 'conv-b:t2': 'B' });
  });

  it('every answer loads as its turn nears the view: observed once per node, 800px ahead; without IO at once', () => {
    const observed: unknown[] = [];
    const loaded: string[] = [];
    let opts: unknown = null;
    class IO {
      constructor(_cb: unknown, o: unknown) {
        opts = o;
      }
      observe(n: unknown) {
        observed.push(n);
      }
      unobserve() {}
    }
    const nodes: Record<string, Record<string, unknown>> = {
      t2: { id: 't2', isConnected: true },
      t4: { id: 't4', isConnected: true },
    };
    const el = {
      data: {
        turns: [{ id: 't1' }, { id: 't2', loading: true }, { id: 't4', loading: true }, { id: 't5', markdown: 'x' }],
      },
      turnElement: (id: string) => nodes[id] ?? null,
    };
    const m = (io: unknown) =>
      load<{ convWatchAnswers(el: unknown): void }>(['convViewport', 'convWatchAnswers'], ['_ansIo'], {
        IntersectionObserver: io,
        _psec: 'conv',
        _panelAgent: '',
        _panelTurnsCid: 'conv-run',
        panelConvId: 'conv-run',
        convLoadAnswer: (cid: string, id: string) => loaded.push(`${cid}:${id}`),
      });
    const a = m(IO);
    a.convWatchAnswers(el);
    a.convWatchAnswers(el);
    expect(observed).toEqual([nodes.t2, nodes.t4]);
    expect(opts).toEqual({ rootMargin: '800px 0px' });
    expect(nodes.t2._ansCid).toBe('conv-run');
    for (const n of Object.values(nodes)) delete n._ansWatched;
    m(undefined).convWatchAnswers(el);
    expect(loaded).toEqual(['conv-run:t2', 'conv-run:t4']);
    // Rendered: the 800px lead counts against the element's own scroll box (.ls-vp in <ui-log-scroller>).
    for (const n of Object.values(nodes)) delete n._ansWatched;
    observed.length = 0;
    const vp = { box: 'ls-vp' };
    const scroller = { shadowRoot: { querySelector: (q: string) => (q === '.ls-vp' ? vp : null) } };
    const rendered = {
      ...el,
      shadowRoot: { querySelector: (q: string) => (q === 'ui-log-scroller' ? scroller : null) },
    };
    m(IO).convWatchAnswers(rendered);
    expect(opts).toEqual({ root: vp, rootMargin: '800px 0px' });
    expect(observed).toEqual([nodes.t2, nodes.t4]);
  });
});

describe('D14 — the answer survives its summary landing', () => {
  it('the turn keeps its cached answer when the summary arrives (no request, the element rebuilds that turn only)', () => {
    const before = answerOf({ answers: { 'conv-run:t2': FIXTURE } }, { ...ANSWER, summaryTitle: '', summaryBody: '' });
    const after = answerOf({ answers: { 'conv-run:t2': FIXTURE } });
    expect(before.markdown).toBe(FIXTURE);
    expect(after.markdown).toBe(FIXTURE);
    expect(after.summary).toEqual({ title: 'Picker bars', text: 'Three bars per model.' });
  });
});

describe('a subagent’s 지시와 답변 — the same element, two turns', () => {
  const turns = (a: unknown, io: unknown, prompt: string | null, answer: string | null, ad: Data) =>
    load<{
      agentConvTurns(
        id: string,
        a: unknown,
        io: unknown,
        p: string | null,
        ans: string | null,
        ad: Data,
      ): { turns: Turn[]; pending: boolean };
    }>(['toNum', 'agentConvTurns'], [], {
      agentName: () => 'A1 Explore',
      agentStatusOf: (x: { status: string }) => x.status,
    }).agentConvTurns('a1', a, io, prompt, answer, ad);
  const data = (a: unknown, io: unknown, answer: string | null, s: unknown = SESSION, failed = '') =>
    load<{ agentAnswerData(a: unknown, io: unknown, answer: string | null, s: unknown, failed: string): Data }>(
      ['ansLinkTitles', 'agentAnswerData'],
      [],
    ).agentAnswerData(a, io, answer, s, failed);
  const done = { status: 'completed', description: 'Map the picker', summary: 'Tray reads MODEL_STATS.' };
  const result = { seq: 7, text: 'Task ok', ts: T0 + 5000 };
  const spawn = { seq: 3, text: 'preview', ts: T0 };

  it('a result: Main’s instruction (its description first), then the answer with Raw’s source as written', () => {
    const r = turns(done, { spawn, result }, 'the prompt', `Done: ${PR}`, data(done, { result }, `Done: ${PR}`));
    expect(r.pending).toBe(false);
    expect(r.turns).toEqual([
      { id: 'agent:a1:spawn', role: 'user', name: '지시 · Main', text: 'Map the picker\n\nthe prompt', at: T0 },
      {
        id: 'agent:a1:result',
        role: 'assistant',
        name: 'A1 Explore',
        summary: { text: 'Tray reads MODEL_STATS.' },
        at: T0 + 5000,
        markdown: `Done: ${PR}`,
        linkTitles: TITLES,
        source: `Done: ${PR}`,
      },
    ]);
  });

  it('running with no result: the writing row; nothing at all: the agent’s own line', () => {
    const running = { ...done, status: 'running' };
    expect(turns(running, { spawn, result: null }, null, null, data(running, { result: null }, null))).toEqual({
      turns: [{ id: 'agent:a1:spawn', role: 'user', name: '지시 · Main', text: 'Map the picker\n\npreview', at: T0 }],
      pending: true,
    });
    const quiet = turns({ status: 'completed' }, { result: null }, null, null, {});
    expect(quiet.turns).toEqual([
      {
        id: 'agent:a1:result',
        role: 'assistant',
        name: 'A1 Explore',
        markdown: '',
        summary: { text: '작업 로그에 결과가 없습니다' },
      },
    ]);
  });

  it('a raw that failed to load: failed with 다시 시도, headed by the agent’s summary — never an empty answer', () => {
    const r = turns(
      done,
      { result: { ...result, rawBytes: 9 } },
      null,
      null,
      data(done, { result }, null, SESSION, 'HTTP 502'),
    );
    expect(r.turns[r.turns.length - 1]).toMatchObject({ markdown: '', error: 'HTTP 502', canRetry: true });
    expect(clientFn('renderAgentConv')).toContain(
      '_agentSeq = io.result && io.result.rawBytes ? Math.floor(Number(io.result.seq) || 0) : null;',
    );
  });

  it('agentAnswerData: writing → loading → the answer (summary when unreadable), titled, never animated', () => {
    expect(data({ ...done, status: 'running' }, { result: null }, null)).toEqual({ markdown: '', streaming: true });
    expect(data(done, { result }, null)).toEqual({ markdown: '', loading: true });
    expect(data(done, { result }, `Done: ${PR}`)).toEqual({
      markdown: `Done: ${PR}`,
      linkTitles: TITLES,
      animate: false,
    });
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
    expect(clientFn('renderAgentConv')).toContain(
      "var failed = io.result && io.result.rawBytes ? agentConvFailure(io.result.seq) : '';",
    );
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

  it('D3 — 지시와 답변 is <ui-conversation> (conversation.js, served; it nests ui-ai-answer) in the token wrapper', () => {
    expect(HEAD).toContain(`<script type="module" src="/dashboard/ui/conversation.js?v=\${UI_LIB_VERSION}"></script>`);
    expect(existsSync(join(uiLibDistDir() as string, 'conversation.js'))).toBe(true);
    // D4 E-24: the box is the Chat tab's panel of <ui-tabs> (slotted by the tab's id).
    expect(TEMPLATE).toContain('<div class="psec psec-el ui-tok" id="psec-conv" slot="conv">');
    expect(TEMPLATE).toContain('<ui-conversation class="panel-conv" id="panel-conv" lang="ko"></ui-conversation>');
    expect(CSS).toMatch(/\.ui-tok \{[^}]*--ui-surface-raised: var\(--surface-raised\)/);
  });

  it('D3 — the inline turn renderer, its answer slots and their styles are gone', () => {
    for (const gone of [
      'renderTurn',
      'renderSysTurn',
      'turnsSkeletonHtml',
      'ansSlotHtml',
      'ansPaint',
      'ansLoad',
      'ansSummaryTitle',
      'attachRawToggleHandlers',
      'decorateAnswerTurns',
      'decoratePanelTurns',
      'ansPendingHtml',
      'syncAnsPending',
      'ansTookLabel',
      'ansTookFor',
      'updateTurnInPanel',
      'paintConvTab',
      'agentConvHtml',
      'BOT_AVATAR_SVG',
      'SYS_AVATAR_SVG',
    ]) {
      expect(declarationCount(gone), gone).toBe(0);
    }
    for (const cls of [
      '.turn-answer',
      '.ans-lite',
      '.ans-took',
      '.turn-raw',
      '.panel-turns',
      '.sk-turn',
      '.sys-turn',
    ]) {
      expect(CSS, cls).not.toContain(cls);
    }
    expect(TEMPLATE).not.toContain("document.addEventListener('ui-retry'");
    expect(TEMPLATE).not.toContain('panel-turns');
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
    for (const name of ['ansLinkTitles', 'convTurnsOf', 'convPaint', 'agentAnswerData', 'agentConvTurns']) {
      expect(clientFn(name), name).not.toMatch(/출처|인용/);
    }
  });

  it('each client function is declared exactly once', () => {
    for (const name of [
      'ansLinkTitles',
      'ansSession',
      'ansCacheKey',
      '_ansInflight',
      '_ansFailed',
      '_ansIo',
      'ansPendingShow',
      'agentAnswerData',
      'agentConvTurns',
      'convEl',
      'convSummaryOf',
      'convSysTurn',
      'convTurnsOf',
      'convSlots',
      'convSetData',
      'convPaint',
      'convPaintSoon',
      'appendTurnToPanel',
      'dropTurnFromPanel',
      'convWatchAnswers',
      'convLoadAnswer',
      'convRetry',
      'loadPanelTurns',
      'loadMorePanelTurns',
      'botNameOf', // SSOT 2026-10-29 T8
      'BOT_NAME',
    ]) {
      expect(declarationCount(name), name).toBe(1);
    }
  });
});
