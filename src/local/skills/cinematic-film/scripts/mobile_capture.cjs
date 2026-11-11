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
const fromDir = path.resolve(process.env.PLAYWRIGHT_FROM || path.join(process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..', '..', '..'), 'skills', 'html', 'renderer'));
// createRequire takes a file path: anchor it inside the directory so its node_modules is searched
const { chromium, devices } = createRequire(path.join(fromDir, 'package.json'))('playwright');

async function open({ h = 716, dsf = 3, gpu = true, cookies = [], initScripts = [], args = [], permissions = [] } = {}) {
  const dev = devices['iPhone 15 Pro'];
  const a = gpu ? [...args, `--force-device-scale-factor=${dsf}`, '--use-angle=metal', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'] : args;
  const browser = await chromium.launch(gpu ? { args: a, channel: 'chromium' } : { args: a });
  const ctx = await browser.newContext({ viewport: { width: 393, height: h }, deviceScaleFactor: gpu ? 1 : dsf, isMobile: true, hasTouch: true, userAgent: dev.userAgent, bypassCSP: true, permissions });
  if (cookies.length) await ctx.addCookies(cookies);
  // a dark first paint and no tap highlight: both otherwise flash for a few frames a reviewer will catch
  await ctx.addInitScript(() => {
    const add = () => {
      const root = document.head || document.documentElement;
      if (!root || document.getElementById('cap-css')) return;
      const st = document.createElement('style'); st.id = 'cap-css';
      st.textContent = '*{-webkit-tap-highlight-color:transparent!important}html{background:#000}';
      root.appendChild(st);
    };
    document.addEventListener('DOMContentLoaded', add); add();
  });
  for (const s of initScripts) await ctx.addInitScript(s);
  const page = await ctx.newPage();
  return { browser, ctx, page };
}
async function recorder(ctx, page, OUT) {
  fs.mkdirSync(OUT + '/frames', { recursive: true });
  const fr = fs.createWriteStream(OUT + '/frames.jsonl'), mk = fs.createWriteStream(OUT + '/markers.jsonl');
  const cdp = await ctx.newCDPSession(page); let n = 0;
  cdp.on('Page.screencastFrame', async (f) => {
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
      mark(err ? 'rec-failed' : 'rec-stop', { frames: n, ...(err ? { e: String(err).slice(0, 200) } : {}) });
      await new Promise((r) => setTimeout(r, 400)); fr.end(); mk.end();
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
// value. `match(url)` picks the requests; event streams pass through untouched (a buffered stream never ends).
async function maskResponses(ctx, match, rewrite) {
  await ctx.route((u) => match(u), async (route) => {
    const req = route.request();
    if ((req.headers()['accept'] || '').includes('text/event-stream')) return route.continue();
    // never replay: the request already reached the server once; a failed rewrite aborts it (and says so)
    let res;
    try { res = await route.fetch(); } catch (e) { return route.abort('failed'); }
    const ct = res.headers()['content-type'] || '';
    if (!/json|text/.test(ct)) return route.fulfill({ response: res });
    try { return route.fulfill({ response: res, body: rewrite(await res.text()) }); } catch (e) { console.error('maskResponses: rewrite failed, request aborted:', req.url(), String(e)); return route.abort('failed'); }
  });
}
module.exports = { open, recorder, tap, swipe, sleep, maskResponses };
