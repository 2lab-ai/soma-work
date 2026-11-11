// Phone-viewport takes for the device look: a real app in an iPhone-sized page (Playwright's iPhone 15 Pro: 393 css
// wide, touch, mobile UA) on the GPU at device scale 3, recorded as a screencast (frames + frames.jsonl) with markers
// (markers.jsonl: taps and swipes in css px, typed keys, viewport heights). scripts/cut_phone.py turns a take into
// 60 fps clips; the film draws the taps, the keyboard and Safari's bar from the markers.
//
//   const { open, recorder, tap, swipe, sleep } = require('<skill>/scripts/mobile_capture.cjs');
//   const { browser, ctx, page } = await open({ h: 716, cookies, initScripts });
//   const rec = await recorder(ctx, page, 'takes/c1'); await rec.start();
//   await tap(page, rec, page.getByPlaceholder('Search'), 'search');
//   rec.mark('kb-up'); await page.setViewportSize({ width: 393, height: 504 }); rec.mark('vp', { h: 504 });
//   for (const ch of '요약') { rec.mark('key', { ch }); await page.keyboard.type(ch); await sleep(300); }
//   await rec.stop(); await browser.close();
//
// Viewport heights (css): 716 = the page between the status bar (54) and Safari's compact bar (82); 504 = the page
// above the keyboard (294). Switch the height when the keyboard would open or close and mark it ('vp').
// Playwright: PLAYWRIGHT_FROM is a directory whose node_modules has playwright (default: the soma-work install's
// html skill renderer, `${CLAUDE_PLUGIN_ROOT}/skills/html/renderer/`).
const { createRequire } = require('module');
const fs = require('fs');
const path = require('path');
// Loaded when a browser opens, so the helpers below (maskResponses) load without it.
function playwright() {
  const fromDir = path.resolve(process.env.PLAYWRIGHT_FROM || path.join(process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..', '..', '..'), 'skills', 'html', 'renderer'));
  // createRequire takes a file path: anchor it inside the directory so its node_modules is searched
  return createRequire(path.join(fromDir, 'package.json'))('playwright');
}

async function open({ h = 716, dsf = 3, gpu = true, cookies = [], initScripts = [], args = [], permissions = [] } = {}) {
  const { chromium, devices } = playwright();
  const dev = devices['iPhone 15 Pro'];
  const a = gpu ? [...args, `--force-device-scale-factor=${dsf}`, '--use-angle=metal', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'] : args;
  const browser = await chromium.launch(gpu ? { args: a, channel: 'chromium' } : { args: a });
  try {
    // serviceWorkers 'block': a service worker would answer from its cache and skip maskResponses' route
    const ctx = await browser.newContext({ viewport: { width: 393, height: h }, deviceScaleFactor: gpu ? 1 : dsf, isMobile: true, hasTouch: true, userAgent: dev.userAgent, bypassCSP: true, permissions, serviceWorkers: 'block' });
    if (cookies.length) await ctx.addCookies(cookies);
    // a dark first paint and no tap highlight: both otherwise flash for a few frames a reviewer will catch. The init
    // script runs before the document has a root, so the style goes in the moment the root appears, not at DOMContentLoaded
    await ctx.addInitScript(() => {
      const add = () => {
        const root = document.head || document.documentElement;
        if (!root) return false;
        if (document.getElementById('cap-css')) return true;
        const st = document.createElement('style'); st.id = 'cap-css';
        st.textContent = '*{-webkit-tap-highlight-color:transparent!important}html{background:#000}';
        root.appendChild(st); return true;
      };
      if (!add()) new MutationObserver((_, o) => { if (add()) o.disconnect(); }).observe(document, { childList: true, subtree: true });
    });
    for (const s of initScripts) await ctx.addInitScript(s);
    const page = await ctx.newPage();
    return { browser, ctx, page };
  } catch (e) {
    await browser.close().catch(() => {}); // a failed setup leaves no Chromium behind
    throw e;
  }
}
async function recorder(ctx, page, OUT) {
  fs.mkdirSync(OUT + '/frames', { recursive: true });
  const fr = fs.createWriteStream(OUT + '/frames.jsonl'), mk = fs.createWriteStream(OUT + '/markers.jsonl');
  const cdp = await ctx.newCDPSession(page); let n = 0, closed = false;
  cdp.on('Page.screencastFrame', async (f) => {
    if (closed) return; // after stop: the frame log is already final
    n++; const name = String(n).padStart(6, '0') + '.jpg';
    fs.writeFileSync(`${OUT}/frames/${name}`, Buffer.from(f.data, 'base64'));
    fr.write(JSON.stringify({ i: n, ts: f.metadata.timestamp, file: name }) + '\n');
    try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch {}
  });
  const mark = (name, extra = {}) => mk.write(JSON.stringify({ ts: Date.now() / 1000, name, ...extra }) + '\n');
  return {
    mark,
    start: async () => { await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1179, maxHeight: 2400, everyNthFrame: 1 }); mark('rec-start'); },
    // a failed stop is a failed take: mark it and throw, so a cut never pads a broken take with its last frame
    stop: async () => {
      let err = null;
      try { await cdp.send('Page.stopScreencast'); } catch (e) { err = e; }
      await new Promise((r) => setTimeout(r, 400)); // the last frames in flight
      closed = true;
      await new Promise((r) => fr.end(r)); // the frame log is final before rec-stop says the take is complete
      mark(err ? 'rec-failed' : 'rec-stop', { frames: n, ...(err ? { e: String(err).slice(0, 200) } : {}) });
      await new Promise((r) => mk.end(r));
      if (err) throw err;
    },
  };
}
// A tap: the marker carries the element's centre (css), then a real touch tap. Use `what`, not `name`, for the label.
async function tap(page, rec, loc, what, opt = {}) {
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  const b = await loc.boundingBox(); if (!b) throw new Error('no box: ' + what);
  const x = b.x + (opt.dx ?? b.width / 2), y = b.y + (opt.dy ?? b.height / 2);
  rec.mark('tap', { what, x, y }); await page.waitForTimeout(90);
  await page.touchscreen.tap(x, y); return { x, y };
}
// A finger scroll: marker, then wheel steps over `dur` ms (dy > 0 scrolls the content up, the finger moves up).
async function swipe(page, rec, dy, { x = 196, y = 420, steps = 18, dur = 700 } = {}) {
  rec.mark('swipe', { x, y, dy }); await page.mouse.move(x, y);
  for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, dy / steps); await page.waitForTimeout(dur / steps); }
  rec.mark('swipe-end');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Rewrite text in API responses before the page sees them (e.g. emails -> aliases), so no frame can paint the real
// value. `match(url)` picks the requests. A response is buffered before it is rewritten, and a buffered stream never
// ends: streams must pass through. EventSource asks for text/event-stream and always passes; a fetch()-read stream
// (NDJSON, chunked text) may not ask, so name it with `stream(req)` as well, or keep it out of `match`. One that slips
// through fails loudly when its fetch times out (`timeout` ms), it does not hang the page silently. Same-origin
// redirects are followed here, so the final body is the one masked (the browser would not route the redirected request
// again); one to another origin is aborted, since this Node-side fetch could otherwise reach hosts the page cannot. The
// page keeps the first URL, so match API calls, not page navigations.
const asksForStream = (req) => /text\/event-stream|application\/x-ndjson/.test(req.headers()['accept'] || '');
async function maskResponses(ctx, match, rewrite, { stream = () => false, timeout = 15000 } = {}) {
  await ctx.route((u) => match(u), async (route) => {
    const req = route.request();
    if (asksForStream(req) || stream(req)) return route.continue();
    // never replay: the request already reached the server once; a failed fetch or rewrite aborts it (and says so)
    let res;
    try {
      res = await route.fetch({ timeout, maxRedirects: 0 });
      let url = req.url(), method = req.method();
      for (let hop = 0; res.status() >= 300 && res.status() < 400 && res.headers()['location']; hop++) {
        const st = res.status(), next = new URL(res.headers()['location'], url); // relative to this hop, not the first
        if (hop >= 5 || next.origin !== new URL(req.url()).origin) throw new Error(`redirect to ${next.origin} not followed`);
        await res.dispose?.();
        // as a browser does: 303 (and 301/302 after a POST) continue as a GET without the body; 307/308 keep both
        const toGet = (st === 303 && method !== 'HEAD') || ((st === 301 || st === 302) && method === 'POST');
        const headers = { ...req.headers() };
        if (toGet) { method = 'GET'; delete headers['content-type']; delete headers['content-length']; }
        res = await route.fetch({ url: next.href, method, headers, ...(toGet ? { postData: '' } : {}), timeout, maxRedirects: 0 });
        url = next.href;
      }
    } catch (e) {
      await res?.dispose?.();
      console.error('maskResponses: fetch failed (a stream? pass it through with stream(req)), request aborted:', req.url(), String(e));
      return route.abort('failed');
    }
    const ct = res.headers()['content-type'] || '';
    try {
      if (!/json|text/.test(ct)) return await route.fulfill({ response: res });
      let body;
      try { body = rewrite(await res.text()); } catch (e) { console.error('maskResponses: rewrite failed, request aborted:', req.url(), String(e)); return await route.abort('failed'); }
      return await route.fulfill({ response: res, body });
    } finally {
      await res.dispose?.(); // a long take routes thousands of responses: free each buffered body
    }
  });
}
module.exports = { open, recorder, tap, swipe, sleep, maskResponses };
