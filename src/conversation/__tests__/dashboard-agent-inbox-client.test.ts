/**
 * Executes the Agent inbox client code that ships in the dashboard template
 * (.prd/10 §3.1, §3.3) — no copies. Each function is cut out of
 * renderDashboardPage()'s template literal and evaluated as a template literal
 * first, so its escapes come out exactly as the browser receives them; it is
 * then run against injected fetch / timers / caches.
 *
 * Covered: work-log merge by seq identity and HTTP recovery paging, the card
 * 지시/응답 retry rule, HTML escaping of work-log entries, and the contrast of
 * the board's muted text tokens.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

/** Evaluate a template-literal fragment the way the server does (\\n → \n, \\' → \'). */
function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
/** Source of a top-level client function, as served. */
/** Every top-level declaration of NAME in the template (function / async function / var / let / const). */
function declarationCount(name: string): number {
  const re = new RegExp(`^(?:async function|function|var|let|const) ${name.replace(/[$]/g, '\\$')}\\b`, 'gm');
  return (TEMPLATE.match(re) ?? []).length;
}
/** Refuse a name the page declares more than once: the browser runs the LAST one. */
function assertUnique(name: string) {
  const n = declarationCount(name);
  if (n > 1)
    throw new Error(`client ${name} is declared ${n} times — the page runs the last one; tests must not pick one`);
}
function clientFn(name: string): string {
  assertUnique(name);
  const plain = TEMPLATE.indexOf(`\nfunction ${name}(`);
  const start = plain >= 0 ? plain : TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
/** A single-line top-level `var NAME = …;` declaration (a trailing // comment is dropped), as served. */
function clientVar(name: string): string {
  assertUnique(name);
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
/**
 * Build a module from shipped functions; `inject` names become parameters.
 * `seams` are test-only functions compiled in the same scope (so they can
 * reach shipped vars) and returned next to the shipped ones.
 */
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}, seams: string[] = []): T {
  const names = Object.keys(inject);
  const seamNames = seams.map((src) => /^function (\w+)/.exec(src)?.[1] ?? '');
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\n${seams.join('\n')}\nreturn { ${[...fns, ...seamNames].join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

type Entry = { seq: number; ts?: number; kind?: string; text?: string; tool?: string; ok?: boolean };
type Added = { entry: Entry; index: number };
type WlState = { convId: string; entries: Entry[]; cursor: number; closed: boolean };
type FetchJson = (url: string) => Promise<unknown>;
interface WorkLogCore {
  wlNewState(convId: string): WlState;
  wlUrl(convId: string, afterSeq: number | null): string;
  wlMerge(state: WlState, entries: unknown[]): Added[];
  wlLoadLatest(state: WlState, fetchJson: FetchJson, onAdded: OnAdded): Promise<string>;
  wlOnLive(state: WlState, entry: unknown, fetchJson: FetchJson, onAdded: OnAdded): Added[];
  wlRecover(state: WlState, fetchJson: FetchJson, onAdded: OnAdded): Promise<unknown>;
}
type OnAdded = (s: WlState, a: Added[]) => void;
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

describe('work log core (shipped wl* functions)', () => {
  const wl = load<WorkLogCore>(
    [
      'wlNewState',
      'wlUrl',
      'wlLatestUrl',
      'wlValidSeq',
      'wlMerge',
      'wlPageMaxSeq',
      'wlAdvance',
      'wlConfirm',
      'wlHasGap',
      'wlStatusOf',
      'wlDeny',
      'wlLoadLatest',
      'wlOnLive',
      'wlRecover',
    ],
    ['WL_BACKFILL_MAX_PAGES', 'WL_PAGE'],
  );
  const seqs = (s: WlState) => s.entries.map((e) => e.seq);
  const range = (a: number, b: number): Entry[] => Array.from({ length: b - a + 1 }, (_, i) => ({ seq: a + i }));
  /** Settle a recovery the core started on its own (gap). */
  const settled = async (st: WlState) => {
    for (let i = 0; i < 50 && (st as unknown as { recovering: unknown }).recovering; i++) await flush();
    await flush();
  };

  /** Mirrors paintWorkLog: insert each added entry at its index into a list. */
  function domModel() {
    const list: number[] = [];
    const onAdded: OnAdded = (_s, added) => {
      for (const a of added) list.splice(a.index, 0, a.entry.seq);
    };
    return { list, onAdded };
  }

  /** Server with a growing log: no afterSeq = last page; afterSeq = first page after it. */
  function server(log: Entry[], pageSize: number, opts: { omitHasMore?: boolean; status?: number } = {}) {
    const calls: Array<number | null> = [];
    const fetchJson: FetchJson = async (url) => {
      const q = new URL(url, 'http://h').searchParams.get('afterSeq');
      if (q !== null && !/^\d+$/.test(q)) throw httpError(400); // the API rejects non-integers
      calls.push(q === null ? null : Number(q));
      if (opts.status) throw httpError(opts.status);
      const rest = q === null ? log : log.filter((e) => e.seq > Number(q));
      const entries = q === null ? rest.slice(-pageSize) : rest.slice(0, pageSize);
      const hasMore = rest.length > pageSize;
      return opts.omitHasMore ? { entries } : { entries, hasMore };
    };
    return { calls, fetchJson };
  }

  /** Like server(), but afterSeq requests answer only on drain(); the page is
   *  the log as it was when the request arrived (the server's snapshot). */
  function deferredServer(log: Entry[], pageSize: number) {
    const calls: Array<number | null> = [];
    const pending: Array<() => void> = [];
    const fetchJson: FetchJson = async (url) => {
      const q = new URL(url, 'http://h').searchParams.get('afterSeq');
      calls.push(q === null ? null : Number(q));
      const rest = q === null ? log.slice() : log.filter((e) => e.seq > Number(q));
      const entries = q === null ? rest.slice(-pageSize) : rest.slice(0, pageSize);
      const hasMore = rest.length > pageSize;
      if (q !== null)
        await new Promise<void>((r) => {
          pending.push(r);
        });
      return { entries, hasMore };
    };
    const drain = async () => {
      for (let i = 0; i < 30; i++) {
        await flush();
        for (const r of pending.splice(0)) r();
      }
    };
    return { calls, fetchJson, drain };
  }

  it('builds the latest-window URL without afterSeq, and integer-only afterSeq otherwise', () => {
    expect(wl.wlUrl('c/1', null)).toBe('/api/dashboard/session/c%2F1/worklog');
    expect(wl.wlUrl('c1', undefined as unknown as null)).toBe('/api/dashboard/session/c1/worklog');
    expect(wl.wlUrl('c1', 0)).toBe('/api/dashboard/session/c1/worklog?afterSeq=0');
    expect(wl.wlUrl('c1', 42)).toBe('/api/dashboard/session/c1/worklog?afterSeq=42');
    for (const [v, want] of [
      [3.7, '3'],
      [-5, '0'],
      [Number.NaN, '0'],
      ['12', '12'],
    ] as const) {
      expect(wl.wlUrl('c1', v as unknown as number)).toBe(`/api/dashboard/session/c1/worklog?afterSeq=${want}`);
    }
    expect(wl.wlUrl('c1', 7)).not.toContain('limit=');
  });

  it('the initial load asks for the LATEST window — never afterSeq=0 (which is the oldest page)', async () => {
    const srv = server(range(1, 30), 10);
    const st = wl.wlNewState('c1');
    expect(await wl.wlLoadLatest(st, srv.fetchJson, () => {})).toBe('ok');
    expect(srv.calls).toEqual([null]);
    expect(seqs(st)).toEqual(range(21, 30).map((e) => e.seq));
  });

  it('a live entry that lands before the HTTP page does not hide the older batch', async () => {
    const srv = server(range(1, 20), 10);
    const st = wl.wlNewState('c1');
    const dom = domModel();
    wl.wlOnLive(st, { seq: 21, kind: 'tool' }, srv.fetchJson, dom.onAdded); // WS first
    wl.wlOnLive(st, { seq: 15, kind: 'tool' }, srv.fetchJson, dom.onAdded); // WS, also inside the page
    expect(srv.calls).toEqual([]); // nothing fetched before the initial load answers
    expect(await wl.wlLoadLatest(st, srv.fetchJson, dom.onAdded)).toBe('ok');
    await settled(st);
    expect(seqs(st)).toEqual(range(11, 21).map((e) => e.seq));
    expect(dom.list).toEqual(seqs(st));
    expect(st.cursor).toBe(21); // 21 directly follows the page → contiguous, no gap
    expect(srv.calls).toEqual([null]);
  });

  it('a live entry that skips seqs triggers a backfill from the contiguous cursor', async () => {
    const log = range(1, 20);
    const srv = server(log, 10);
    const st = wl.wlNewState('c1');
    const dom = domModel();
    await wl.wlLoadLatest(st, srv.fetchJson, dom.onAdded);
    log.push(...range(21, 30));
    wl.wlOnLive(st, { seq: 21 }, srv.fetchJson, dom.onAdded); // contiguous: no request
    expect(srv.calls).toEqual([null]);
    expect(st.cursor).toBe(21);
    wl.wlOnLive(st, { seq: 25 }, srv.fetchJson, dom.onAdded); // 22–24 missing
    await settled(st);
    expect(srv.calls).toEqual([null, 21]);
    expect(seqs(st)).toEqual(range(11, 30).map((e) => e.seq));
    expect(dom.list).toEqual(seqs(st));
    expect(st.cursor).toBe(30);
  });

  it('entries written while the initial load was in flight are backfilled right after it', async () => {
    const log = range(1, 20);
    const srv = server(log, 10);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const delayed: FetchJson = async (url) => {
      const snapshot = url.includes('afterSeq') ? null : await srv.fetchJson(url); // answers for log 1–20
      if (snapshot) {
        await gate;
        return snapshot;
      }
      return srv.fetchJson(url);
    };
    const st = wl.wlNewState('c1');
    const load = wl.wlLoadLatest(st, delayed, () => {});
    await flush();
    log.push(...range(21, 30)); // written after the request went out
    wl.wlOnLive(st, { seq: 27 }, delayed, () => {}); // and broadcast before the answer
    release();
    expect(await load).toBe('ok');
    await settled(st);
    expect(srv.calls).toEqual([null, 20]);
    expect(seqs(st)).toEqual(range(11, 30).map((e) => e.seq));
    expect(st.cursor).toBe(30);
  });

  it('several live entries while the final backfill page is pending → exactly one backfill', async () => {
    const log = range(1, 20);
    const srv = deferredServer(log, 10);
    const st = wl.wlNewState('c1');
    await wl.wlLoadLatest(st, srv.fetchJson, () => {});
    log.push(...range(21, 25));
    wl.wlOnLive(st, { seq: 22 }, srv.fetchJson, () => {}); // 21 missing → backfill after 20 (pending)
    await flush();
    for (const seq of [23, 24, 25]) wl.wlOnLive(st, { seq }, srv.fetchJson, () => {});
    await srv.drain(); // the page (21–25) already covers every one of them
    await settled(st);
    expect(srv.calls).toEqual([null, 20]);
    expect(seqs(st)).toEqual(range(11, 25).map((e) => e.seq));
    expect(st.cursor).toBe(25);
  });

  it('a reconnect during an in-flight backfill still re-fetches afterwards', async () => {
    const log = range(1, 20);
    const srv = deferredServer(log, 10);
    const st = wl.wlNewState('c1');
    await wl.wlLoadLatest(st, srv.fetchJson, () => {});
    log.push(...range(21, 22));
    wl.wlOnLive(st, { seq: 22 }, srv.fetchJson, () => {});
    await flush();
    wl.wlRecover(st, srv.fetchJson, () => {}); // socket dropped and came back meanwhile
    log.push(...range(23, 24)); // missed while it was down
    await srv.drain();
    await settled(st);
    expect(srv.calls).toEqual([null, 20, 22]);
    expect(seqs(st).slice(-2)).toEqual([23, 24]);
  });

  describe('seqs are increasing but not contiguous — a permanent hole (57 → 1001)', () => {
    const holeLog = () => range(1, 57);

    it('via a live entry: exactly one backfill, cursor 1001, then live 1002 fetches nothing', async () => {
      const log = holeLog();
      const srv = server(log, 10);
      const st = wl.wlNewState('c1');
      await wl.wlLoadLatest(st, srv.fetchJson, () => {});
      expect(st.cursor).toBe(57);
      log.push({ seq: 1001 }); // the store restarted on a new seq block
      wl.wlOnLive(st, { seq: 1001 }, srv.fetchJson, () => {});
      await settled(st);
      expect(srv.calls).toEqual([null, 57]);
      expect(st.cursor).toBe(1001);
      log.push({ seq: 1002 });
      wl.wlOnLive(st, { seq: 1002 }, srv.fetchJson, () => {});
      await settled(st);
      expect(srv.calls).toEqual([null, 57]);
      expect(st.cursor).toBe(1002);
      expect(seqs(st)).toEqual([...range(48, 57).map((e) => e.seq), 1001, 1002]);
    });

    it('via a page: a recovery page that jumps the hole moves the cursor past it', async () => {
      const log = holeLog();
      const srv = server(log, 10);
      const st = wl.wlNewState('c1');
      await wl.wlLoadLatest(st, srv.fetchJson, () => {});
      log.push({ seq: 1001 });
      await wl.wlRecover(st, srv.fetchJson, () => {}); // reconnect
      expect(srv.calls).toEqual([null, 57]);
      expect(st.cursor).toBe(1001);
      log.push({ seq: 1002 });
      wl.wlOnLive(st, { seq: 1002 }, srv.fetchJson, () => {});
      await settled(st);
      expect(srv.calls).toEqual([null, 57]);
    });

    it('via the latest window: a hole inside the first page needs no backfill at all', async () => {
      const log = [...range(50, 57), { seq: 1001 }];
      const srv = server(log, 10);
      const st = wl.wlNewState('c1');
      await wl.wlLoadLatest(st, srv.fetchJson, () => {});
      wl.wlOnLive(st, { seq: 1002 }, srv.fetchJson, () => {});
      await settled(st);
      expect(srv.calls).toEqual([null]);
      expect(st.cursor).toBe(1002);
    });

    it('defensive: a backfill that brings nothing new still closes the gap (no retry loop)', async () => {
      // This fixture breaks durable-before-broadcast on purpose (1001 is
      // broadcast but not readable): the client must still not loop.
      const srv = server(holeLog(), 10);
      const st = wl.wlNewState('c1');
      await wl.wlLoadLatest(st, srv.fetchJson, () => {});
      wl.wlOnLive(st, { seq: 1001 }, srv.fetchJson, () => {});
      await settled(st);
      expect(srv.calls).toEqual([null, 57]);
      expect(st.cursor).toBe(1001);
      wl.wlOnLive(st, { seq: 1002 }, srv.fetchJson, () => {});
      wl.wlOnLive(st, { seq: 1003 }, srv.fetchJson, () => {});
      await settled(st);
      expect(srv.calls).toEqual([null, 57]);
    });

    it('an empty final page confirms only up to what was held when it was requested', async () => {
      // Valid ordering: the snapshot (nothing after 57) predates 58–60, which
      // are written while it is in flight; only 60's broadcast reaches us.
      const log = holeLog();
      const srv = deferredServer(log, 10);
      const st = wl.wlNewState('c1');
      await wl.wlLoadLatest(st, srv.fetchJson, () => {});
      const run = wl.wlRecover(st, srv.fetchJson, () => {}); // reconnect, snapshot = nothing after 57
      await flush();
      log.push(...range(58, 60));
      wl.wlOnLive(st, { seq: 60 }, srv.fetchJson, () => {});
      await srv.drain();
      await run;
      await settled(st);
      // Confirming up to the response-time max (60) would have skipped 58–59.
      expect(srv.calls).toEqual([null, 57, 57]);
      expect(seqs(st).slice(-4)).toEqual([57, 58, 59, 60]);
      expect(st.cursor).toBe(60);
    });

    it('a full page (hasMore) confirms only up to its last seq, then keeps paging', async () => {
      const log = range(1, 31);
      const srv = server(log, 5);
      const st = wl.wlNewState('c1');
      await wl.wlLoadLatest(st, srv.fetchJson, () => {});
      expect(st.cursor).toBe(31);
      log.push(...range(32, 40));
      wl.wlOnLive(st, { seq: 40 }, srv.fetchJson, () => {});
      await settled(st);
      expect(srv.calls).toEqual([null, 31, 36]);
      expect(seqs(st)).toEqual(range(27, 40).map((e) => e.seq));
      expect(st.cursor).toBe(40);
    });
  });

  it('merges duplicate and out-of-order seqs into one ordered list; non-integer seqs are ignored', () => {
    const st = wl.wlNewState('c1');
    const dom = domModel();
    dom.onAdded(st, wl.wlMerge(st, [{ seq: 3 }, { seq: 1 }, { seq: 2 }, { seq: 2 }, { seq: 1 }]));
    dom.onAdded(st, wl.wlMerge(st, [{ seq: 7 }, { seq: 5 }, { seq: 3 }]));
    dom.onAdded(st, wl.wlMerge(st, [{ seq: 4 }, { seq: 6 }]));
    const junk = [
      null,
      {},
      { seq: '9' },
      { seq: Number.NaN },
      { seq: 0.5 },
      { seq: 0 },
      { seq: -1 },
      { seq: 2 ** 53 },
      { seq: 7 },
    ];
    expect(wl.wlMerge(st, junk)).toEqual([]);
    expect(seqs(st)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(dom.list).toEqual(seqs(st));
  });

  it('reconnect recovery pages forward from the cursor while hasMore === true', async () => {
    const log = range(1, 20);
    const srv = server(log, 10);
    const st = wl.wlNewState('c1');
    const dom = domModel();
    await wl.wlLoadLatest(st, srv.fetchJson, dom.onAdded);
    log.push(...range(21, 37)); // broadcast while the socket was down
    await wl.wlRecover(st, srv.fetchJson, dom.onAdded);
    expect(srv.calls).toEqual([null, 20, 30]);
    expect(seqs(st)).toEqual(range(11, 37).map((e) => e.seq));
    expect(dom.list).toEqual(seqs(st));
    expect(st.cursor).toBe(37);
  });

  it('treats a missing hasMore as the last page', async () => {
    const srv = server(range(1, 30), 5, { omitHasMore: true });
    const st = wl.wlNewState('c1');
    await wl.wlLoadLatest(
      st,
      async () => ({ entries: [] }),
      () => {},
    );
    await wl.wlRecover(st, srv.fetchJson, () => {});
    expect(srv.calls).toEqual([0]);
    expect(seqs(st)).toEqual([1, 2, 3, 4, 5]);
  });

  it('recovers an empty log with an explicit afterSeq=0 request', async () => {
    const log: Entry[] = [];
    const srv = server(log, 10);
    const st = wl.wlNewState('c1');
    expect(await wl.wlLoadLatest(st, srv.fetchJson, () => {})).toBe('ok');
    expect(st.cursor).toBe(0);
    log.push(...range(1, 3));
    await wl.wlRecover(st, srv.fetchJson, () => {});
    expect(srv.calls).toEqual([null, 0]);
    expect(seqs(st)).toEqual([1, 2, 3]);
  });

  it('if the initial load failed, recovery retries the latest window instead of paging from 0', async () => {
    let down = true;
    const srv = server(range(1, 30), 10);
    const flaky: FetchJson = async (url) => {
      if (down) throw httpError(502);
      return srv.fetchJson(url);
    };
    const st = wl.wlNewState('c1');
    expect(await wl.wlLoadLatest(st, flaky, () => {})).toBe('error');
    down = false;
    await wl.wlRecover(st, flaky, () => {});
    await settled(st);
    expect(srv.calls).toEqual([null]);
    expect(seqs(st)).toEqual(range(21, 30).map((e) => e.seq));
  });

  it('403 from any path is reported once through state.onDenied', async () => {
    // First load fails transiently, the recovery's latest-window retry gets 403.
    let first = true;
    const flaky: FetchJson = async () => {
      if (first) {
        first = false;
        throw httpError(502);
      }
      throw httpError(403);
    };
    const st = wl.wlNewState('c1') as WlState & { onDenied?: (s: unknown) => void };
    const denied: unknown[] = [];
    st.onDenied = (s) => denied.push(s);
    expect(await wl.wlLoadLatest(st, flaky, () => {})).toBe('error');
    expect(denied).toEqual([]);
    await wl.wlRecover(st, flaky, () => {});
    expect(denied).toEqual([st]);

    // A backfill page that answers 403 (after a good first load).
    let calls = 0;
    const st2 = wl.wlNewState('c2') as WlState & { onDenied?: (s: unknown) => void };
    const denied2: unknown[] = [];
    st2.onDenied = (s) => denied2.push(s);
    await wl.wlLoadLatest(
      st2,
      async () => ({ entries: range(1, 3) }),
      () => {},
    );
    wl.wlOnLive(
      st2,
      { seq: 9 },
      async () => {
        calls++;
        throw httpError(403);
      },
      () => {},
    );
    await settled(st2);
    expect(denied2).toEqual([st2]);
    expect(calls).toBe(1);
    // Closed states (panel moved on) are not reported.
    const st3 = wl.wlNewState('c3') as WlState & { onDenied?: (s: unknown) => void };
    const denied3: unknown[] = [];
    st3.onDenied = (s) => denied3.push(s);
    const p = wl.wlLoadLatest(
      st3,
      async () => Promise.reject(httpError(403)),
      () => {},
    );
    st3.closed = true;
    await p;
    expect(denied3).toEqual([]);
  });

  it('403 means owner-only: no entries, no recovery, live entries ignored', async () => {
    const srv = server(range(1, 30), 10, { status: 403 });
    const st = wl.wlNewState('c1');
    expect(await wl.wlLoadLatest(st, srv.fetchJson, () => {})).toBe('denied');
    await wl.wlRecover(st, srv.fetchJson, () => {});
    expect(wl.wlOnLive(st, { seq: 5 }, srv.fetchJson, () => {})).toEqual([]);
    await settled(st);
    expect(srv.calls).toEqual([null]);
    expect(seqs(st)).toEqual([]);
    expect(await wl.wlLoadLatest(wl.wlNewState('c2'), server([], 1, { status: 404 }).fetchJson, () => {})).toBe(
      'missing',
    );
  });

  it('stops on a page that does not advance, and after the page cap', async () => {
    const stuck: string[] = [];
    const st = wl.wlNewState('c1');
    await wl.wlLoadLatest(
      st,
      async () => ({ entries: [] }),
      () => {},
    );
    await wl.wlRecover(
      st,
      async (url) => {
        stuck.push(url);
        return { entries: range(1, 5), hasMore: true };
      },
      () => {},
    );
    expect(stuck.map((u) => new URL(u, 'http://h').searchParams.get('afterSeq'))).toEqual(['0', '5']);

    let calls = 0;
    const st2 = wl.wlNewState('c2');
    await wl.wlLoadLatest(
      st2,
      async () => ({ entries: [] }),
      () => {},
    );
    await wl.wlRecover(
      st2,
      async (url) => {
        calls++;
        const after = Number(new URL(url, 'http://h').searchParams.get('afterSeq'));
        return { entries: [{ seq: after + 1 }], hasMore: true };
      },
      () => {},
    );
    expect(calls).toBe(Number(clientVar('WL_BACKFILL_MAX_PAGES').match(/\d+/)?.[0]));
  });

  it('drops responses that land after the panel switched to another conversation', async () => {
    let release: (v: unknown) => void = () => {};
    const pending = new Promise((r) => {
      release = r;
    });
    const st = wl.wlNewState('c1');
    const added: Added[] = [];
    const done = wl.wlLoadLatest(
      st,
      () => pending,
      (_s, a) => added.push(...a),
    );
    st.closed = true; // resetWorkLog() for the next conversation
    release({ entries: range(1, 3), hasMore: false });
    expect(await done).toBe('closed');
    expect(added).toEqual([]);
    expect(seqs(st)).toEqual([]);

    const calls: string[] = [];
    const st2 = wl.wlNewState('c2');
    await wl.wlLoadLatest(
      st2,
      async () => ({ entries: [] }),
      () => {},
    );
    const run = wl.wlRecover(
      st2,
      async (url) => {
        calls.push(url);
        st2.closed = true; // switched while this page was in flight
        return { entries: range(1, 5), hasMore: true };
      },
      () => {},
    );
    await run;
    expect(calls).toHaveLength(1);
    expect(seqs(st2)).toEqual([]);
  });
});

// What an instruction row reads (SSOT 2026-10-28): the conversation's system-turn
// reading and the skill badges.
const WL_INSTRUCTION_FNS = [
  'toNum',
  'formatTokens',
  'sysOneLine',
  'sysBetween',
  'sysResumeContext',
  'sysTurnInfo',
  'sysFactsHtml',
  'estimateTokens',
  'splitInvokedSkills',
  'skillBadgesHtml',
  'wlInstructionTurn',
  'wlEntryFactsHtml',
  'wlCutSkills',
  'wlCutSkillsHtml',
];
const WL_INSTRUCTION_VARS = ['SYS_RESTART_HEADS', 'SYS_RESUME_CONTEXT', 'SYS_RETRY_MARK', '_skillBodies', '_skillSeq'];

describe('work-log entry rendering escapes hostile text (shipped renderWorkLogEntry + esc)', () => {
  const { renderWorkLogEntry } = load<{ renderWorkLogEntry(e: unknown): string }>(
    ['decodeSlackEntities', 'esc', 'escAttr', ...WL_INSTRUCTION_FNS, 'wlToolSummary', 'renderWorkLogEntry'],
    ['WL_LABELS', ...WL_INSTRUCTION_VARS],
  );
  /** Every " left after removing the attributes we emit would be an attribute break-out. */
  const strayQuotes = (html: string) =>
    html
      .replace(/\s(class|title|data-seq|role|tabindex|aria-expanded|aria-controls|aria-live|id)="[^"]*"/g, '')
      .includes('"');
  const tags = (html: string) =>
    (html.match(/<\/?([a-z0-9]+)/gi) ?? []).map((t) => t.replace(/[</]/g, '').toLowerCase());

  it('a tool call is one card element; its fallback text (shown only if the element never loads) is escaped', () => {
    for (const kind of ['tool', 'tool_result']) {
      const html = renderWorkLogEntry({
        seq: 1,
        ts: 0,
        kind,
        tool: '<img src=x onerror=alert(1)>',
        text: '"><script>alert(1)</script><a href="javascript:x">',
      });
      const all = (html.match(/<\/?([a-z0-9-]+)/gi) ?? []).map((t) => t.replace(/[</]/g, '').toLowerCase());
      expect(new Set(all)).toEqual(new Set(['div', 'ui-tool-call-card', 'span']));
      expect(html).not.toContain('<img');
      expect(html).not.toContain('<script');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      // Every " left after removing the attributes we emit (and the escaped text) would be a break-out.
      expect(html.replace(/\s(class|data-seq|lang|data-key)="[^"]*"/g, '')).not.toContain('"');
    }
    // A hostile seq cannot reach data-seq / data-key.
    expect(renderWorkLogEntry({ seq: '5" onmouseover="x', kind: 'tool', text: 'x' })).toContain('data-key="0"');
  });

  it('narration, Slack-encoded instructions, odd kinds and seqs stay inert', () => {
    for (const e of [
      { seq: 2, kind: 'narration', text: '<b onmouseover="x">hi</b>' },
      { seq: 3, kind: 'instruction', text: '&lt;script&gt;alert(1)&lt;/script&gt;' },
      { seq: 4, kind: '"><svg onload=alert(1)>', text: 'x' },
      { seq: '5" onmouseover="x', kind: 'final', text: '</div><iframe src=//x>' },
      { seq: 6, kind: '__proto__', tool: '"x', text: '"' },
    ]) {
      const html = renderWorkLogEntry(e);
      expect(
        tags(html).every((t) => t === 'div' || t === 'span'),
        html,
      ).toBe(true);
      expect(strayQuotes(html), html).toBe(false);
    }
  });

  it('every entry is one root: a keyboard-reachable row that controls its (empty, hidden) detail block', () => {
    expect(renderWorkLogEntry({ seq: 7, kind: 'tool', tool: 'Bash', text: 'Bash {"command":"ls"}' })).toBe(
      '<div class="wl-entry wl-toolcall" data-seq="7"><ui-tool-call-card class="wl-card" lang="ko" data-key="7">' +
        '<span class="wl-card-fallback"><span class="wl-tool-name">Bash</span> {&quot;command&quot;:&quot;ls&quot;}</span>' +
        '</ui-tool-call-card></div>',
    );
    expect(renderWorkLogEntry({ seq: 9, kind: 'tool_result', tool: 'Bash', ok: false, text: 'Bash error' })).toBe(
      '<div class="wl-entry wl-toolcall is-orphan" data-seq="9"><ui-tool-call-card class="wl-card" lang="ko" data-key="9">' +
        '<span class="wl-card-fallback"><span class="wl-tool-name">Bash</span> 실패</span></ui-tool-call-card></div>',
    );
    for (const e of [
      { seq: 8, kind: 'narration', text: 'Reading the schema.' },
      { seq: 9, kind: 'final', text: 'Done.' },
    ]) {
      const html = renderWorkLogEntry(e);
      expect(html.startsWith(`<div class="wl-entry wl-${e.kind}`), html).toBe(true);
      expect(html).toContain(` data-seq="${e.seq}">`);
      expect(html).toContain(
        // Roving tabindex: rows render out of the tab order; the list keeps one stop (wlEnsureTabStop).
        `<div class="wl-row${e.kind === 'narration' ? ' wl-line' : ''}" role="button" tabindex="-1" aria-expanded="false" aria-controls="wl-detail-${e.seq}">`,
      );
      // aria-live="off": an opened raw output (up to 256 KiB) is not read out by the role=log list.
      expect(
        html.endsWith(`<div class="wl-detail" id="wl-detail-${e.seq}" aria-live="off" hidden></div></div>`),
        html,
      ).toBe(true);
    }
    // A hostile seq cannot reach the id / aria-controls values.
    expect(renderWorkLogEntry({ seq: '5" onmouseover="x', kind: 'final', text: 'x' })).toContain(
      'aria-controls="wl-detail-0"',
    );
  });
});

describe('work-log tool call cards print the tool name once (shipped wlToolSummary)', () => {
  const { wlToolSummary } = load<{ wlToolSummary(tool: string, text: string): string }>(['wlToolSummary'], []);
  // Stored entries carry the emitter's shape: `text` starts with the tool name
  // (packages/slack/src/stream-processor.ts summarizeToolCall). The card shows
  // the name on its own, so the summary is what follows.
  it('a tool call summary is its input after the name, not the name again', () => {
    expect(wlToolSummary('Read', 'Read {"file_path":"/a.ts"}')).toBe('{"file_path":"/a.ts"}');
  });
  it('a call without input (text is just the name) has no summary', () => {
    expect(wlToolSummary('TodoRead', 'TodoRead')).toBe('');
  });
  it('text that does not start with "<tool> " is kept whole', () => {
    expect(wlToolSummary('Read', 'Readme.md opened')).toBe('Readme.md opened');
    expect(wlToolSummary('Bash', 'backfill step 3')).toBe('backfill step 3');
    expect(wlToolSummary('', 'Read {"a":1}')).toBe('Read {"a":1}');
  });
});

describe('card 지시/응답 freshness and retry (shipped ensureCardIo)', () => {
  /** noSummary: the reply has no summary yet, so the raw-response fallback runs. */
  function harness(opts: { noSummary?: boolean } = {}) {
    let now = 1_000_000;
    const timers: Array<{ id: number; at: number; fn: () => void }> = [];
    let timerSeq = 0;
    const refreshed: string[] = [];
    let mode: 'down' | 'up' = 'down';
    let rawMode: 'down' | 'up' = 'up';
    const fetchCalls: string[] = [];
    const fetchTimes: number[] = [];
    const rawCalls: string[] = [];
    // hold(): the next main fetch stays in flight until the test settles it.
    let holdNext = false;
    let held: { reject: (e: unknown) => void } | null = null;
    const fetchStub = async (url: string) => {
      if (url.endsWith('/raw')) {
        rawCalls.push(url);
        if (rawMode === 'down') return { ok: false, status: 503, json: async () => ({}) };
        return { ok: true, json: async () => ({ raw: 'Dry run passed in 41s — raw text.' }) };
      }
      fetchCalls.push(url);
      fetchTimes.push(now);
      if (holdNext) {
        holdNext = false;
        return new Promise((_resolve, reject) => {
          held = { reject };
        });
      }
      if (mode === 'down') throw new Error('network down');
      return {
        ok: true,
        json: async () => ({
          turns: [
            { id: 'u1', role: 'user', userName: 'Zhuge', rawContent: 'staging에서 dry run 해줘' },
            opts.noSummary
              ? { id: 'a1', role: 'assistant' }
              : { id: 'a1', role: 'assistant', summaryTitle: 'Dry run passed', summaryBody: 'No errors.' },
          ],
        }),
      };
    };
    const env = {
      _sessionCache: Object.create(null),
      _cardHost: Object.create(null),
      _cardDrawn: Object.create(null),
      _expanded: new Set<string>(),
      _ioCache: Object.create(null),
      isSiblingSession: () => false,
      refreshCard: (k: string) => refreshed.push(k),
      fetch: fetchStub,
      setTimeout: (fn: () => void, ms: number) => {
        timerSeq++;
        timers.push({ id: timerSeq, at: now + ms, fn });
        return timerSeq;
      },
      clearTimeout: (id: number) => {
        const i = timers.findIndex((x) => x.id === id);
        if (i >= 0) timers.splice(i, 1);
      },
      Date: { now: () => now },
    };
    const io = load<{
      ensureCardIo(key: string, force?: boolean): void;
      invalidateCardIo(cid: string): void;
      cardIoConsumer(cid: string): string | null;
      ioNeedsFetch(c: unknown, stamp: string, force: boolean, now: number, fromTimer?: boolean): boolean;
      releaseCardIoTimer(cid: string): void;
    }>(
      [
        'decodeSlackEntities',
        'ioBackoffMs',
        'ioNeedsFetch',
        'ioHasBudget',
        'scheduleCardIoRetry',
        'cancelCardIoRetry',
        'cardIoConsumer',
        'releaseCardIoTimer',
        'fetchCardIo',
        'ensureCardIo',
        'retryCardIo',
        'settleCardIo',
        'invalidateCardIo',
      ],
      ['IO_RETRY_MAX_MS', 'IO_AUTO_RETRIES', '_ioTimers'],
      env,
    );
    const addCard = (key: string, cid: string) => {
      env._sessionCache[key] = {
        key,
        conversationId: cid,
        lastActivity: '2026-10-16T01:00:00.000Z',
        activityState: 'waiting',
      };
      env._cardHost[key] = {}; // drawn by the board element
      env._cardDrawn[key] = true;
      env._expanded.add(key);
    };
    // #560 review P3: a card in a closed DONE day is placed (in _cardHost) but not drawn.
    const addStub = (key: string, cid: string) => {
      addCard(key, cid);
      delete env._cardDrawn[key];
    };
    // A card that left the board: renderBoard rebuilds both maps without it.
    const leave = (key: string) => {
      delete env._cardHost[key];
      delete env._cardDrawn[key];
    };
    // Fire only the timers that are due; later ones stay pending.
    const advance = async (ms: number) => {
      now += ms;
      const due = timers.filter((x) => x.at <= now);
      for (const d of due) timers.splice(timers.indexOf(d), 1);
      for (const d of due) d.fn();
      await flush();
    };
    return {
      env,
      io,
      addCard,
      addStub,
      leave,
      advance,
      fetchCalls,
      fetchTimes,
      pendingTimers: () => timers.map((x) => x.at - now),
      hold: () => {
        holdNext = true;
        return { reject: () => held?.reject(new Error('network down')) };
      },
      rawCalls,
      refreshed,
      now: () => now,
      setMode: (m: 'down' | 'up') => {
        mode = m;
      },
      setRaw: (m: 'down' | 'up') => {
        rawMode = m;
      },
    };
  }

  it('a card left open in a closed DONE day (a stub, not drawn) consumes no 지시/응답 fetch or retry timer', async () => {
    const h = harness();
    h.setMode('up');
    h.addStub('ks', 'cs');
    expect(h.io.cardIoConsumer('cs')).toBeNull();
    h.env._ioCache.cs = { state: 'ok', stamp: 'old', data: null, fails: 0, step: 0, retryAt: 0 };
    h.io.invalidateCardIo('cs'); // a turn landed in its conversation
    await flush();
    expect(h.fetchCalls).toEqual([]);
    // Drawn (its day opened): it is the consumer again.
    h.env._cardDrawn.ks = true;
    expect(h.io.cardIoConsumer('cs')).toBe('ks');
  });

  it('a partial result (instruction ok, raw response failed) is kept and retried until the response loads', async () => {
    const h = harness({ noSummary: true });
    h.setMode('up');
    h.setRaw('down');
    h.addCard('kp', 'cp');
    h.io.ensureCardIo('kp', true);
    await flush();
    const c = h.env._ioCache.cp;
    expect(c.state).toBe('error'); // not "ok" — the response is still missing
    expect(c.data.instruction.text).toBe('staging에서 dry run 해줘');
    expect(c.data.response).toBeNull();
    expect(c.data.partial).toBe(true);
    // Same lastActivity; the response endpoint comes back; the backoff retries.
    h.setRaw('up');
    await h.advance(1000);
    expect(h.env._ioCache.cp.state).toBe('ok');
    expect(h.env._ioCache.cp.data.response.body).toBe('Dry run passed in 41s — raw text.');
    expect(h.rawCalls).toHaveLength(2);
  });

  it('a partial result is also retried by reopening the card', async () => {
    const h = harness({ noSummary: true });
    h.setMode('up');
    h.setRaw('down');
    h.addCard('kq', 'cq');
    h.io.ensureCardIo('kq', true);
    await flush();
    h.setRaw('up');
    h.io.ensureCardIo('kq', true);
    await flush();
    expect(h.env._ioCache.cq.state).toBe('ok');
    expect(h.env._ioCache.cq.data.response.body).toContain('raw text');
  });

  it('an exhausted error is fetched again once the board shows newer activity (no invalidation needed)', async () => {
    const h = harness();
    h.addCard('ks', 'cs');
    h.io.ensureCardIo('ks', true);
    await flush();
    for (let i = 0; i < 12; i++) {
      await h.advance(60_000);
      h.io.ensureCardIo('ks', false);
      await flush();
    }
    const cap = Number(clientVar('IO_AUTO_RETRIES').match(/\d+/)?.[0]);
    expect(h.fetchCalls).toHaveLength(1 + cap); // exhausted for the old stamp
    h.setMode('up');
    // A turn landed while the socket was down: only a board refresh shows it.
    h.env._sessionCache.ks.lastActivity = '2026-10-16T02:00:00.000Z';
    h.io.ensureCardIo('ks', false); // the render itself sends nothing…
    await flush();
    expect(h.fetchCalls).toHaveLength(1 + cap);
    await h.advance(0); // …it arms one retry at the deadline (already past here)
    expect(h.fetchCalls).toHaveLength(2 + cap);
    expect(h.env._ioCache.cs.state).toBe('ok');
    h.io.ensureCardIo('ks', false); // same newer stamp: fresh, nothing more
    await flush();
    expect(h.fetchCalls).toHaveLength(2 + cap);
  });

  it('a newer stamp resets the retry budget while the endpoint stays down', async () => {
    const h = harness();
    h.addCard('kr', 'cr');
    h.io.ensureCardIo('kr', true);
    await flush();
    for (let i = 0; i < 12; i++) {
      await h.advance(60_000);
      h.io.ensureCardIo('kr', false);
      await flush();
    }
    const stepBefore = h.env._ioCache.cr.step;
    h.env._sessionCache.kr.lastActivity = '2026-10-16T03:00:00.000Z';
    h.io.ensureCardIo('kr', false);
    await h.advance(0);
    expect(h.env._ioCache.cr.fails).toBe(1); // a fresh budget for the new stamp…
    expect(h.env._ioCache.cr.step).toBe(stepBefore + 1); // …but the backoff keeps growing
  });

  it('IO_AUTO_RETRIES caps automatic attempts — board re-renders cannot extend it; a reopen still retries', async () => {
    const h = harness();
    h.addCard('kc', 'cc');
    h.io.ensureCardIo('kc', true); // the opening fetch
    await flush();
    // Let every backoff timer fire, interleaved with board re-renders.
    for (let i = 0; i < 12; i++) {
      await h.advance(60_000);
      h.io.ensureCardIo('kc', false); // renderBoard on every push
      await flush();
    }
    const cap = Number(clientVar('IO_AUTO_RETRIES').match(/\d+/)?.[0]);
    expect(h.fetchCalls).toHaveLength(1 + cap);
    // More renders much later: still capped.
    await h.advance(10 * 60_000);
    h.io.ensureCardIo('kc', false);
    await flush();
    expect(h.fetchCalls).toHaveLength(1 + cap);
    // An explicit reopen retries once more.
    h.io.ensureCardIo('kc', true);
    await flush();
    expect(h.fetchCalls).toHaveLength(2 + cap);
  });

  it('a failed fetch is never fresh: it recovers on the backoff timer once the endpoint is back', async () => {
    const h = harness();
    h.addCard('k1', 'c1');
    h.io.ensureCardIo('k1', true);
    await flush();
    expect(h.env._ioCache.c1.state).toBe('error');
    expect(h.fetchCalls).toHaveLength(1);

    // Same lastActivity, inside the backoff window: no hammering.
    h.io.ensureCardIo('k1', false);
    await flush();
    expect(h.fetchCalls).toHaveLength(1);

    h.setMode('up');
    await h.advance(1000); // first backoff step
    expect(h.fetchCalls).toHaveLength(2);
    expect(h.env._ioCache.c1.state).toBe('ok');
    expect(h.env._ioCache.c1.data.instruction.text).toBe('staging에서 dry run 해줘');
    expect(h.env._ioCache.c1.data.response.title).toBe('Dry run passed');
    expect(h.refreshed).toContain('k1');

    // Fresh now: a re-render with the same lastActivity does not refetch.
    h.io.ensureCardIo('k1', false);
    await flush();
    expect(h.fetchCalls).toHaveLength(2);
  });

  it('reopening the card retries a failure immediately, ignoring the backoff', async () => {
    const h = harness();
    h.addCard('k2', 'c2');
    h.io.ensureCardIo('k2', true);
    await flush();
    expect(h.env._ioCache.c2.state).toBe('error');
    h.setMode('up');
    h.io.ensureCardIo('k2', true); // ui-toggle (open) passes force
    await flush();
    expect(h.fetchCalls).toHaveLength(2);
    expect(h.env._ioCache.c2.state).toBe('ok');
  });

  it('backs off 1 s, 2 s, 4 s … capped, then stops auto-retrying', async () => {
    const h = harness();
    h.addCard('k3', 'c3');
    h.io.ensureCardIo('k3', true);
    await flush();
    const gaps: number[] = [];
    for (let i = 0; i < 10; i++) {
      const before = h.fetchCalls.length;
      const c = h.env._ioCache.c3;
      if (c.state !== 'error') break;
      const gap = c.retryAt - (h.env.Date.now() as number);
      await h.advance(gap);
      if (h.fetchCalls.length === before) break;
      gaps.push(gap);
    }
    expect(gaps).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
  });

  it('a landed turn during an outage waits for the deadline, then refetches once', async () => {
    const h = harness();
    h.addCard('k4', 'c4');
    h.io.ensureCardIo('k4', true);
    await flush();
    h.setMode('up');
    h.io.invalidateCardIo('c4');
    await flush();
    expect(h.fetchCalls).toHaveLength(1); // not before the deadline
    await h.advance(h.env._ioCache.c4.retryAt - h.now());
    expect(h.fetchCalls).toHaveLength(2);
    expect(h.env._ioCache.c4.state).toBe('ok');
  });

  /** Fail until the conversation's step reaches the 30 s cap with that timer pending. */
  async function driveToLongBackoff(h: ReturnType<typeof harness>, key: string, cid: string) {
    h.io.ensureCardIo(key, true); // fails at step 1 (1 s)
    await flush();
    while (h.env._ioCache[cid].retryAt - h.now() < 30_000) {
      await h.advance(h.env._ioCache[cid].retryAt - h.now());
    }
  }

  it('a successful reopen clears a pending long backoff; the next failure retries at the fresh 1 s deadline', async () => {
    const h = harness();
    h.addCard('kt', 'ct');
    await driveToLongBackoff(h, 'kt', 'ct');
    const stale30 = h.env._ioCache.ct.retryAt; // a 30 s timer is pending
    expect(stale30 - h.now()).toBe(30_000);
    expect(h.pendingTimers()).toEqual([30_000]);
    const failedSoFar = h.fetchCalls.length;

    h.setMode('up');
    h.io.ensureCardIo('kt', true); // explicit reopen succeeds
    await flush();
    expect(h.env._ioCache.ct.state).toBe('ok');
    expect(h.pendingTimers()).toEqual([]); // the stale 30 s timer is gone

    h.setMode('down');
    h.env._sessionCache.kt.lastActivity = '2026-10-16T05:00:00.000Z';
    h.io.ensureCardIo('kt', false); // newer stamp → fetch → fails (step 1)
    await flush();
    expect(h.fetchCalls).toHaveLength(failedSoFar + 2);
    expect(h.env._ioCache.ct.retryAt - h.now()).toBe(1000);

    h.setMode('up');
    await h.advance(1000); // the fresh deadline
    expect(h.fetchCalls).toHaveLength(failedSoFar + 3);
    expect(h.env._ioCache.ct.state).toBe('ok');
    await h.advance(stale30 + 60_000 - h.now()); // well past the old 30 s deadline
    expect(h.fetchCalls).toHaveLength(failedSoFar + 3);
  });

  it('an earlier deadline replaces a later pending timer (and the later one never fires)', async () => {
    const h = harness();
    h.addCard('ke', 'ce');
    await driveToLongBackoff(h, 'ke', 'ce');
    const later = h.env._ioCache.ce.retryAt;
    const before = h.fetchCalls.length;
    // A fresh failure cycle wants an earlier deadline (e.g. a newer stamp).
    h.env._ioCache.ce.retryAt = h.now() + 1000;
    h.io.ensureCardIo('ke', false); // render: arms the timer for the earlier deadline
    // Re-arming with a deadline later than the pending one keeps the pending one.
    // (scheduleCardIoRetry is reached through ensureCardIo; see pendingTimers.)
    expect(h.pendingTimers()).toEqual([1000]);
    await h.advance(1000);
    expect(h.fetchCalls).toHaveLength(before + 1);
    await h.advance(later + 1000 - h.now());
    // Only the timers the new failure scheduled itself may remain; none of them fetched early.
    expect(h.fetchCalls.length - before).toBeLessThanOrEqual(2);
    expect(h.fetchTimes.filter((x) => x === later)).toEqual([]);
  });

  it('a pending deadline is kept when the new one is later', async () => {
    const h = harness();
    h.addCard('kk', 'ck');
    h.io.ensureCardIo('kk', true); // fails → 1 s timer pending
    await flush();
    expect(h.pendingTimers()).toEqual([1000]);
    h.env._ioCache.ck.retryAt = h.now() + 30_000;
    h.io.ensureCardIo('kk', false); // a later deadline must not replace the earlier timer
    expect(h.pendingTimers()).toEqual([1000]);
  });

  it('closing the last open card of a conversation (or it leaving the board) clears its timer', async () => {
    const h = harness();
    h.addCard('kx', 'cx');
    h.addCard('ky', 'cx'); // a second open card on the same conversation
    h.io.ensureCardIo('kx', true);
    await flush();
    expect(h.pendingTimers()).toEqual([1000]);
    h.env._expanded.delete('kx');
    h.io.releaseCardIoTimer('cx'); // ky still shows it → kept
    expect(h.pendingTimers()).toEqual([1000]);
    h.leave('ky'); // ky left the board
    h.io.releaseCardIoTimer('cx');
    expect(h.pendingTimers()).toEqual([]);
    const n = h.fetchCalls.length;
    await h.advance(60_000);
    expect(h.fetchCalls).toHaveLength(n);
  });

  it.each<[string, (h: ReturnType<typeof harness>) => void]>([
    ['closed', (h) => h.env._expanded.delete('kd')],
    ['removed from the board', (h) => h.leave('kd')],
  ])('a request that fails after its last card was %s arms no retry timer', async (_how, goAway) => {
    const h = harness();
    h.addCard('kd', 'cd');
    const inFlight = h.hold();
    h.io.ensureCardIo('kd', true); // the opening fetch is in flight
    await flush();
    goAway(h);
    h.io.releaseCardIoTimer('cd'); // what ui-toggle (closed) / renderBoard (gone) do; nothing is pending yet
    inFlight.reject();
    await flush();
    expect(h.env._ioCache.cd.state).toBe('error');
    expect(h.pendingTimers()).toEqual([]);
    const n = h.fetchCalls.length;
    await h.advance(60_000);
    expect(h.fetchCalls).toHaveLength(n);
  });

  it('a request that fails while another open card shows the conversation still arms the timer', async () => {
    const h = harness();
    h.addCard('kd', 'cd');
    h.addCard('kd2', 'cd');
    const inFlight = h.hold();
    h.io.ensureCardIo('kd', true);
    await flush();
    h.env._expanded.delete('kd');
    h.io.releaseCardIoTimer('cd');
    inFlight.reject();
    await flush();
    expect(h.pendingTimers()).toEqual([1000]);
    await h.advance(1000); // kd2 consumes the retry
    expect(h.fetchCalls).toHaveLength(2);
  });

  it('board renders never send a request during an outage; the deadline and backoff survive stamp changes', async () => {
    const h = harness();
    h.addCard('ko', 'co');
    let stampN = 0;
    const newStampAndRender = async () => {
      stampN++;
      h.env._sessionCache.ko.lastActivity = new Date(Date.UTC(2026, 9, 16, 1, 0, stampN)).toISOString();
      h.io.ensureCardIo('ko', false); // renderBoard on a board push
      await flush();
    };
    h.io.ensureCardIo('ko', true); // opening fetch fails at t0
    await flush();
    const t0 = h.now();
    expect(h.fetchCalls).toHaveLength(1);

    for (const deadline of [1000, 2000, 4000]) {
      const c = h.env._ioCache.co;
      const at = c.retryAt;
      expect(at - h.now()).toBe(deadline); // the step grows; a new stamp never resets it
      const before = h.fetchCalls.length;
      // Several new stamps + renders before the deadline: nothing goes out.
      for (let i = 0; i < 4; i++) {
        await h.advance(Math.floor(deadline / 5));
        await newStampAndRender();
        expect(h.fetchCalls).toHaveLength(before);
      }
      if (deadline === 4000) h.setMode('up'); // the endpoint recovers before the third deadline
      await h.advance(at - h.now()); // the deadline: exactly one request
      expect(h.fetchCalls).toHaveLength(before + 1);
    }
    expect(h.fetchTimes.map((x) => x - t0)).toEqual([0, 1000, 3000, 7000]);
    expect(h.env._ioCache.co.state).toBe('ok');
    expect(h.env._ioCache.co.step).toBe(0);
  });

  it('freshness rule: loading waits, ok is fresh only for its stamp, error only on reopen or the deadline timer', () => {
    const { ioNeedsFetch } = harness().io;
    const err = { state: 'error', stamp: 's', retryAt: 100 };
    expect(ioNeedsFetch(undefined, 's', false, 0)).toBe(true);
    expect(ioNeedsFetch({ state: 'loading', stamp: 's' }, 's', true, 0)).toBe(false);
    expect(ioNeedsFetch({ state: 'ok', stamp: 's' }, 's', true, 0)).toBe(false);
    expect(ioNeedsFetch({ state: 'ok', stamp: 's' }, 't', false, 0)).toBe(true);
    // Renders (no timer) never send during an error — not even for a newer stamp.
    expect(ioNeedsFetch(err, 's', false, 1e9)).toBe(false);
    expect(ioNeedsFetch(err, 't', false, 1e9)).toBe(false);
    // The deadline timer: only once the deadline passed.
    expect(ioNeedsFetch(err, 't', false, 50, true)).toBe(false);
    expect(ioNeedsFetch(err, 's', false, 100, true)).toBe(true);
    // Budget per stamp: exhausted for 's', fresh for a newer stamp.
    expect(ioNeedsFetch({ ...err, fails: 7 }, 's', false, 1e9, true)).toBe(false);
    expect(ioNeedsFetch({ ...err, fails: 7 }, 't', false, 1e9, true)).toBe(true);
    // Reopen always.
    expect(ioNeedsFetch({ ...err, fails: 7 }, 's', true, 0)).toBe(true);
  });
});

/** Decode the five entities esc()/escAttr() emit — what an HTML parser hands to dataset. */
const decodeAttr = (v: string) =>
  v
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
const HOSTILE = [
  '1"><img src=x onerror=alert(1)>',
  `" onmouseover="alert(1)" x="`,
  "it's \\ a <b>test</b>\nsecond line",
  '&quot; already-encoded &amp;',
];

/** The board's card mapper (cardOf → <ui-agent-inbox> card data) and what it reads, as shipped. */
const CARD_OF_FNS = [
  'toNum',
  'formatTokens',
  'formatTaskTime',
  'permissionSummary',
  'cardSummary',
  'pendingAutoResume',
  'autoResumeLabel',
  'cardCurrentTask',
  'cardTaskRow',
  'agentStatusOf',
  'agentCounts',
  'agentDotOf',
  'cardTotalTokens',
  'ctxLevel',
  'ctxPercent',
  'cardCtxTitle',
  'cardPrMetric',
  '_hashStr',
  'ownerBadgeHue',
  'isSiblingSession',
  'cardOf',
];
const CARD_OF_VARS = ['PR_STATE_LABEL', 'PR_STATE_TONE', 'AGENT_STATUS_LABEL', 'OWNER_BADGE_HUES'];
type CardData = Record<string, unknown> & {
  badge?: { text: string; hue: number; title: string };
  since?: number;
  elapsedMs?: number;
};

describe('model-controlled values in card markup (shipped renderers)', () => {
  const cards = load<{
    renderTimeline(s: unknown): string;
    cardOf(s: unknown, col: string): CardData;
  }>(
    [
      'esc',
      'escAttr',
      'escJs',
      'formatDuration',
      // Task view T2: the meta and the 전체 task count read each task's fate.
      'taskFateOf',
      'renderTaskMeta',
      'renderTimelineItem',
      'renderTimeline',
      ...CARD_OF_FNS,
    ],
    ['TASK_FATE_LABEL', ...CARD_OF_VARS],
    {
      dhShow: () => true,
      dhTruncate: () => null,
      dhMax: (_f: string, d: number) => d,
      currentUserId: 'U1',
      _ownerIndex: null,
      SELF_INSTANCE_NAME: '',
    },
  );
  const tags = (html: string) => (html.match(/<([a-z0-9]+)/gi) ?? []).map((t) => t.slice(1).toLowerCase());

  it('a string startedAt / completedAt cannot open a tag or an attribute in the task timeline', () => {
    for (const bad of HOSTILE) {
      const html = cards.renderTimeline({
        tasks: [
          { content: 'running', status: 'in_progress', startedAt: bad },
          { content: 'done', status: 'completed', startedAt: bad, completedAt: bad },
        ],
      });
      expect(
        tags(html).every((t) => ['div', 'ul', 'li', 'span'].includes(t)),
        html,
      ).toBe(true);
      expect(html).not.toMatch(/onerror|onmouseover/);
      for (const m of html.matchAll(/data-since="([^"]*)"/g)) expect(m[1]).toMatch(/^\d+$/);
    }
  });

  it('the status clock takes plain numbers only — a hostile stamp never reaches the card (the element writes text)', () => {
    for (const bad of HOSTILE) {
      for (const col of ['working', 'waiting', 'idle', 'closed']) {
        const card = cards.cardOf(
          { key: 'k', activeLegStartedAtMs: bad, activeAccumulatedMs: bad, waitingSince: bad, finishedAt: bad },
          col,
        );
        for (const v of [card.since, card.elapsedMs])
          expect(v === undefined || Number.isFinite(v), String(v)).toBe(true);
      }
    }
  });
});

describe('pending-question choices carry their values in data attributes (shipped choiceDataAttrs)', () => {
  const { choiceDataAttrs } = load<{ choiceDataAttrs(key: string, id: string, label: string, q: string): string }>(
    ['esc', 'escAttr', 'choiceDataAttrs'],
    [],
  );

  it('any key / id / label / question round-trips exactly and injects nothing', () => {
    for (const v of HOSTILE) {
      const attrs = choiceDataAttrs(`C1:t1'\\${v}`, `id-${v}`, `label ${v}`, `Q ${v}?`);
      // Only the four data attributes, each a plain double-quoted value.
      const parsed = [...attrs.matchAll(/\s(data-[a-z-]+)="([^"]*)"/g)];
      expect(attrs.replace(/\s(data-[a-z-]+)="[^"]*"/g, '')).toBe('');
      expect(parsed.map((m) => m[1])).toEqual([
        'data-choice-key',
        'data-choice-id',
        'data-choice-label',
        'data-choice-question',
      ]);
      expect(parsed.map((m) => decodeAttr(m[2]))).toEqual([`C1:t1'\\${v}`, `id-${v}`, `label ${v}`, `Q ${v}?`]);
      expect(attrs).not.toMatch(/[<>]/);
    }
  });

  it('no answerChoice / selectMc call is built as an inline JS string any more', () => {
    expect(TEMPLATE).not.toMatch(/answerChoice\(\\\\'/);
    expect(TEMPLATE).not.toMatch(/selectMc\(\\\\'/);
  });
});

describe('numbers in panel / topbar markup (shipped toNum + formatTokens)', () => {
  const { toNum, formatTokens } = load<{ toNum(v: unknown): number; formatTokens(v: unknown): string }>(
    ['toNum', 'formatTokens'],
    [],
  );
  it('a hostile string becomes a number before it reaches markup, and .toFixed never throws', () => {
    for (const bad of ['<img src=x onerror=alert(1)>', '"x', 'NaN', {}, null, undefined, Number.POSITIVE_INFINITY]) {
      expect(toNum(bad)).toBe(0);
      expect(formatTokens(bad)).toBe('0');
      expect(() => toNum(bad).toFixed(3)).not.toThrow();
    }
    expect(toNum('1500')).toBe(1500);
    expect(formatTokens('1500')).toBe('1.5K');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });
  it('absurd magnitudes stay compact: B and T units, a cap from 1000T, no exponent, no negative', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(999.6)).toBe('1.0K'); // rounds into the next unit, never "1000"
    expect(formatTokens(999_950)).toBe('1.0M'); // never "1000.0K"
    expect(formatTokens(3_100_000_000)).toBe('3.1B');
    expect(formatTokens(4.2e12)).toBe('4.2T');
    expect(formatTokens(999.9e12)).toBe('999.9T');
    for (const huge of [1e15, 1e300, Number.MAX_VALUE]) expect(formatTokens(huge)).toBe('999.9T+');
    for (const odd of [-5, -1e300, 1e-300]) expect(formatTokens(odd)).toBe('0');
    for (const v of [1, 1e3, 1e6, 1e9, 1e12, 1e15, 1e100, 1e300]) {
      const out = formatTokens(v);
      expect(out).not.toMatch(/e[+-]?\d/);
      expect(out.length).toBeLessThanOrEqual(7);
    }
  });
});

describe('top-bar user names keep their full text in title (shipped syncUserSelectLabel + _applyUserPill)', () => {
  const LONG = '가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라';
  /** Just enough DOM for the two functions: a select with options, the label, the pill. */
  function dom() {
    const options = [
      { value: '', textContent: 'All Users' },
      { value: 'U002', textContent: LONG },
    ];
    const select = { options, selectedIndex: 0, title: 'All Users', value: '' };
    const label = { textContent: 'All Users' };
    const nameEl = { textContent: '…', title: '' };
    const classes = new Set<string>();
    const attrs: Record<string, string> = {};
    const pill = {
      style: { display: 'none' },
      classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) },
      setAttribute: (k: string, v: string) => {
        attrs[k] = v;
      },
    };
    const byId: Record<string, unknown> = {
      'user-select': select,
      'user-select-label': label,
      'user-pill': pill,
      'user-pill-name': nameEl,
    };
    const document = { getElementById: (id: string) => byId[id] ?? null };
    return { document, select, label, nameEl };
  }

  it('the label over the select shows the selected option; the select title carries it in full', () => {
    const d = dom();
    const { syncUserSelectLabel } = load<{ syncUserSelectLabel(): void }>(['syncUserSelectLabel'], [], {
      document: d.document,
    });
    d.select.selectedIndex = 1;
    syncUserSelectLabel();
    expect(d.label.textContent).toBe(LONG);
    expect(d.select.title).toBe(LONG);
    d.select.selectedIndex = 0;
    syncUserSelectLabel();
    expect(d.label.textContent).toBe('All Users');
    expect(d.select.title).toBe('All Users');
  });

  it('selectUser and loadUsers keep the label in sync', () => {
    expect(clientFn('selectUser')).toMatch(/^function selectUser\(userId\) \{\n {2}syncUserSelectLabel\(\);/);
    expect(clientFn('loadUsers')).toMatch(/\n {2}syncUserSelectLabel\(\);\n\}$/);
  });

  it('the pill name carries the full name in title (it may end in an ellipsis)', () => {
    const d = dom();
    const { _applyUserPill } = load<{ _applyUserPill(data: unknown): void }>(['_applyUserPill'], [], {
      document: d.document,
    });
    _applyUserPill({ user: { name: LONG } });
    expect(d.nameEl.textContent).toBe(LONG);
    expect(d.nameEl.title).toBe(LONG);
  });
});

describe('panel subtitle generation is bound to its panel opening (shipped generateTitleSub)', () => {
  function harness() {
    const textEl = { textContent: '' };
    const btn = { style: { display: 'none' } };
    const held = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
    const posts: string[] = [];
    const answers: Record<string, () => unknown> = {};
    const fetchStub = (url: string) => {
      posts.push(url);
      const conv = decodeURIComponent(url.split('/')[4] ?? '');
      if (answers[conv]) return Promise.resolve(answers[conv]());
      return new Promise((resolve, reject) => held.set(conv, { resolve, reject }));
    };
    let csrfRefreshes = 0;
    const io = load<{
      generateTitleSub(convId: string, regenerate?: boolean): Promise<void>;
      switchPanel(): void;
    }>(
      [
        'titleSubCanRegen',
        'panelTitleSubCanRegen',
        'titleSubEndpoint',
        'isCsrfRejection',
        'titleSubView',
        'generateTitleSub',
      ],
      ['_panelGen'],
      {
        document: { getElementById: (id: string) => (id === 'panel-title-sub-text' ? textEl : btn) },
        fetch: fetchStub,
        _csrfToken: 't',
        refreshCsrfToken: async () => {
          csrfRefreshes++;
        },
        // The viewer owns the open panel, so 🔄 is offered over a filled subtitle.
        _panelTitleSub: '',
        panelSessionKey: 'C1:t1',
        _sessionCache: { 'C1:t1': { ownerId: 'U1' } },
        _viewerUserId: 'U1',
        _viewerIsAdmin: false,
        _isAdminModeOn: () => false,
        READ_ONLY_MSG: '읽기 전용 — 내 세션이 아닙니다',
      },
      // What openPanel / closePanel do to the panel identity (dashboard.ts: _panelGen++).
      ['function switchPanel() { _panelGen++; }'],
    );
    const ok = (titleSub: string) => ({ status: 200, json: async () => ({ titleSub }) });
    return { io, textEl, btn, held, posts, answers, ok, csrfRefreshes: () => csrfRefreshes };
  }

  it("A's late response does not overwrite B's subtitle", async () => {
    const h = harness();
    const a = h.io.generateTitleSub('conv-a'); // panel A: its title request is held
    await flush();
    expect(h.textEl.textContent).toBe('Generating title...');
    h.io.switchPanel(); // open panel B
    h.answers['conv-b'] = () => h.ok('B subtitle');
    await h.io.generateTitleSub('conv-b');
    expect(h.textEl.textContent).toBe('B subtitle');
    expect(h.btn.style.display).toBe('inline-block');
    h.btn.style.display = 'marker';
    h.held.get('conv-a')?.resolve(h.ok('A subtitle')); // A lands late
    await a;
    expect(h.textEl.textContent).toBe('B subtitle');
    expect(h.btn.style.display).toBe('marker');
  });

  it("A's late failure does not write 'Error' into B's subtitle", async () => {
    const h = harness();
    const a = h.io.generateTitleSub('conv-a');
    await flush();
    h.io.switchPanel();
    h.answers['conv-b'] = () => h.ok('B subtitle');
    await h.io.generateTitleSub('conv-b');
    h.held.get('conv-a')?.reject(new Error('network down'));
    await a;
    expect(h.textEl.textContent).toBe('B subtitle');
  });

  it('a 403 for a panel that is gone is not retried', async () => {
    const h = harness();
    h.answers['conv-a'] = () => ({ status: 403, json: async () => ({}) });
    const a = h.io.generateTitleSub('conv-a');
    h.io.switchPanel(); // the panel changes before the 403 lands
    await a;
    expect(h.posts).toHaveLength(1);
    expect(h.textEl.textContent).toBe('Generating title...');
  });

  it('the current panel still gets its subtitle (and its stale-CSRF retry)', async () => {
    const h = harness();
    let n = 0;
    const stale = { status: 403, json: async () => ({ error: 'CSRF token validation failed', code: 'csrf_failed' }) };
    h.answers['conv-a'] = () => (++n === 1 ? stale : h.ok('A subtitle'));
    await h.io.generateTitleSub('conv-a');
    expect(h.posts).toHaveLength(2);
    expect(h.csrfRefreshes()).toBe(1);
    expect(h.textEl.textContent).toBe('A subtitle');
  });

  it('a permission 403 is not retried and is not shown as "Title generation failed"', async () => {
    const h = harness();
    h.answers['conv-a'] = () => ({ status: 403, json: async () => ({ error: 'Forbidden — write requires …' }) });
    await h.io.generateTitleSub('conv-a');
    expect(h.posts).toHaveLength(1);
    expect(h.csrfRefreshes()).toBe(0);
    expect(h.textEl.textContent).not.toBe('Title generation failed');
    expect(h.btn.style.display).toBe('none');
  });

  it('a missing subtitle is filled through ensure-title; 🔄 over a stored one regenerates', async () => {
    const h = harness();
    h.answers['conv-a'] = () => h.ok('A subtitle');
    await h.io.generateTitleSub('conv-a', false);
    await h.io.generateTitleSub('conv-a', true);
    expect(h.posts).toEqual([
      '/api/dashboard/session/conv-a/ensure-title',
      '/api/dashboard/session/conv-a/generate-title',
    ]);
  });
});

describe('escaping order and inline-handler escaping in the template', () => {
  it('text is sliced before it is escaped (an entity is never cut in half)', () => {
    expect(TEMPLATE).not.toMatch(/esc\([^()]*\)\.slice\(/);
  });
  it('the resummarize handler escapes its single-quoted JS arguments with escJs', () => {
    expect(TEMPLATE).toContain(
      "resummarize(\\\\'' + escJs(convId || panelConvId) + '\\\\',\\\\'' + escJs(t.id) + '\\\\',this)",
    );
  });
});

describe('links are http(s) only (shipped safeHref)', () => {
  const { safeHref } = load<{ safeHref(u: unknown): string }>(['esc', 'escAttr', 'safeHref'], []);
  it('keeps http(s) URLs (escaped) and turns anything else into #', () => {
    expect(safeHref('https://github.com/o/r/pull/1?a=1&b="2"')).toBe(
      'https://github.com/o/r/pull/1?a=1&amp;b=&quot;2&quot;',
    );
    expect(safeHref('HTTP://example.com')).toBe('HTTP://example.com');
    for (const bad of [
      'javascript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,x',
      '//evil',
      '',
      null,
      undefined,
    ]) {
      expect(safeHref(bad), String(bad)).toBe('#');
    }
  });
});

describe('WS session_update keeps sibling-instance cards (shipped mergeSiblingCards)', () => {
  type Card = { key: string; environment?: { instanceName: string } };
  const self = (key: string): Card => ({ key: `self::${key}`, environment: { instanceName: 'self' } });
  const sib = (key: string): Card => ({ key: `oud::${key}`, environment: { instanceName: 'oud' } });
  function merge(ws: Record<string, Card[]>, polled: Record<string, Card[]> | null) {
    const m = load<{ mergeSiblingCards(b: Record<string, Card[]>): Record<string, Card[]> }>(
      ['isSiblingSession', 'mergeSiblingCards'],
      [],
      { SELF_INSTANCE_NAME: 'self', _lastPolledBoard: polled },
    );
    return m.mergeSiblingCards(ws);
  }

  it('appends the last polled sibling cards after this instance’s cards, like the poll does', () => {
    const polled = { working: [self('a'), sib('x')], waiting: [sib('y')], idle: [self('b')], closed: [] };
    const out = merge({ working: [self('a'), self('c')], waiting: [], idle: [self('b')], closed: [] }, polled);
    expect(out.working.map((c) => c.key)).toEqual(['self::a', 'self::c', 'oud::x']);
    expect(out.waiting.map((c) => c.key)).toEqual(['oud::y']);
    expect(out.idle.map((c) => c.key)).toEqual(['self::b']);
  });

  it('is a no-op before the first poll, and never duplicates a key', () => {
    const ws = { working: [self('a')], waiting: [], idle: [], closed: [] };
    expect(merge(ws, null)).toEqual(ws);
    const out = merge(
      { working: [sib('x')], waiting: [], idle: [], closed: [] },
      { working: [sib('x')], waiting: [], idle: [], closed: [] },
    );
    expect(out.working.map((c) => c.key)).toEqual(['oud::x']);
  });
});

type DoneCard = { key: string; lastActivity: string; terminated?: boolean };
type DonePlan = {
  done: Array<{ s: DoneCard; col: string }>;
  archivedCount: number;
};

type RawResult = { status: string; raw?: string; bytes?: number; truncated?: boolean };
type RawState = { convId: string; closed: boolean; raw?: Record<number, Promise<RawResult>> };
const httpErr = (status: number, code: string | null = null) =>
  Object.assign(new Error(`HTTP ${status}`), { status, code });

describe('work-log raw output: fetched once per entry, failures retryable (shipped wlRawUrl + wlRawLoad)', () => {
  const core = load<{
    wlRawUrl(convId: string, seq: number): string;
    wlRawLoad(state: RawState, seq: number, fetchJson: (url: string) => Promise<unknown>): Promise<RawResult>;
  }>(['wlUrl', 'toNum', 'wlRawUrl', 'wlRawLoad'], []);

  it('asks /worklog/:seq/raw of the conversation', () => {
    expect(core.wlRawUrl('conv a/b', 12)).toBe('/api/dashboard/session/conv%20a%2Fb/worklog/12/raw');
  });

  it('caches a 200 per (state, seq): a second open does not fetch', async () => {
    const calls: string[] = [];
    const fetchJson = async (url: string) => {
      calls.push(url);
      return { seq: 3, raw: 'line 1\nline 2', rawBytes: 13, rawTruncated: false };
    };
    const st: RawState = { convId: 'c1', closed: false };
    const a = await core.wlRawLoad(st, 3, fetchJson);
    const b = await core.wlRawLoad(st, 3, fetchJson);
    expect(a).toEqual({ status: 'ok', raw: 'line 1\nline 2', bytes: 13, truncated: false });
    expect(b).toEqual(a);
    expect(calls).toEqual(['/api/dashboard/session/c1/worklog/3/raw']);
    // A new panel state (resetWorkLog) has no cache: the next conversation fetches its own.
    await core.wlRawLoad({ convId: 'c1', closed: false }, 3, fetchJson);
    expect(calls.length).toBe(2);
  });

  it('404 / 403 / the server’s 503 {error:"unavailable"} settle for good; every other failure is retried', async () => {
    const answer = new Map<number, unknown>([
      [4, httpErr(404, 'not_found')],
      [5, httpErr(403, 'forbidden')],
      [6, new TypeError('Failed to fetch')],
      [7, httpErr(503, 'unavailable')], // the damaged-log answer
      [8, httpErr(500)],
      [9, httpErr(503)], // a proxy during a restart: no server code
      [10, httpErr(502, 'bad gateway')],
    ]);
    const calls: number[] = [];
    const fetchJson = async (url: string) => {
      const seq = Number(url.split('/').slice(-2)[0]);
      calls.push(seq);
      const a = answer.get(seq);
      if (a instanceof Error) throw a;
      return { seq, raw: 'recovered', rawBytes: 9 };
    };
    const st: RawState = { convId: 'c1', closed: false };
    expect((await core.wlRawLoad(st, 4, fetchJson)).status).toBe('missing');
    expect((await core.wlRawLoad(st, 5, fetchJson)).status).toBe('denied');
    expect((await core.wlRawLoad(st, 6, fetchJson)).status).toBe('error'); // network: 다시 시도
    expect((await core.wlRawLoad(st, 7, fetchJson)).status).toBe('damaged'); // same answer until repaired
    expect((await core.wlRawLoad(st, 8, fetchJson)).status).toBe('error');
    expect((await core.wlRawLoad(st, 9, fetchJson)).status).toBe('error');
    expect((await core.wlRawLoad(st, 10, fetchJson)).status).toBe('error');
    await core.wlRawLoad(st, 4, fetchJson);
    await core.wlRawLoad(st, 5, fetchJson);
    await core.wlRawLoad(st, 7, fetchJson);
    for (const n of [6, 8, 9, 10]) answer.delete(n); // back up
    for (const n of [6, 8, 9, 10]) {
      expect(await core.wlRawLoad(st, n, fetchJson)).toEqual({
        status: 'ok',
        raw: 'recovered',
        bytes: 9,
        truncated: false,
      });
    }
    expect(calls).toEqual([4, 5, 6, 7, 8, 9, 10, 6, 8, 9, 10]);
  });
});

describe('work-log raw detail markup (shipped renderWorkLogDetail + formatBytes)', () => {
  const { renderWorkLogDetail, formatBytes } = load<{
    renderWorkLogDetail(r: RawResult): string;
    formatBytes(n: unknown): string;
  }>(
    ['esc', 'toNum', 'formatBytes', 'renderWorkLogDetail'],
    ['WL_FORBIDDEN_MSG', 'WL_RAW_MISSING_MSG', 'WL_RAW_ERROR_MSG', 'WL_RAW_DAMAGED_MSG'],
  );

  it('formats byte counts in B / KiB / MiB / GiB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(1048576)).toBe('1.0 MiB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GiB');
    expect(formatBytes('<b>')).toBe('0 B');
  });

  it('the full output in an escaped <pre>, with a copy button', () => {
    const html = renderWorkLogDetail({ status: 'ok', raw: '{\n  "a": "<script>"\n}', bytes: 22, truncated: false });
    expect(html).toBe(
      '<div class="wl-detail-bar"><button type="button" class="wl-detail-btn" data-wl-act="copy">복사</button></div>' +
        '<pre class="wl-raw">{\n  &quot;a&quot;: &quot;&lt;script&gt;&quot;\n}</pre>',
    );
  });

  it('a truncated output says how much is shown and the original size', () => {
    const html = renderWorkLogDetail({ status: 'ok', raw: 'x', bytes: 3 * 1048576, truncated: true });
    expect(html.startsWith('<div class="wl-detail-note">저장된 앞 256 KiB만 표시 — 원본 3.0 MiB</div>')).toBe(true);
  });

  it('loading, 404, 403 and retryable failures each have their line', () => {
    expect(renderWorkLogDetail({ status: 'loading' })).toContain('불러오는 중');
    expect(renderWorkLogDetail({ status: 'missing' })).toBe(
      '<div class="wl-detail-msg">원본 출력이 저장되어 있지 않습니다</div>',
    );
    expect(renderWorkLogDetail({ status: 'denied' })).toBe(
      '<div class="wl-detail-msg">작업 로그는 세션 소유자만 볼 수 있어요</div>',
    );
    const err = renderWorkLogDetail({ status: 'error' });
    expect(err).toContain('원본 출력을 불러오지 못했어요');
    expect(err).toContain('<button type="button" class="wl-detail-btn" data-wl-act="retry">다시 시도</button>');
    expect(err).not.toContain('<pre');
    // 503: the log is damaged and the answer stays the same until repair — no retry.
    expect(renderWorkLogDetail({ status: 'damaged' })).toBe(
      '<div class="wl-detail-msg">로그가 손상되어 원본을 읽을 수 없습니다</div>',
    );
  });
});

describe('work-log fetch errors carry the server code (shipped wlFetchJson)', () => {
  const run = async (res: { ok: boolean; status: number; json(): Promise<unknown> }) => {
    const { wlFetchJson } = load<{ wlFetchJson(url: string): Promise<unknown> }>(['wlFetchJson'], [], {
      fetch: async () => res,
    });
    return wlFetchJson('/x').then(
      (v) => ({ ok: v }),
      (e: { status?: number; code?: unknown }) => ({ status: e.status, code: e.code }),
    );
  };

  it('a JSON error body puts its error string on the error; anything else leaves the code null', async () => {
    expect(await run({ ok: false, status: 503, json: async () => ({ error: 'unavailable' }) })).toEqual({
      status: 503,
      code: 'unavailable',
    });
    expect(
      await run({
        ok: false,
        status: 503,
        json: async () => {
          throw new SyntaxError('Unexpected token <'); // an HTML page from a proxy
        },
      }),
    ).toEqual({ status: 503, code: null });
    expect(await run({ ok: false, status: 500, json: async () => ({ error: 42 }) })).toEqual({
      status: 500,
      code: null,
    });
    expect(await run({ ok: true, status: 200, json: async () => ({ entries: [] }) })).toEqual({ ok: { entries: [] } });
  });
});

/** Minimal DOM fakes for the panel work-log functions (no DOM library in this repo's tests). */
type FakeEl = {
  id?: string;
  hidden: boolean;
  innerHTML: string;
  textContent: string;
  attrs: Record<string, string>;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  style: Record<string, string>;
  children: unknown[];
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  querySelector(sel: string): FakeEl | null;
  querySelectorAll(sel: string): FakeEl[];
  insertBefore(node: unknown, ref: unknown): void;
};
function fakeEl(over: Partial<FakeEl> = {}): FakeEl {
  const el: FakeEl = {
    hidden: false,
    innerHTML: '',
    textContent: '',
    attrs: {},
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    style: {},
    children: [],
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    removeAttribute(k) {
      delete this.attrs[k];
    },
    getAttribute(k) {
      return k in this.attrs ? this.attrs[k] : null;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    insertBefore(node) {
      this.children.push(node);
    },
    ...over,
  };
  return el;
}

describe('work-log entries open their raw output in place (shipped toggleWorkLogEntry and friends)', () => {
  type Entry = { seq: number; kind: string; text: string; rawBytes?: number; tool?: string };
  function page(entries: Entry[], fetchImpl: (url: string) => Promise<unknown>) {
    const rows: Record<number, { row: FakeEl; detail: FakeEl }> = {};
    for (const e of entries) rows[e.seq] = { row: fakeEl(), detail: fakeEl({ hidden: true }) };
    const list = fakeEl({
      querySelector: (sel: string) => {
        const seq = Number(/data-seq="(\d+)"/.exec(sel)?.[1]);
        const r = rows[seq];
        if (!r) return null;
        return fakeEl({
          querySelector: (inner: string) => (inner === '.wl-row' ? r.row : inner === '.wl-detail' ? r.detail : null),
        });
      },
    });
    const document = { getElementById: (id: string) => (id === 'worklog-list' ? list : null) };
    const calls: string[] = [];
    const wlFetchJson = (url: string) => {
      calls.push(url);
      return fetchImpl(url);
    };
    const st = { convId: 'c1', closed: false, entries, seen: new Set(entries.map((e) => e.seq)) };
    const m = load<{
      toggleWorkLogEntry(seq: number): void;
      retryWorkLogDetail(seq: number): void;
      setWl(s: unknown): void;
    }>(
      [
        'esc',
        'toNum',
        'decodeSlackEntities',
        'wlUrl',
        'wlRawUrl',
        'wlRawLoad',
        'formatBytes',
        'renderWorkLogDetail',
        'wlEntryEl',
        'wlEntryBySeq',
        'wlFullText',
        'escAttr',
        ...WL_INSTRUCTION_FNS.filter((f) => f !== 'toNum'),
        'paintWorkLogDetail',
        'loadWorkLogDetail',
        'toggleWorkLogEntry',
        'retryWorkLogDetail',
      ],
      ['WL_FORBIDDEN_MSG', 'WL_RAW_MISSING_MSG', 'WL_RAW_ERROR_MSG', 'WL_RAW_DAMAGED_MSG', ...WL_INSTRUCTION_VARS],
      { document, wlFetchJson, _wl: st },
      ['function setWl(s) { _wl = s; }'],
    );
    return { m, rows, calls, st };
  }
  const RAW = { seq: 3, raw: '{\n  "file_path": "db/schema.sql"\n}', rawBytes: 34, rawTruncated: false };

  it('with rawBytes: loading, then the fetched raw; collapse and reopen without a second fetch', async () => {
    const p = page([{ seq: 3, kind: 'tool', tool: 'Read', text: 'Read {...}', rawBytes: 34 }], async () => RAW);
    p.m.toggleWorkLogEntry(3);
    expect(p.rows[3].row.attrs['aria-expanded']).toBe('true');
    expect(p.rows[3].detail.hidden).toBe(false);
    expect(p.rows[3].detail.innerHTML).toContain('불러오는 중');
    await flush();
    expect(p.rows[3].detail.innerHTML).toContain(
      '<pre class="wl-raw">{\n  &quot;file_path&quot;: &quot;db/schema.sql&quot;\n}</pre>',
    );
    p.m.toggleWorkLogEntry(3);
    expect(p.rows[3].row.attrs['aria-expanded']).toBe('false');
    expect(p.rows[3].detail).toMatchObject({ hidden: true, innerHTML: '' });
    p.m.toggleWorkLogEntry(3);
    await flush();
    expect(p.rows[3].detail.innerHTML).toContain('<pre class="wl-raw">');
    expect(p.calls).toEqual(['/api/dashboard/session/c1/worklog/3/raw']);
  });

  it('without rawBytes: the entry’s own full text, no fetch (narration, older entries)', () => {
    const long = `Reading the current schema ${'and the migration history '.repeat(20)}first.`;
    const p = page([{ seq: 2, kind: 'narration', text: long }], async () => RAW);
    p.m.toggleWorkLogEntry(2);
    expect(p.rows[2].detail.innerHTML).toContain(`<pre class="wl-raw">${long}</pre>`);
    expect(p.calls).toEqual([]);
  });

  it('a late answer for a collapsed row, or for another conversation, is dropped', async () => {
    let release: (v: unknown) => void = () => {};
    const held = () =>
      new Promise((r) => {
        release = r;
      });
    const p = page([{ seq: 3, kind: 'tool', text: 'x', rawBytes: 34 }], held);
    p.m.toggleWorkLogEntry(3); // open, request in flight
    p.m.toggleWorkLogEntry(3); // collapsed again
    release(RAW);
    await flush();
    expect(p.rows[3].detail).toMatchObject({ hidden: true, innerHTML: '' });

    const q = page([{ seq: 3, kind: 'tool', text: 'x', rawBytes: 34 }], held);
    q.m.toggleWorkLogEntry(3);
    q.st.closed = true; // the panel moved to another conversation (resetWorkLog)
    q.m.setWl({ convId: 'c2', closed: false, entries: [], open: new Set([3]) });
    release(RAW);
    await flush();
    expect(q.rows[3].detail.innerHTML).toContain('불러오는 중');
    expect(q.rows[3].detail.innerHTML).not.toContain('<pre');
  });

  it('the server’s 503 {error:"unavailable"} says the log is damaged, with no 다시 시도', async () => {
    const p = page([{ seq: 12, kind: 'tool_result', text: 'exit 0', rawBytes: 40 }], async () => {
      throw httpErr(503, 'unavailable');
    });
    p.m.toggleWorkLogEntry(12);
    await flush();
    expect(p.rows[12].detail.innerHTML).toContain('로그가 손상되어 원본을 읽을 수 없습니다');
    expect(p.rows[12].detail.innerHTML).not.toContain('data-wl-act="retry"');
  });

  it('a 503 without that code (a proxy) and a 500 are generic failures with 다시 시도', async () => {
    for (const err of [httpErr(503), httpErr(500)]) {
      const p = page([{ seq: 12, kind: 'tool_result', text: 'exit 0', rawBytes: 40 }], async () => {
        throw err;
      });
      p.m.toggleWorkLogEntry(12);
      await flush();
      expect(p.rows[12].detail.innerHTML).toContain('원본 출력을 불러오지 못했어요');
      expect(p.rows[12].detail.innerHTML).toContain('data-wl-act="retry"');
    }
  });

  it('a network failure shows 다시 시도; the retry refetches and paints the raw', async () => {
    let n = 0;
    const p = page([{ seq: 12, kind: 'tool_result', text: 'exit 0', rawBytes: 40 }], async () => {
      n++;
      if (n === 1) throw new TypeError('Failed to fetch');
      return { seq: 12, raw: 'exit 0 (41s)', rawBytes: 12 };
    });
    p.m.toggleWorkLogEntry(12);
    await flush();
    expect(p.rows[12].detail.innerHTML).toContain('data-wl-act="retry"');
    p.m.retryWorkLogDetail(12);
    expect(p.rows[12].detail.innerHTML).toContain('불러오는 중');
    await flush();
    expect(p.rows[12].detail.innerHTML).toContain('<pre class="wl-raw">exit 0 (41s)</pre>');
    expect(p.calls.length).toBe(2);
  });
});

describe('work-log rows: one tab stop, arrows move it (shipped wlRovingIndex)', () => {
  const { wlRovingIndex } = load<{ wlRovingIndex(key: string, i: number, n: number): number }>(['wlRovingIndex'], []);

  it('ArrowDown / ArrowUp step and stop at the ends; Home / End jump; other keys do nothing', () => {
    expect(wlRovingIndex('ArrowDown', 0, 5)).toBe(1);
    expect(wlRovingIndex('ArrowDown', 4, 5)).toBe(4);
    expect(wlRovingIndex('ArrowUp', 3, 5)).toBe(2);
    expect(wlRovingIndex('ArrowUp', 0, 5)).toBe(0);
    expect(wlRovingIndex('Home', 3, 5)).toBe(0);
    expect(wlRovingIndex('End', 1, 5)).toBe(4);
    expect(wlRovingIndex('Tab', 1, 5)).toBe(-1);
    expect(wlRovingIndex('a', 1, 5)).toBe(-1);
    expect(wlRovingIndex('ArrowDown', 0, 0)).toBe(-1);
  });
});

describe('작업 로그 is a section tab: painted only while shown, following the newest or counting on the pill (shipped paintWorkLog; SSOT 2026-10-29)', () => {
  function page(state: Record<string, unknown>, shown = 'log') {
    // The section box scrolls; each row appended grows it by 50px.
    const box = fakeEl({ scrollHeight: 900, clientHeight: 300, scrollTop: 600 }) as FakeEl & Record<string, unknown>;
    box._lastTop = 600;
    const list = fakeEl();
    (list as unknown as { appendChild(n: unknown): void }).appendChild = (n: unknown) => {
      list.children.push(n);
      box.scrollHeight += 50;
    };
    const pill = fakeEl({ hidden: true });
    const document = {
      getElementById: (id: string) => ({ 'psec-log': box, 'worklog-list': list, 'psec-pill': pill })[id] ?? null,
      createElement: () => {
        const tmp: Record<string, unknown> = {};
        Object.defineProperty(tmp, 'innerHTML', {
          set(v: string) {
            tmp.firstElementChild = { html: v };
          },
        });
        return tmp;
      },
    };
    const m = load<{ paintWorkLog(s: unknown, added: unknown[]): void }>(
      [
        'esc',
        'escAttr',
        'toNum',
        'formatDuration',
        'decodeSlackEntities',
        'setTextIfChanged',
        'renderTaskMeta',
        'wlToolSummary',
        ...WL_INSTRUCTION_FNS.filter((f) => f !== 'toNum'),
        'renderWorkLogEntry',
        'wlGroupOf',
        'wlBuildRows',
        'wlTaskInfo',
        'renderWorkLogGroupHead',
        'renderWorkLogGroup',
        'wlGroupOpen',
        'wlGroupEl',
        // Spec 12: the list shows the scope of the agent the panel shows (main here).
        'wlScopeEntry',
        'wlScopeEntries',
        'wlLegacyMixed',
        // Tool call cards: a paired result is not a row (pure pairing).
        'wlPairKey',
        'wlPairTools',
        'wlPairsOf',
        'wlCardHidden',
        'wlVisible',
        'wlIsCard',
        'wlMarkStop',
        'wlRenderList',
        'wlAppendTail',
        'wlDetailOpen',
        'wlNavRows',
        'wlEnsureTabStop',
        'wlNamesNewAgent',
        'psecBox',
        'psecAtBottom',
        'psecSetTop',
        'psecSetNew',
        'psecOnAppended',
        'psecToNewest',
        'psecKeepPlace',
        'psecTreeRoot',
        'psecViewAnchor',
        'psecAnchorEl',
        'psecRestoreAnchor',
        'psecHoldPlace',
        'paintWorkLog',
      ],
      ['WL_LABELS', 'WL_STOP_SEL', ...WL_INSTRUCTION_VARS, 'PSEC_ANCHORS', 'PSEC_ANCHOR_MAX'],
      {
        document,
        _wl: state,
        // The cards' data needs the element (covered by the card suite below).
        wlHydrateCards: () => {},
        wlOnToolResult: () => false,
        wlPaintCard: () => {},
        panelSessionKey: null,
        _sessionCache: {},
        updateTimersIn: () => {},
        _panelAgent: '',
        _panelAgentIdsShown: {},
        renderPanelAgents: () => {},
        paintTreeTab: () => {},
        psecSyncControls: () => {},
        _psec: shown,
        _psecPin: true,
        _psecNew: 0,
      },
    );
    return { m, box, list, pill };
  }

  it('another section shown: the entries stay in the state, nothing is painted — the tab paints them when opened', () => {
    const st = { entries: [{ seq: 1 }, { seq: 2 }], painted: true };
    const p = page(st, 'conv');
    p.m.paintWorkLog(st, [{ entry: { seq: 2, kind: 'notice', text: 'live' }, index: 1 }]);
    expect(p.list.children).toHaveLength(0);
    expect(p.list.innerHTML).toBe('');
    expect(st.painted).toBe(false); // the tab renders the whole state when it opens (paintLogTab)
  });

  it('at the newest the reader follows the tail; reading higher, their place stays and the pill counts', () => {
    const st = { entries: [{ seq: 1 }, { seq: 2 }] as Array<{ seq: number }>, painted: true };
    const p = page(st);
    p.m.paintWorkLog(st, [{ entry: { seq: 2, kind: 'notice', text: 'x' }, index: 1 }]);
    expect(p.box.scrollTop).toBe(950); // followed (the box grew by the row)
    expect(p.pill.hidden).toBe(true);
    p.box.scrollTop = 100; // the reader reads higher up
    p.box._lastTop = 100;
    st.entries.push({ seq: 3 });
    p.m.paintWorkLog(st, [{ entry: { seq: 3, kind: 'notice', text: 'y' }, index: 2 }]);
    expect(p.box.scrollTop).toBe(100);
    expect(p.pill.hidden).toBe(false);
    expect(p.pill.textContent).toBe('새 항목 1개 ↓');
  });

  it('tail-follow stops while an entry’s detail is open', () => {
    // As wlMerge leaves it: state.entries already holds the added entry.
    const st = { entries: [{ seq: 1 }, { seq: 2 }] as Array<{ seq: number }>, painted: true, open: new Set([1]) };
    const p = page(st);
    p.box.scrollTop = 600; // at the bottom (900 - 300)
    p.m.paintWorkLog(st, [{ entry: { seq: 2, kind: 'tool', text: 'x' }, index: 1 }]);
    expect(p.box.scrollTop).toBe(600);
    st.open.clear();
    p.box.scrollTop = p.box.scrollHeight - p.box.clientHeight; // back at the newest
    st.entries.push({ seq: 3 });
    p.m.paintWorkLog(st, [{ entry: { seq: 3, kind: 'tool', text: 'y' }, index: 2 }]);
    expect(p.box.scrollTop).toBe(p.box.scrollHeight);
  });
});

describe("an older page keeps the reader's row in place — several rows in view are kept, the first still shown wins (shipped psecViewAnchor / psecRestoreAnchor)", () => {
  // A box at viewport y=100, 300px tall; rows at content offsets (y), 40px each.
  type Row = {
    attr: Record<string, string>;
    y: number;
    shown: boolean;
    inDom: boolean;
    group?: Row;
    getAttribute(n: string): string | null;
    getBoundingClientRect(): { top: number; bottom: number; height: number };
    getClientRects(): unknown[];
    closest(sel: string): Row | null;
  };
  function world(seqs: number[]) {
    const rows: Row[] = [];
    const groups: Row[] = [];
    const box = {
      scrollTop: 0,
      clientHeight: 300,
      _lastTop: 0,
      getBoundingClientRect: () => ({ top: 100 }),
      querySelector: (sel: string) => {
        if (sel === 'ui-agent-tree') return null;
        const m = /^\.(wl-entry|wl-group)\[(data-seq|data-task-id)="([^"]*)"\]$/.exec(sel);
        if (!m) return null;
        return [...rows, ...groups].find((r) => r.inDom && r.attr[m[2]] === m[3]) ?? null;
      },
      querySelectorAll: (sel: string) =>
        sel === '.wl-entry[data-seq]'
          ? rows.filter((r) => r.inDom)
          : sel === '.wl-group[data-task-id]'
            ? groups.filter((g) => g.inDom)
            : [],
    };
    const make = (attr: Record<string, string>, y: number, list: Row[]): Row => {
      const r: Row = {
        attr,
        y,
        shown: true,
        inDom: true,
        getAttribute: (n) => r.attr[n] ?? null,
        getBoundingClientRect: () => {
          const top = 100 + r.y - box.scrollTop;
          return r.shown ? { top, bottom: top + 40, height: 40 } : { top: 0, bottom: 0, height: 0 };
        },
        getClientRects: () => (r.shown ? [{}] : []),
        closest: (sel) => (sel === '.wl-group' ? (r.group ?? null) : null),
      };
      list.push(r);
      return r;
    };
    seqs.forEach((seq, i) => {
      make({ 'data-seq': String(seq) }, i * 40, rows);
    });
    const m = load<{
      psecViewAnchor(b: unknown): unknown[] | null;
      psecRestoreAnchor(b: unknown, a: unknown): boolean;
    }>(
      ['psecSetTop', 'psecTreeRoot', 'psecViewAnchor', 'psecAnchorEl', 'psecRestoreAnchor'],
      ['PSEC_ANCHORS', 'PSEC_ANCHOR_MAX'],
    );
    const group = (taskId: string, y: number) => make({ 'data-task-id': taskId }, y, groups);
    return { m, box, rows, group };
  }

  it('the rows in view, top first (those wholly below the top edge before the one it cuts), at most six; a row above the box is not one', () => {
    const w = world([10, 11, 12, 13, 14, 15, 16, 17, 18]);
    w.box.scrollTop = 20; // row 10 is half above the top: the edge cuts it (it may still grow) — it comes last
    const a = w.m.psecViewAnchor(w.box);
    expect(a).toEqual([
      { sel: '.wl-entry[data-seq="11"]', at: 20, tree: false },
      { sel: '.wl-entry[data-seq="12"]', at: 60, tree: false },
      { sel: '.wl-entry[data-seq="13"]', at: 100, tree: false },
      { sel: '.wl-entry[data-seq="14"]', at: 140, tree: false },
      { sel: '.wl-entry[data-seq="15"]', at: 180, tree: false },
      { sel: '.wl-entry[data-seq="16"]', at: 220, tree: false },
    ]);
    // Only a cut row in view (a tall one): it is the anchor.
    const tall = world([10]);
    tall.box.scrollTop = 20;
    expect(tall.m.psecViewAnchor(tall.box)).toEqual([{ sel: '.wl-entry[data-seq="10"]', at: -20, tree: false }]);
    w.box.scrollTop = 40;
    expect(w.m.psecViewAnchor(w.box)?.[0]).toEqual({ sel: '.wl-entry[data-seq="11"]', at: 0, tree: false });
  });

  it('the page went in above and took the top row away (a result paired into its call card): the next row keeps the place', () => {
    const w = world([10, 11, 12, 13]);
    const a = w.m.psecViewAnchor(w.box);
    // 500px of older entries above; row 10 is no longer a row of its own.
    for (const r of w.rows) r.y += 500;
    w.rows[0].inDom = false;
    expect(w.m.psecRestoreAnchor(w.box, a)).toBe(true);
    expect(w.box.scrollTop).toBe(500);
    expect(w.rows[1].getBoundingClientRect().top).toBe(100 + 40);
  });

  it('an entry folded into its (closed) task group is represented by the group head — only when no row of its own is left', () => {
    const w = world([10, 11]);
    const a = w.m.psecViewAnchor(w.box);
    const head = w.group('T1', 900);
    for (const r of w.rows) {
      r.shown = false;
      r.group = head;
    }
    expect(w.m.psecRestoreAnchor(w.box, a)).toBe(true);
    expect(w.box.scrollTop).toBe(900);
    // Nothing left at all: the caller falls back to the distance from the bottom.
    const gone = world([10]);
    const b = gone.m.psecViewAnchor(gone.box);
    gone.rows[0].inDom = false;
    expect(gone.m.psecRestoreAnchor(gone.box, b)).toBe(false);
    expect(gone.m.psecRestoreAnchor(gone.box, null)).toBe(false);
  });
});

describe('panel Tasks always render, also with no tasks (shipped renderPanelTasks)', () => {
  // Task view T1.3: the Tasks section is a disclosure in the focused tab,
  // folded by default (_panelTasksOpen); opened, the empty line shows.
  const tasksSection = (open: boolean) => {
    const container = fakeEl({ style: { display: 'none' } });
    const { renderPanelTasks } = load<{ renderPanelTasks(t: unknown): void }>(
      [
        'esc',
        'escAttr',
        'toNum',
        'agentIconHtml',
        'taskFateOf',
        'planSummaryHtml',
        'planEarlierCounts',
        'planEarlierGroups',
        'planEarlierHtml',
        'renderPanelTaskItem',
        'renderPanelTasks',
      ],
      ['TASK_FATE_LABEL', 'PI_CHEV_SVG'],
      {
        document: { getElementById: (id: string) => (id === 'panel-tasks' ? container : null) },
        _panelTasksOpen: open,
        _panelTasksExpanded: false,
        _panelTasksEarlier: false,
        // The browser morphs the block; this fake writes it.
        morphInnerHtml: (el: { innerHTML: string }, html: string) => {
          el.innerHTML = html;
        },
        updateTimersIn: () => {},
      },
    );
    return { container, renderPanelTasks };
  };
  const CHEV = new Function(`${clientVar('PI_CHEV_SVG')}\nreturn PI_CHEV_SVG;`)() as string;
  const head = (expanded: boolean) =>
    `<button type="button" class="panel-sec-head panel-tasks-header" aria-expanded="${expanded}"` +
    (expanded ? ' aria-controls="panel-tasks-body"' : '') +
    ` onclick="togglePanelTasks()"><span class="ps-sec-title">Tasks</span><span class="ps-sec-sum">목록 없음</span>${CHEV}</button>`;
  const LIVE = '<span class="ar-vh pl-live" role="status" aria-live="polite"></span>';

  it('zero or missing tasks show the header (folded: 목록 없음) and, opened, an empty line', () => {
    expect(CHEV).toContain('<svg class="pi-chev"');
    for (const open of [false, true]) {
      const { container, renderPanelTasks } = tasksSection(open);
      for (const t of [[], undefined, null]) {
        container.innerHTML = '';
        (container as { _html?: string })._html = undefined; // a fresh block (the same data on a live block writes nothing)
        renderPanelTasks(t);
        expect(container.style.display).toBe('');
        expect(container.innerHTML).toBe(
          open
            ? `${head(true)}<div class="panel-tasks-body" id="panel-tasks-body"><div class="panel-tasks-empty">아직 작업 목록이 없습니다</div></div>${LIVE}`
            : `${head(false)}${LIVE}`,
        );
      }
    }
  });
});

describe('stats: only the latest period / user selection paints (shipped loadStats + statsJson, _statsGen)', () => {
  type Pending = { url: string; settle(body: unknown, ok?: boolean): void };
  function page() {
    const pending: Pending[] = [];
    const fetch = (url: string) =>
      new Promise((res, rej) => {
        pending.push({
          url,
          settle: (body, ok = true) =>
            body instanceof Error ? rej(body) : res({ ok, status: ok ? 200 : 500, json: async () => body }),
        });
      });
    const painted: string[] = [];
    const m = load<{ loadStats(): Promise<void>; select(p: string, u: string): void }>(
      ['statsJson', 'loadStats', 'markStatsLoading'],
      ['_statsGen', 'STAT_IDS'],
      {
        fetch,
        // The loading bars (markStatsLoading) find no elements in this harness.
        document: { getElementById: () => null },
        currentPeriod: 'day',
        currentUserId: '',
        paintStats: (d: { tag?: string } | null) => painted.push(`stats:${d ? d.tag : 'dash'}`),
        paintUsage: (r: { tag?: string } | null) => painted.push(`usage:${r ? r.tag : 'dash'}`),
        updateTokenBreakdown: () => {},
        console: { error: () => {} },
      },
      ['function select(p, u) { currentPeriod = p; currentUserId = u; }'],
    );
    const answer = (url: string, body: unknown, ok?: boolean) => {
      const hit = pending.find((x) => x.url === url);
      if (!hit) throw new Error(`no request ${url} (have ${pending.map((x) => x.url).join(', ')})`);
      hit.settle(body, ok);
    };
    return { m, pending, painted, answer };
  }

  it('asks /stats and /usage for the period, with userId only when a user is selected', () => {
    const p = page();
    p.m.loadStats();
    p.m.select('week', 'U07KQ2M4XR1');
    p.m.loadStats();
    expect(p.pending.map((x) => x.url)).toEqual([
      '/api/dashboard/stats?period=day',
      '/api/dashboard/usage?period=day',
      '/api/dashboard/stats?period=week&userId=U07KQ2M4XR1',
      '/api/dashboard/usage?period=week&userId=U07KQ2M4XR1',
    ]);
  });

  it('period switch: answers for the replaced period landing last are dropped', async () => {
    const p = page();
    const day = p.m.loadStats();
    p.m.select('week', '');
    const week = p.m.loadStats();
    p.answer('/api/dashboard/stats?period=week', { tag: 'week' });
    p.answer('/api/dashboard/usage?period=week', { tag: 'week' });
    await week;
    p.answer('/api/dashboard/stats?period=day', { tag: 'day' });
    p.answer('/api/dashboard/usage?period=day', { tag: 'day' });
    await day;
    expect(p.painted).toEqual(['stats:week', 'usage:week']);
  });

  it('day → week → day: the middle selection never paints, also when it answers last', async () => {
    const p = page();
    const a = p.m.loadStats();
    p.m.select('week', '');
    const b = p.m.loadStats();
    p.m.select('day', '');
    const c = p.m.loadStats();
    // Requests 0/1 (first day) and 4/5 (last day) ask the same URLs; answer in order.
    p.pending[4].settle({ tag: 'day-2' });
    p.pending[5].settle({ tag: 'day-2' });
    await c;
    p.pending[0].settle({ tag: 'day-1' });
    p.pending[1].settle({ tag: 'day-1' });
    p.answer('/api/dashboard/stats?period=week', { tag: 'week' });
    p.answer('/api/dashboard/usage?period=week', { tag: 'week' });
    await Promise.all([a, b]);
    expect(p.painted).toEqual(['stats:day-2', 'usage:day-2']);
  });

  it('user switch: the previous user’s late answers and late failures paint nothing', async () => {
    const p = page();
    p.m.select('day', 'U07KQ2M4XR1');
    const alice = p.m.loadStats();
    p.m.select('day', 'U03BN8TZP6E');
    const bob = p.m.loadStats();
    p.answer('/api/dashboard/stats?period=day&userId=U03BN8TZP6E', { tag: 'bob' });
    p.answer('/api/dashboard/usage?period=day&userId=U03BN8TZP6E', { tag: 'bob' });
    await bob;
    p.answer('/api/dashboard/stats?period=day&userId=U07KQ2M4XR1', {}, false); // HTTP 500
    p.answer('/api/dashboard/usage?period=day&userId=U07KQ2M4XR1', new TypeError('Failed to fetch'));
    await alice;
    expect(p.painted).toEqual(['stats:bob', 'usage:bob']);
  });

  it('a failure for the current selection paints dashes, not the previous numbers', async () => {
    const p = page();
    const a = p.m.loadStats();
    p.answer('/api/dashboard/stats?period=day', {}, false);
    p.answer('/api/dashboard/usage?period=day', new TypeError('Failed to fetch'));
    await a;
    expect(p.painted.sort()).toEqual(['stats:dash', 'usage:dash']);
  });
});

describe('panel landing and older-page loading (shipped psecLandingTop + psecPageDue + psecMaybeFill; SSOT 2026-10-29)', () => {
  const m = load<{
    psecLandingTop(secTop: number, boxBottom: number, view: number, under: number): number;
    psecPageDue(scrollTop: number, scrollHeight: number, clientHeight: number, armed: boolean): boolean;
  }>(['psecLandingTop', 'psecPageDue'], []);

  it('작업 로그 / ?session= land at the top when the section box ends in view, else on the section tabs under the agent tabs', () => {
    expect(m.psecLandingTop(80, 560, 600, 44)).toBe(0); // no question: the tabs and the box fit
    expect(m.psecLandingTop(260, 600, 600, 44)).toBe(0); // a short question above it: all in view
    expect(m.psecLandingTop(520, 1100, 600, 44)).toBe(476); // a tall question: bring the tabs up
  });

  it('the top of the section within one box height of the view is the load-older zone — for a reader who scrolled up', () => {
    expect(m.psecPageDue(0, 5000, 600, true)).toBe(true);
    expect(m.psecPageDue(600, 5000, 600, true)).toBe(true);
    expect(m.psecPageDue(601, 5000, 600, true)).toBe(false);
    expect(m.psecPageDue(4400, 5000, 600, true)).toBe(false); // far below: reading newer items
  });

  it('a landing never loads; the reader moving up arms it; a page that leaves the top in the zone brings the next', () => {
    // Landed at the newest of a long box: not armed, nothing due — even at the top.
    expect(m.psecPageDue(4400, 5000, 600, false)).toBe(false);
    expect(m.psecPageDue(0, 5000, 600, false)).toBe(false);
    // The reader scrolls up into the zone (armed): one page.
    expect(m.psecPageDue(200, 5000, 600, true)).toBe(true);
    // The page went in above (place kept: +2000px) — out of the zone: no more.
    expect(m.psecPageDue(2200, 7000, 600, true)).toBe(false);
    // A short page left the top in the zone: the next one is due.
    expect(m.psecPageDue(500, 5300, 600, true)).toBe(true);
    // A box too short to scroll fills page by page, armed or not.
    expect(m.psecPageDue(0, 400, 600, false)).toBe(true);
  });

  it('one page at a time: the wiring loads through psecMaybeFill, which asks only while the section says older', () => {
    const fill = TEMPLATE.slice(
      TEMPLATE.indexOf('\nfunction psecMaybeFill('),
      TEMPLATE.indexOf('\n}\n', TEMPLATE.indexOf('\nfunction psecMaybeFill(')),
    );
    expect(fill).toContain('psecPageDue(box.scrollTop, box.scrollHeight, box.clientHeight, box._armed)');
    expect(fill).toContain("if (psecOlderState(sec) === 'older') psecLoadOlder(sec);");
    const load1 = TEMPLATE.slice(
      TEMPLATE.indexOf('\nfunction psecLoadOlder('),
      TEMPLATE.indexOf('\n}\n', TEMPLATE.indexOf('\nfunction psecLoadOlder(')),
    );
    expect(load1).toContain("if (sec !== _psec || psecOlderState(sec) !== 'older') return;");
  });
});

describe('DONE column: archived cards hide behind Show archives (shipped planDoneColumn)', () => {
  const { planDoneColumn } = load<{
    planDoneColumn(
      idle: DoneCard[],
      closed: DoneCard[],
      o: { now: number; showOlder: boolean; showArchives: boolean; revealKey: string | null },
    ): DonePlan;
  }>(['planDoneColumn'], []);
  const NOW = Date.parse('2026-03-20T12:00:00Z');
  const ago = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();
  const IDLE = [{ key: 'idle-1', lastActivity: ago(0) }];
  const CLOSED: DoneCard[] = [
    { key: 'sleeping-recent', lastActivity: ago(1) },
    { key: 'archived-recent', lastActivity: ago(2), terminated: true },
    { key: 'sleeping-old', lastActivity: ago(8) },
    { key: 'archived-old', lastActivity: ago(9), terminated: true },
  ];
  const plan = (o: Partial<{ showOlder: boolean; showArchives: boolean; revealKey: string | null }> = {}) =>
    planDoneColumn(IDLE, CLOSED, { now: NOW, showOlder: false, showArchives: false, revealKey: null, ...o });
  const keys = (p: DonePlan) => p.done.map((d) => d.s.key);

  // SSOT 2026-10-22 T11/T12: no 7-day cutoff any more — every age is in, and
  // planDoneGroups files the cards under the day they finished (earlier days
  // start closed).
  it('hides archived cards by default; sleeping ones stay, of any age', () => {
    const p = plan();
    expect(keys(p)).toEqual(['idle-1', 'sleeping-recent', 'sleeping-old']);
    expect(p.done.map((d) => d.col)).toEqual(['idle', 'closed', 'closed']);
    expect(p).toMatchObject({ archivedCount: 2 });
    expect('olderCount' in p).toBe(false);
  });

  it('Show archives adds every archive, of any age', () => {
    const shown = plan({ showArchives: true });
    expect(keys(shown)).toEqual(['idle-1', 'sleeping-recent', 'archived-recent', 'sleeping-old', 'archived-old']);
    expect(shown).toMatchObject({ archivedCount: 2 });
  });

  it('a revealed (deep-linked) archive shows on its own, whatever its age', () => {
    const recent = plan({ revealKey: 'archived-recent' });
    expect(keys(recent)).toEqual(['idle-1', 'sleeping-recent', 'archived-recent', 'sleeping-old']);
    const old = plan({ revealKey: 'archived-old' });
    expect(keys(old)).toEqual(['idle-1', 'sleeping-recent', 'sleeping-old', 'archived-old']);
    expect(old).toMatchObject({ archivedCount: 2 });
  });
});

describe('Show archives choice persists (shipped readShowArchives + toggleArchives)', () => {
  function page(stored: Record<string, string>, opts: { throws?: boolean } = {}) {
    const store = new Map(Object.entries(stored));
    const localStorage = {
      getItem: (k: string) => {
        if (opts.throws) throw new Error('SecurityError');
        return store.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (opts.throws) throw new Error('SecurityError');
        store.set(k, v);
      },
    };
    let loads = 0;
    const m = load<{
      readShowArchives(): boolean;
      toggleArchives(): void;
      state(): { show: boolean; revealed: string | null };
    }>(
      ['readShowArchives', 'toggleArchives'],
      ['SHOW_ARCHIVES_KEY'],
      {
        localStorage,
        showArchives: false,
        _revealedKey: 'deep-linked',
        loadSessions: () => {
          loads++;
        },
      },
      ['function state() { return { show: showArchives, revealed: _revealedKey }; }'],
    );
    return { m, store, loads: () => loads };
  }

  it('reads hidden unless "on" was stored; a throwing storage reads hidden', () => {
    expect(page({}).m.readShowArchives()).toBe(false);
    expect(page({ 'soma-show-archives': 'off' }).m.readShowArchives()).toBe(false);
    expect(page({ 'soma-show-archives': 'on' }).m.readShowArchives()).toBe(true);
    expect(page({}, { throws: true }).m.readShowArchives()).toBe(false);
  });

  it('the toggle flips, stores on / off, re-renders, and ends a deep-link reveal', () => {
    const p = page({});
    p.m.toggleArchives();
    expect(p.m.state()).toEqual({ show: true, revealed: null });
    expect(p.store.get('soma-show-archives')).toBe('on');
    p.m.toggleArchives();
    expect(p.m.state().show).toBe(false);
    expect(p.store.get('soma-show-archives')).toBe('off');
    expect(p.loads()).toBe(2);
    // Storage that throws still toggles for this page.
    const q = page({}, { throws: true });
    q.m.toggleArchives();
    expect(q.m.state().show).toBe(true);
  });
});

describe('deep link to a hidden archived card still opens it (shipped openDeepLinkedSession)', () => {
  type Card = { key: string; terminated?: boolean; lastActivity?: string };
  function page(card: Card, opts: { showArchives?: boolean } = {}) {
    const calls = { loads: 0, revealed: [] as string[], panel: [] as unknown[][], stored: 0 };
    // The element each card is drawn by (_cardHost): a closed DONE day's card is on it too, as a stub.
    const hosts: Record<string, { reveal?(k: string): boolean }> = Object.create(null);
    let whenDefined: (() => void) | null = null;
    const m = load<{
      openDeepLinkedSession(): void;
      state(): { revealed: string | null; link: string | null; showArchives: boolean };
    }>(
      ['resolveDeepLinkKey', 'openDeepLinkedSession'],
      ['_deepLinkWaiting'],
      {
        _deepLinkSession: 'work:C1:1700000000.000700',
        _deepLinkDeadline: Date.now() + 10_000,
        _sessionCache: { [card.key]: card },
        SELF_INSTANCE_NAME: 'inst',
        _cardHost: hosts,
        showArchives: !!opts.showArchives,
        showSleeping: true,
        _revealedKey: null,
        _cronRevealKey: null,
        localStorage: {
          setItem: () => {
            calls.stored++;
          },
        },
        loadSessions: () => {
          calls.loads++;
        },
        openPanel: (...a: unknown[]) => calls.panel.push(a),
        window: { customElements: {} },
        customElements: {
          whenDefined: () => ({
            // biome-ignore lint/suspicious/noThenProperty: a hand-driven thenable — the test decides when the element is defined
            then: (fn: () => void) => {
              whenDefined = fn;
            },
          }),
        },
      },
      ['function state() { return { revealed: _revealedKey, link: _deepLinkSession, showArchives: showArchives }; }'],
    );
    const render = (defined = true) => {
      hosts[card.key] = defined
        ? {
            reveal: (k: string) => {
              calls.revealed.push(k);
              return true;
            },
          }
        : {};
    };
    return { m, calls, render, defined: () => whenDefined?.() };
  }
  // The board key of an archived session (archivedToKanban): "<inst>::archived_<registry key>_<archivedAt>".
  const KEY = 'inst::archived_work:C1:1700000000.000700_1792000000000';

  it('reveals just that archive for this page load, then reveals it on its element and opens the panel', () => {
    const p = page({ key: KEY, terminated: true });
    p.m.openDeepLinkedSession(); // the card is hidden: reveal + re-render
    expect(p.m.state()).toEqual({ revealed: KEY, link: 'work:C1:1700000000.000700', showArchives: false });
    expect(p.calls.loads).toBe(1);
    p.render(); // the re-render drew it (planDoneColumn keeps a revealed key, any age)
    p.m.openDeepLinkedSession();
    // el.reveal: opens its closed DONE day if it is in one, opens the card, scrolls it to the centre
    // (@2lab.ai/ui agent-inbox.test.ts owns that).
    expect(p.calls.revealed).toEqual([KEY]);
    expect(p.calls.panel).toEqual([[KEY, true]]);
    expect(p.m.state().link).toBeNull();
    expect(p.calls.stored).toBe(0); // the stored Show archives choice is untouched
  });

  it('waits for <ui-agent-inbox> to be defined before it reveals (the module can land after the first answer)', () => {
    const p = page({ key: KEY, lastActivity: '2026-10-01T03:00:00.000Z' });
    p.render(false);
    p.m.openDeepLinkedSession();
    expect(p.calls.revealed).toEqual([]);
    expect(p.m.state().link).toBe('work:C1:1700000000.000700');
    p.render(true);
    p.defined();
    expect(p.calls.revealed).toEqual([KEY]);
    expect(p.calls.panel).toEqual([[KEY, true]]);
  });

  it('a card on no element that no toggle hides is given up', () => {
    const p = page({ key: KEY, lastActivity: '2026-10-01T03:00:00.000Z' });
    p.m.openDeepLinkedSession();
    expect(p.m.state().link).toBeNull();
    expect(p.calls.loads).toBe(0);
    expect(p.calls.revealed).toEqual([]);
  });
});

describe('All Users: owner badge on every card (shipped assignOwnerHues + ownerBadgeHue + cardOf)', () => {
  type Badge = {
    assignOwnerHues(ids: string[]): Record<string, number>;
    ownerBadgeHue(id: string): number;
    cardOf(s: Record<string, unknown>, col: string): CardData;
  };
  const badge = (currentUserId: string, owners: string[] = []) => {
    const m = load<Badge>(
      ['assignOwnerHues', ...CARD_OF_FNS],
      CARD_OF_VARS,
      { currentUserId, _ownerIndex: null, dhShow: () => true, dhTruncate: () => null, SELF_INSTANCE_NAME: '' },
      ['function setIndex(i) { _ownerIndex = i; }'],
    ) as Badge & { setIndex(i: unknown): void };
    m.setIndex(m.assignOwnerHues(owners));
    return m;
  };
  const badgeOf = (m: Badge, s: Record<string, unknown>) => m.cardOf({ key: 'k', ...s }, 'idle').badge;
  // Slack-style member ids. Under a bare hash % 8 the first two pairs collide
  // (U01ZHG7K2QD / U07KQ2M4XR1 on 3, U05HJ1WQ9DA / U06TF4YQ8BN on 0).
  const TEAM = ['U01ZHG7K2QD', 'U07KQ2M4XR1', 'U03BN8TZP6E', 'U05HJ1WQ9DA', 'U06TF4YQ8BN'];
  const all = badge('', TEAM);

  it('names the owner in All Users mode only, full name in title (the element draws badge, right end of the head)', () => {
    expect(badgeOf(all, { ownerId: TEAM[1], ownerName: 'Alice' })).toEqual({
      text: 'Alice',
      hue: all.ownerBadgeHue(TEAM[1]),
      title: 'Alice',
    });
    expect(badgeOf(badge(TEAM[1], TEAM), { ownerId: TEAM[1], ownerName: 'Alice' })).toBeUndefined();
    expect(badgeOf(all, {})).toBeUndefined();
  });

  it('hands the name over as text — the element escapes it (badge is text only, @2lab.ai/ui agent-inbox.test.ts)', () => {
    const name = '<img src=x onerror=alert(1)> "q" \'s';
    expect(badgeOf(all, { ownerId: 'U0BADNAME01', ownerName: name })).toMatchObject({ text: name, title: name });
  });

  it('owners on the board never share a colour while there are ≤ 8 of them; hash slot first, then probing', () => {
    const hues = all.assignOwnerHues(TEAM);
    expect(new Set(TEAM.map((id) => hues[id])).size).toBe(TEAM.length);
    // The first owner in sorted order always keeps its hash slot.
    expect(hues.U01ZHG7K2QD).toBe(3);
    const eight = [...TEAM, 'U02MXR7LC3K', 'U04PLW3N6VS', 'U08CRX5J1MT'];
    const h8 = all.assignOwnerHues(eight);
    expect(new Set(eight.map((id) => h8[id])).size).toBe(8);
    // More owners than hues: every one still gets a valid slot.
    const ten = [...eight, 'U09DKS2V7QE', 'U0A1B2C3D4E'];
    const h10 = all.assignOwnerHues(ten);
    for (const id of ten) expect(h10[id] >= 0 && h10[id] < 8).toBe(true);
  });

  it('stable for a given owner set: order and repeats do not matter; one person keeps one colour', () => {
    const a = all.assignOwnerHues(TEAM);
    const b = all.assignOwnerHues([...TEAM].reverse().concat(TEAM[0], TEAM[2], ''));
    expect(b).toEqual(a);
    const x = badgeOf(all, { ownerId: TEAM[2], ownerName: 'Bob' });
    const y = badgeOf(all, { ownerId: TEAM[2], ownerName: 'Bob (renamed)' });
    expect(x?.hue).toBe(y?.hue);
    // An owner not on the board (yet) falls back to the hash slot.
    expect(all.ownerBadgeHue('U0NOTONBRD1')).toBe(all.assignOwnerHues(['U0NOTONBRD1']).U0NOTONBRD1);
  });
});

describe('muted text contrast ≥ 4.5:1 on every surface it sits on (CSS tokens)', () => {
  function tokens(selector: RegExp): Record<string, string> {
    const block = TEMPLATE.match(selector)?.[1] ?? '';
    const out: Record<string, string> = {};
    for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)) out[m[1]] = m[2];
    return out;
  }
  const dark = tokens(/:root \{([^}]+)\}/);
  const light = { ...dark, ...tokens(/\[data-theme="light"\] \{([^}]+)\}/) };
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  // Text token → surfaces it is rendered on (page, column, card, dimmed card, segment track, panel).
  const PAIRS: Array<[string, string[]]> = [
    ['ib-muted', ['bg', 'ib-col', 'ib-card', 'ib-card-dim', 'ib-seg']],
    ['ib-text-2', ['bg', 'ib-col', 'ib-card', 'ib-card-dim', 'ib-pill']],
    ['text-tertiary', ['bg', 'surface', 'surface-raised']],
    ['text-secondary', ['bg', 'surface', 'surface-raised']],
    ['st-fail', ['ib-card']],
    ['st-done', ['ib-card', 'ib-card-dim']],
    ['accent', ['ib-card', 'surface']],
    ['red', ['surface']],
  ];
  for (const [theme, t] of [
    ['dark', dark],
    ['light', light],
  ] as const) {
    for (const [fg, surfaces] of PAIRS) {
      for (const bg of surfaces) {
        it(`${theme}: --${fg} on --${bg}`, () => {
          expect(t[fg], `--${fg}`).toMatch(/^#/);
          expect(t[bg], `--${bg}`).toMatch(/^#/);
          expect(ratio(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
    // Owner badges (All Users) are <ui-agent-inbox>'s badge.hue tints now — eight hues mixed from the card and
    // the ink (@2lab.ai/ui agent-inbox styles.ts, docs 'badge': ≥ 4.5:1 in both themes); the page keeps no --ob-* pair.
  }
});

describe('DONE column: sleeping cards hide behind the Sleeping toggle (shipped planDoneColumn)', () => {
  type Opts = {
    now: number;
    showOlder: boolean;
    showArchives: boolean;
    showSleeping?: boolean;
    revealKey: string | null;
  };
  const { planDoneColumn } = load<{
    planDoneColumn(idle: DoneCard[], closed: DoneCard[], o: Opts): DonePlan & { sleepingCount: number };
  }>(['planDoneColumn'], []);
  const NOW = Date.parse('2026-03-20T12:00:00Z');
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
  const IDLE = [{ key: 'idle-1', lastActivity: ago(0) }];
  const CLOSED: DoneCard[] = [
    { key: 'sleeping-recent', lastActivity: ago(1) },
    { key: 'archived-recent', lastActivity: ago(2), terminated: true },
    { key: 'sleeping-mid', lastActivity: ago(4) },
    { key: 'sleeping-old', lastActivity: ago(8) },
  ];
  const plan = (o: Partial<Opts> = {}) =>
    planDoneColumn(IDLE, CLOSED, { now: NOW, showOlder: false, showArchives: false, revealKey: null, ...o });
  const keys = (p: DonePlan) => p.done.map((d) => d.s.key);

  it('shows sleeping cards unless the toggle is off, and always counts them', () => {
    expect(keys(plan())).toEqual(['idle-1', 'sleeping-recent', 'sleeping-mid', 'sleeping-old']);
    expect(plan()).toMatchObject({ sleepingCount: 3, archivedCount: 1 });
    const off = plan({ showSleeping: false });
    expect(keys(off)).toEqual(['idle-1']);
    expect(off).toMatchObject({ sleepingCount: 3, archivedCount: 1 });
  });

  it('hiding sleeping leaves archives to their own toggle', () => {
    expect(keys(plan({ showSleeping: false, showArchives: true }))).toEqual(['idle-1', 'archived-recent']);
  });

  it('a revealed (deep-linked) sleeping card shows while sleeping cards are hidden', () => {
    expect(keys(plan({ showSleeping: false, revealKey: 'sleeping-old' }))).toEqual(['idle-1', 'sleeping-old']);
  });
});

describe('Sleeping choice persists (shipped readShowSleeping + toggleSleeping)', () => {
  function page(stored: Record<string, string>) {
    const store = new Map(Object.entries(stored));
    const localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };
    let loads = 0;
    const m = load<{
      readShowSleeping(): boolean;
      toggleSleeping(): void;
      state(): { show: boolean; revealed: string | null };
    }>(
      ['readShowSleeping', 'toggleSleeping'],
      ['SHOW_SLEEPING_KEY'],
      {
        localStorage,
        showSleeping: true,
        _revealedKey: 'deep-linked',
        loadSessions: () => {
          loads++;
        },
      },
      ['function state() { return { show: showSleeping, revealed: _revealedKey }; }'],
    );
    return { m, store, loads: () => loads };
  }

  it('reads shown unless "off" was stored (sleeping cards were always shown before)', () => {
    expect(page({}).m.readShowSleeping()).toBe(true);
    expect(page({ 'soma-show-sleeping': 'on' }).m.readShowSleeping()).toBe(true);
    expect(page({ 'soma-show-sleeping': 'off' }).m.readShowSleeping()).toBe(false);
  });

  it('the toggle flips, stores on / off, re-renders, and ends a deep-link reveal', () => {
    const p = page({});
    p.m.toggleSleeping();
    expect(p.m.state()).toEqual({ show: false, revealed: null });
    expect(p.store.get('soma-show-sleeping')).toBe('off');
    p.m.toggleSleeping();
    expect(p.m.state().show).toBe(true);
    expect(p.store.get('soma-show-sleeping')).toBe('on');
    expect(p.loads()).toBe(2);
  });
});

describe('deep link to a hidden sleeping card reveals it (shipped openDeepLinkedSession)', () => {
  it('reveals the sleeping card for this page load without touching the stored choice', () => {
    const KEY = 'inst::work:C1:1700000000.000900';
    let loads = 0;
    const m = load<{ openDeepLinkedSession(): void; state(): { revealed: string | null } }>(
      ['resolveDeepLinkKey', 'openDeepLinkedSession'],
      ['_deepLinkWaiting'],
      {
        _deepLinkSession: 'work:C1:1700000000.000900',
        _deepLinkDeadline: Date.now() + 10_000,
        _sessionCache: { [KEY]: { key: KEY, lastActivity: new Date().toISOString() } },
        SELF_INSTANCE_NAME: 'inst',
        _cardHost: Object.create(null),
        showArchives: false,
        showSleeping: false,
        _revealedKey: null,
        _cronRevealKey: null,
        loadSessions: () => {
          loads++;
        },
        openPanel: () => {},
      },
      ['function state() { return { revealed: _revealedKey }; }'],
    );
    m.openDeepLinkedSession();
    expect(m.state()).toEqual({ revealed: KEY });
    expect(loads).toBe(1);
  });
});

describe('admin lifecycle form (shipped lifecycleToForm + lifecycleFromForm)', () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const m = load<{
    lifecycleToForm(p: Record<string, number>): Record<string, number>;
    lifecycleFromForm(
      f: Record<string, unknown>,
    ): { ok: true; patch: Record<string, number> } | { ok: false; field: string };
  }>(['lifecycleToForm', 'lifecycleFromForm'], ['LIFECYCLE_FIELDS']);

  it('shows sleep and the board archive window in hours, the archive time in days', () => {
    expect(
      m.lifecycleToForm({ sleepAfterMs: 24 * HOUR, archiveAfterMs: 7 * DAY, boardArchiveWindowMs: 48 * HOUR }),
    ).toEqual({ sleepAfterHours: 24, archiveAfterDays: 7, boardArchiveWindowHours: 48 });
  });

  it('turns the form back into a millisecond patch, rounding to whole minutes', () => {
    expect(
      m.lifecycleFromForm({
        sleepAfterHours: '6',
        archiveAfterDays: '1.5',
        boardArchiveWindowHours: '0',
      }),
    ).toEqual({ ok: true, patch: { sleepAfterMs: 6 * HOUR, archiveAfterMs: 36 * HOUR, boardArchiveWindowMs: 0 } });
  });

  it('names the first field that is not a non-negative number', () => {
    expect(
      m.lifecycleFromForm({
        sleepAfterHours: '6',
        archiveAfterDays: 'abc',
        boardArchiveWindowHours: '1',
      }),
    ).toEqual({ ok: false, field: 'archiveAfterDays' });
    expect(
      m.lifecycleFromForm({
        sleepAfterHours: '',
        archiveAfterDays: '1',
        boardArchiveWindowHours: '1',
      }),
    ).toEqual({ ok: false, field: 'sleepAfterHours' });
    expect(
      m.lifecycleFromForm({
        sleepAfterHours: '1',
        archiveAfterDays: '1',
        boardArchiveWindowHours: '-1',
      }),
    ).toEqual({ ok: false, field: 'boardArchiveWindowHours' });
  });
});

describe('답변하기 opens the panel on the open question (shipped renderMultiChoiceCard → openPanel)', () => {
  // A panel-scroll model: question (when shown) · the section tabs · the section
  // box, in that order (the template's #panel-scroll; SSOT 2026-10-29 — the turns
  // scroll in the box, not in the panel). The browser clamps scrollTop to the
  // content, so a stale position from the previous opening shrinks with it.
  const KEY = 'inst::work:C1:1700000000.000100';
  const AREA_TOP = 200;
  const VIEW = 600;
  const SEC_TABS = 40;
  const SEC_BOX = 300;
  type Session = Record<string, unknown>;
  type Panel = {
    openPanel(key: string, focusWorkLog?: boolean): void;
    renderMultiChoiceCard(s: Session, faceSummary: string): string;
    renderPanelQuestion(s: Session): void;
    section(): string;
    turnsMsg(): string;
    turnsHeld(): number;
  };

  const waitingMulti = (over: Session = {}): Session => ({
    key: KEY,
    conversationId: 'conv1',
    ownerId: 'U1',
    activityState: 'waiting',
    title: 'S',
    pendingQuestion: {
      type: 'user_choices',
      title: '두 가지 확인',
      questions: [
        {
          id: 'q1',
          question: '첫 질문?',
          choices: [
            { id: '1', label: 'a' },
            { id: '2', label: 'b' },
          ],
          recommendedChoiceId: '1',
        },
        { id: 'q2', question: '둘째 질문?', choices: [{ id: '1', label: 'c' }], recommendedChoiceId: '1' },
      ],
    },
    ...over,
  });

  function page(opts: {
    session: Session;
    questionHeight?: number;
    prevScrollTop?: number;
    turns?: 'ok' | 'empty' | 'fail' | 'held';
    settle?: 'ok' | 'empty' | 'fail';
    /** 자세히 on: the whole conversation, landed on the newest turns. */
    detail?: boolean;
  }) {
    const els: Record<string, FakeEl & Record<string, unknown>> = {};
    const el = (id: string) => {
      els[id] ??= Object.assign(fakeEl({ id }), { classList: { add() {}, remove() {} } });
      return els[id];
    };
    const question = el('panel-question');
    question.style.display = 'none';
    // openPanel's .then and .catch both end in a landing, so a harness gap (a new
    // dependency of openPanel that is not injected) would silently run the
    // failure path and still land. Make that loud: only a 'fail' run may end failed.
    const outcome = opts.turns === 'held' ? (opts.settle ?? 'ok') : (opts.turns ?? 'ok');
    const qH = () => (question.style.display === 'none' ? 0 : (opts.questionHeight ?? 420));
    const scroll = el('panel-scroll');
    let stored = opts.prevScrollTop ?? 0;
    const height = () => qH() + SEC_TABS + SEC_BOX;
    const max = () => Math.max(0, height() - VIEW);
    Object.defineProperties(scroll, {
      scrollHeight: { get: height, configurable: true },
      clientHeight: { value: VIEW, configurable: true },
      scrollTop: {
        get: () => Math.min(stored, max()),
        set: (v: number) => {
          stored = Math.max(0, Math.min(v, max()));
        },
        configurable: true,
      },
    });
    Object.assign(scroll, {
      scrollTo: ({ top }: { top: number }) => {
        scroll.scrollTop = top;
      },
      getBoundingClientRect: () => ({ top: AREA_TOP, bottom: AREA_TOP + VIEW, height: VIEW }),
    });
    Object.assign(question, { getBoundingClientRect: () => ({ top: AREA_TOP - scroll.scrollTop, height: qH() }) });
    Object.assign(el('panel-sections'), {
      getBoundingClientRect: () => ({ top: AREA_TOP + qH() - scroll.scrollTop, height: SEC_TABS }),
    });
    Object.assign(el('panel-sections-body'), {
      getBoundingClientRect: () => {
        const top = AREA_TOP + qH() + SEC_TABS - scroll.scrollTop;
        return { top, bottom: top + SEC_BOX, height: SEC_BOX };
      },
    });

    let release: () => void = () => {};
    const payload = { id: 'conv1', titleSub: 'sub', hasMore: false, turns: [{ id: 't1', role: 'assistant' }] };
    const fetchImpl = () => {
      if (opts.turns === 'fail') return Promise.reject(new Error('down'));
      const res = { json: async () => (outcome === 'empty' ? { ...payload, turns: [] } : payload) };
      if (opts.turns === 'held')
        return new Promise((r, j) => (release = () => (outcome === 'fail' ? j(new Error('down')) : r(res))));
      return Promise.resolve(res);
    };
    const cache: Record<string, Session> = { [KEY]: opts.session };
    const m = load<Panel>(
      [
        'openPanel',
        'turnsSkeletonHtml',
        'renderPanelPermission',
        // affectUI batch 1: the prompts are <ui-approval-card> slots (none in this harness).
        'acPermissionsHtml',
        'acSlotHtml',
        'acQuestionId',
        'acQuestionHtml',
        'acHydrate',
        'apSafeFocus',
        'apAnnounce',
        'renderPanelQuestion',
        // re-agent-run D9: both slots keep the 입력 필요 head in step.
        'renderPanelNeedsHead',
        'panelQuestionShown',
        'renderMultiChoicePanel',
        'renderMultiChoiceCard',
        'esc',
        'escAttr',
        'escJs',
        'choiceDataAttrs',
        'stripRecommendedMarker',
        'resolveRecommendedId',
        'psecForLanding',
        'psecLandingTop',
        'landPanel',
        'ptUpsert',
      ],
      [
        '_mcState',
        '_panelLand',
        '_panelLanded',
        '_panelLandAt',
        '_panelReturnFocus',
        '_panelTurnsHasMore',
        '_panelTurnsLoading',
        '_panelTurnsOldestId',
        '_panelTurnsList',
        '_panelTurnsCid',
        '_panelTurnsMsg',
        '_panelGen',
        '_panelOnQuestion',
        'PANEL_TURNS_PAGE',
        'AT_PANEL_WINDOW',
        '_psec',
        '_treeWindow',
        '_treeMaxN',
      ],
      {
        // affectUI batch 2b: openPanel gives each opening a fresh <ui-agent-steering>; this harness has no composer.
        pcFreshSteer: () => {},
        document: { getElementById: el },
        fetch: fetchImpl,
        // The single-choice question's approval-card slot is written by a morph.
        morphInnerHtml: (e: { innerHTML: string }, h: string) => {
          e.innerHTML = h;
        },
        _sessionCache: cache,
        currentUserId: 'U1',
        READ_ONLY_MSG: 'read-only',
        panelOpen: false,
        panelSessionKey: null,
        panelConvId: null,
        _panelTasksExpanded: false,
        resetWorkLog: () => {},
        renderPanelTasks: () => {},
        // Task view: openPanel resets the composer's attachments and the sections
        // (folded; 자세히 opens them); the section tab of the opening is painted
        // from its data (covered in dashboard-panel-sections-client.test.ts).
        pcReset: () => {},
        resetPanelSections: () => {},
        selectPanelSection: () => {},
        sizePanelSections: () => {},
        paintConvTab: () => {},
        psecSyncControls: () => {},
        psecToNewest: () => {},
        psecMaybeFill: () => {},
        _panelDetail: !!opts.detail,
        _panelTasksOpen: false,
        _agentConvRaw: null,
        _agentConvFailed: null,
        // The previous opening's answer observer (none in this harness).
        _ansIo: null,
        _panelScrollGen: 0, // #488: every landing scroll starts a new panel scroll generation
        _panelAgent: '',
        _panelAgentListOpen: false,
        renderTurn: (t: { id: string }) => `<div class="turn assistant" data-turn-id="${t.id}"></div>`,
        attachRawToggleHandlers: () => {},
        // Session artifacts (SSOT 2026-10-23): the panel strip and per-answer chips.
        renderPanelArtifactsSection: () => {},
        ensureArtifacts: () => {},
        decoratePanelTurns: () => {},
        isSiblingSession: () => false,
        // main's own openPanel deps since this harness was written (#372 panel controls, spec 12 agent views).
        renderPanelControls: () => {},
        // Spec 13: the session parts go through one live path; a keyboard opening focuses its landing.
        repaintPanelSession: () => {},
        renderPanelComposer: () => {},
        focusPanelLanding: () => {},
        _panelTasksEarlier: false,
        // SSOT 2026-10-24: openPanel marks the layout before the drawer changes it (layout-shift FLIP).
        layoutBeforeChange: () => {},
        renderPanelAgents: () => {},
        panelAgentTasks: () => [],
        panelAgentLabel: () => '',
        generateTitleSub: () => {},
        _panelTitleSub: '',
        panelTitleSubCanRegen: () => true,
        loadWorkLog: () => {},
        renderMdBasic: String, // carries backticks, so it cannot be cooked; no question here has context
        timeAgo: () => '',
        safeHref: (u: string) => u,
        formatTokens: String,
        toNum: Number,
      },
      [
        'function section() { return _psec; }',
        'function turnsMsg() { return _panelTurnsMsg; }',
        'function turnsHeld() { return _panelTurnsList.length; }',
      ],
    );
    /** Click the card's 답변하기 button: run its shipped onclick against the shipped openPanel. */
    const clickAnswer = () => {
      const html = m.renderMultiChoiceCard(cache[KEY], '');
      // re-agent-inbox D10: the button is the card's primary (btn-choice btn-choice-primary).
      const btn = /<button class="btn-choice[^"]*" onclick="([^"]+)"[^>]*>답변하기<\/button>/.exec(html);
      if (!btn) throw new Error('no 답변하기 button on the card');
      new Function('event', 'openPanel', btn[1])({ stopPropagation() {} }, m.openPanel);
    };
    /** The answer form's top edge is inside the visible scroll area. */
    const formInView = () => {
      const top = AREA_TOP - scroll.scrollTop;
      return question.style.display !== 'none' && top >= AREA_TOP && top < AREA_TOP + VIEW;
    };
    /** The turns' outcome as 지시와 답변 holds it — only a 'fail' run may end failed (see above). */
    const settled = () => {
      const msg = m.turnsMsg();
      if (msg === 'failed' && outcome !== 'fail')
        throw new Error('openPanel took its failure path on a successful load: the harness is missing a dependency');
      return msg;
    };
    return { m, scroll, question, cache, clickAnswer, formInView, settled, release: () => release(), bottom: max };
  }

  it('lands on the answer form, not on the newest turns, and stays there while the panel settles', async () => {
    const p = page({ session: waitingMulti() });
    p.clickAnswer();
    await flush();
    await flush();
    expect(p.formInView()).toBe(true);
    expect(p.scroll.scrollTop).toBe(0);
    // 답변하기 opens on 지시와 답변, its turns held as its data (the box holds their scroll).
    expect(p.m.section()).toBe('conv');
    expect(p.settled()).toBe('');
    expect(p.m.turnsHeld()).toBe(1);
  });

  // affectUI batch 1: the single-choice question is a <ui-approval-card> in the same slot — the
  // opening lands on it as on the form (the brief's suspected lost landing anchor: it is not lost).
  it('a single-choice question (an approval card) is where the panel lands, before and after the turns arrive', async () => {
    const single = waitingMulti({
      pendingQuestion: {
        type: 'user_choice',
        question: '배포할까요?',
        choices: [
          { id: '1', label: '지금' },
          { id: '2', label: '나중에' },
        ],
        recommendedChoiceId: '1',
      },
    });
    const p = page({ session: single, prevScrollTop: 3000, turns: 'held' });
    p.m.openPanel(KEY);
    expect(p.question.innerHTML).toContain(
      '<ui-approval-card lang="ko" data-ac-key="' + KEY + '" data-ac-kind="question">',
    );
    expect(p.formInView()).toBe(true);
    p.release();
    await flush();
    await flush();
    expect(p.formInView()).toBe(true);
    expect(p.m.section()).toBe('conv');
  });

  it('lands on the form even when the panel was left scrolled down by the previous opening', async () => {
    const p = page({ session: waitingMulti(), prevScrollTop: 3000 });
    p.clickAnswer();
    await flush();
    await flush();
    expect(p.formInView()).toBe(true);
  });

  it('the form is in view as soon as the panel opens, before the turns arrive', () => {
    const p = page({ session: waitingMulti(), questionHeight: 900, prevScrollTop: 3000, turns: 'held' });
    p.clickAnswer();
    expect(p.formInView()).toBe(true);
  });

  it.each([
    'ok',
    'empty',
    'fail',
  ] as const)('a reader who scrolls down a tall form while the turns load is not pulled back (turns: %s)', async (outcome) => {
    const p = page({ session: waitingMulti(), questionHeight: 900, turns: 'held', settle: outcome });
    p.clickAnswer();
    p.scroll.scrollTop = 200; // the reader moves to a later question before the response
    p.release();
    await flush();
    await flush();
    expect(p.scroll.scrollTop).toBe(200);
  });

  it('every 답변하기 opening lands on the form again, not only the first', async () => {
    const p = page({ session: waitingMulti(), questionHeight: 900 });
    p.clickAnswer();
    await flush();
    await flush();
    p.scroll.scrollTop = 700; // read down past the form, then open it again
    p.clickAnswer();
    await flush();
    await flush();
    expect(p.formInView()).toBe(true);
  });

  it('a tall form whose turns fail to load still opens at its top', async () => {
    const p = page({ session: waitingMulti(), questionHeight: 900, prevScrollTop: 3000, turns: 'fail' });
    p.clickAnswer();
    await flush();
    await flush();
    expect(p.formInView()).toBe(true);
  });

  it('a tall form whose conversation has no turns yet still opens at its top', async () => {
    const p = page({ session: waitingMulti(), questionHeight: 900, prevScrollTop: 3000, turns: 'empty' });
    p.clickAnswer();
    await flush();
    await flush();
    expect(p.formInView()).toBe(true);
  });

  it('a waiting session with no recorded conversation opens at the top of its form', () => {
    const p = page({ session: waitingMulti({ conversationId: undefined }), questionHeight: 900, prevScrollTop: 3000 });
    p.clickAnswer();
    expect(p.formInView()).toBe(true);
  });

  // Task view (T1.1 / T1.6; section tabs 2026-10-29): with no question the panel
  // lands with the section tabs in view — the top when the section box ends in
  // view — minimal or 자세히 alike: the newest turns are the box's own bottom.
  it.each([
    [false, 'the top'],
    [true, 'the top (자세히 too)'],
  ] as const)('a question answered before the turns arrive lands on %s instead', async (detail, _where) => {
    const p = page({ session: waitingMulti(), turns: 'held', detail, prevScrollTop: 3000 });
    p.clickAnswer();
    // The answer lands (here or in Slack): the WS session_update re-renders the panel question.
    p.cache[KEY] = waitingMulti({ activityState: 'working', pendingQuestion: undefined });
    p.m.renderPanelQuestion(p.cache[KEY]);
    p.release();
    await flush();
    await flush();
    expect(p.scroll.scrollTop).toBe(0);
    expect(p.m.section()).toBe('conv');
  });

  it.each([
    [false, 'the top'],
    [true, 'the top (자세히 too)'],
  ] as const)('an opening without an open question lands on %s, on 지시와 답변', async (detail, _where) => {
    const p = page({ session: waitingMulti({ activityState: 'idle', pendingQuestion: undefined }), detail });
    p.m.openPanel(KEY);
    await flush();
    await flush();
    expect(p.scroll.scrollTop).toBe(0);
    expect(p.m.section()).toBe('conv');
    expect(p.settled()).toBe('');
  });

  it('작업 로그 on a waiting session opens on the 작업 로그 tab (the top while its box fits, else the box brought into view)', async () => {
    const short = page({ session: waitingMulti(), questionHeight: 200 }); // 200 + tabs + box ends at 540 ≤ 600
    short.m.openPanel(KEY, true);
    await flush();
    await flush();
    expect(short.scroll.scrollTop).toBe(0);
    expect(short.m.section()).toBe('log');
    // A tall question: the section tabs go up toward the top — as far as the panel
    // scrolls, which leaves the whole box in view at its foot.
    const tall = page({ session: waitingMulti(), questionHeight: 900 });
    tall.m.openPanel(KEY, true);
    await flush();
    await flush();
    expect(tall.scroll.scrollTop).toBe(tall.bottom());
    expect(tall.scroll.scrollTop).toBeGreaterThan(0);
    expect(tall.m.section()).toBe('log');
  });
});
