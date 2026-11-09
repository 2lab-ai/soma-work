// Record a take of a web product: full Chromium on the GPU at device scale DSF, a CDP screencast that writes every
// frame the page paints (OUT/frames/*.jpg + OUT/frames.jsonl with the paint timestamp) and markers you place with
// mark() (OUT/markers.jsonl). cinematic-film's scripts/cut.py turns the take into CFR clips; make_gif.py into GIFs.
//
//   const { take } = require('./capture.cjs');
//   take({ out: 'take1', url: 'http://127.0.0.1:3000/dashboard', w: 1280, h: 720, dsf: 4,
//          cookies: [...],                  // the product's own login for the capture browser
//          init: [() => localStorage.setItem('theme', 'dark')],   // design / theme / view before first paint
//          perms: ['microphone'], micWav: 'voice/ask.wav' },      // a TTS take as the microphone (fakemic.cjs)
//        async ({ page, mark, sleep }) => {
//          mark('newtask'); await page.getByRole('button', { name: /New task/ }).click();
//          for (const ch of 'Summarize this repository') { await page.keyboard.type(ch); mark('key', { ch }); await sleep(90 + Math.random() * 90); }
//          mark('send'); await page.keyboard.press('Meta+Enter'); await sleep(6000);
//        });
//
// Needs Playwright with its Chromium (channel 'chromium' = full browser, GPU on). Run it from the project that has
// Playwright installed, or set PLAYWRIGHT_FROM=<a package.json path> to resolve Playwright from there.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const req = createRequire(process.env.PLAYWRIGHT_FROM || path.join(process.cwd(), 'package.json'));
const { chromium } = req('playwright');
const fakeMic = require('./fakemic.cjs');

async function take(o, script) {
  const out = o.out;
  const dsf = o.dsf || 4;
  fs.mkdirSync(path.join(out, 'frames'), { recursive: true });
  const fr = fs.createWriteStream(path.join(out, 'frames.jsonl'));
  const mk = fs.createWriteStream(path.join(out, 'markers.jsonl'));
  const mark = (name, extra = {}) => {
    mk.write(JSON.stringify({ ts: Date.now() / 1000, name, ...extra }) + '\n');
    console.log(new Date().toISOString(), name, JSON.stringify(extra));
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const browser = await chromium.launch({
    channel: 'chromium',
    args: [`--force-device-scale-factor=${dsf}`, '--use-angle=metal', '--enable-gpu-rasterization', '--ignore-gpu-blocklist',
      ...(o.micWav ? ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] : [])],
  });
  const ctx = await browser.newContext({ viewport: { width: o.w || 1280, height: o.h || 720 }, permissions: o.perms || [], bypassCSP: true });
  if (o.cookies) await ctx.addCookies(o.cookies);
  // headless Chromium paints only when asked: keep a requestAnimationFrame loop alive so the screencast gets frames
  await ctx.addInitScript(() => { const tick = () => requestAnimationFrame(tick); requestAnimationFrame(tick); });
  for (const fn of o.init || []) await ctx.addInitScript(fn);
  if (o.micWav) await fakeMic(ctx, o.micWav, o.micDelayMs ?? 1700);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  let n = 0;
  cdp.on('Page.screencastFrame', async (f) => {
    n++;
    const name = String(n).padStart(6, '0') + '.jpg';
    fs.writeFileSync(path.join(out, 'frames', name), Buffer.from(f.data, 'base64'));
    fr.write(JSON.stringify({ i: n, ts: f.metadata.timestamp, file: name }) + '\n');
    try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch {}
  });
  await page.goto(o.url, { waitUntil: 'networkidle' });
  await sleep(1500);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: (o.w || 1280) * dsf, maxHeight: (o.h || 720) * dsf, everyNthFrame: 1 });
  mark('rec-start');
  try {
    await script({ page, ctx, cdp, mark, sleep });
  } catch (e) {
    mark('fatal', { e: String(e).slice(0, 300) });
  }
  mark('rec-stop', { frames: n });
  await cdp.send('Page.stopScreencast').catch(() => {});
  await sleep(400);
  fr.end();
  mk.end();
  await browser.close();
}

module.exports = { take };
