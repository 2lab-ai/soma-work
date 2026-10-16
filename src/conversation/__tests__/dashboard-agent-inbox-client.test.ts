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
    ['WL_BACKFILL_MAX_PAGES'],
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

describe('work-log entry rendering escapes hostile text (shipped renderWorkLogEntry + esc)', () => {
  const { renderWorkLogEntry } = load<{ renderWorkLogEntry(e: unknown): string }>(
    ['decodeSlackEntities', 'esc', 'escAttr', 'renderWorkLogEntry'],
    ['WL_LABELS'],
  );
  /** Every " left after removing the attributes we emit would be an attribute break-out. */
  const strayQuotes = (html: string) => html.replace(/\s(class|title|data-seq)="[^"]*"/g, '').includes('"');
  const tags = (html: string) =>
    (html.match(/<\/?([a-z0-9]+)/gi) ?? []).map((t) => t.replace(/[</]/g, '').toLowerCase());

  it('tool name and text cannot inject markup or break out of the title attribute', () => {
    const html = renderWorkLogEntry({
      seq: 1,
      ts: 0,
      kind: 'tool',
      tool: '<img src=x onerror=alert(1)>',
      text: '"><script>alert(1)</script><a href="javascript:x">',
    });
    expect(new Set(tags(html))).toEqual(new Set(['div', 'span']));
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('title="&quot;&gt;&lt;script&gt;');
    expect(strayQuotes(html)).toBe(false);
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
});

describe('work-log tool rows print the tool name once (shipped renderWorkLogEntry)', () => {
  const { renderWorkLogEntry } = load<{ renderWorkLogEntry(e: unknown): string }>(
    ['decodeSlackEntities', 'esc', 'escAttr', 'renderWorkLogEntry'],
    ['WL_LABELS'],
  );
  /** The visible pieces of a tool row: the tool-name span, the text span and its title. */
  function row(e: Record<string, unknown>) {
    const html = renderWorkLogEntry({ seq: 1, ts: 0, ...e });
    const name = /<span class="wl-tool-name">([^<]*)<\/span>/.exec(html)?.[1] ?? null;
    const m = /<span class="wl-text" title="([^"]*)">([^<]*)<\/span>/.exec(html);
    return { name, text: m?.[2] ?? null, title: m?.[1] ?? null };
  }

  // Stored entries carry the emitter's shape: `text` starts with the tool name
  // (packages/slack/src/stream-processor.ts summarizeToolCall and the tool_result text).
  it('a tool call shows its input after the name, not the name again', () => {
    expect(row({ kind: 'tool', tool: 'Read', text: 'Read {"file_path":"/a.ts"}' })).toEqual({
      name: 'Read',
      text: '{&quot;file_path&quot;:&quot;/a.ts&quot;}',
      title: 'Read {&quot;file_path&quot;:&quot;/a.ts&quot;}',
    });
  });

  it('a tool result shows ok / error after the name', () => {
    expect(row({ kind: 'tool_result', tool: 'Glob', ok: true, text: 'Glob ok' })).toEqual({
      name: 'Glob',
      text: 'ok',
      title: 'Glob ok',
    });
    expect(row({ kind: 'tool_result', tool: 'Bash', ok: false, text: 'Bash error' })).toEqual({
      name: 'Bash',
      text: 'error',
      title: 'Bash error',
    });
  });

  it('a call without input (text is just the name) shows the name once', () => {
    expect(row({ kind: 'tool', tool: 'TodoRead', text: 'TodoRead' })).toEqual({
      name: 'TodoRead',
      text: '',
      title: 'TodoRead',
    });
  });

  it('text that does not start with "<tool> " is shown whole', () => {
    expect(row({ kind: 'tool', tool: 'Read', text: 'Readme.md opened' }).text).toBe('Readme.md opened');
    expect(row({ kind: 'tool', tool: 'Bash', text: 'backfill step 3' }).text).toBe('backfill step 3');
    expect(row({ kind: 'tool', text: 'Read {"a":1}' })).toEqual({
      name: null,
      text: 'Read {&quot;a&quot;:1}',
      title: 'Read {&quot;a&quot;:1}',
    });
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
      _cardEls: Object.create(null),
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
      env._cardEls[key] = { _cid: cid };
      env._expanded.add(key);
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
      h.io.ensureCardIo('kc', false); // reconcileBoard on every push
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
    h.io.ensureCardIo('k2', true); // toggleCard(open) passes force
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
    delete h.env._cardEls.ky; // ky left the board
    h.io.releaseCardIoTimer('cx');
    expect(h.pendingTimers()).toEqual([]);
    const n = h.fetchCalls.length;
    await h.advance(60_000);
    expect(h.fetchCalls).toHaveLength(n);
  });

  it.each<[string, (h: ReturnType<typeof harness>) => void]>([
    ['closed', (h) => h.env._expanded.delete('kd')],
    ['removed from the board', (h) => delete h.env._cardEls.kd],
  ])('a request that fails after its last card was %s arms no retry timer', async (_how, goAway) => {
    const h = harness();
    h.addCard('kd', 'cd');
    const inFlight = h.hold();
    h.io.ensureCardIo('kd', true); // the opening fetch is in flight
    await flush();
    goAway(h);
    h.io.releaseCardIoTimer('cd'); // what toggleCard / applyBoardPlan do; nothing is pending yet
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
      h.io.ensureCardIo('ko', false); // reconcileBoard on a board push
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

describe('model-controlled values in card markup (shipped renderers)', () => {
  const cards = load<{
    renderTimeline(s: unknown): string;
    renderCardStatus(s: unknown, col: string): string;
  }>(['esc', 'formatDuration', 'renderTimeline', 'renderCardStatus'], ['WAIT_SVG'], {
    dhShow: () => true,
    dhMax: (_f: string, d: number) => d,
  });
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

  it('timer data attributes on the status line are always plain numbers', () => {
    for (const bad of HOSTILE) {
      const html = cards.renderCardStatus({ activeLegStartedAtMs: bad, activeAccumulatedMs: bad }, 'working');
      expect(html).not.toMatch(/onerror|onmouseover|<img/);
      expect(html).toMatch(/data-leg-started="\d+" data-accumulated="\d+"/);
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
      generateTitleSub(convId: string): Promise<void>;
      switchPanel(): void;
    }>(
      ['generateTitleSub'],
      ['_panelGen'],
      {
        document: { getElementById: (id: string) => (id === 'panel-title-sub-text' ? textEl : btn) },
        fetch: fetchStub,
        _csrfToken: 't',
        refreshCsrfToken: async () => {
          csrfRefreshes++;
        },
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

  it('the current panel still gets its subtitle (and its 403 retry)', async () => {
    const h = harness();
    let n = 0;
    h.answers['conv-a'] = () => (++n === 1 ? { status: 403, json: async () => ({}) } : h.ok('A subtitle'));
    await h.io.generateTitleSub('conv-a');
    expect(h.posts).toHaveLength(2);
    expect(h.csrfRefreshes()).toBe(1);
    expect(h.textEl.textContent).toBe('A subtitle');
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
  }
});
