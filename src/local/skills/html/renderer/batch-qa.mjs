#!/usr/bin/env node
/**
 * batch-qa.mjs — hard QA gate for html batch mode output.
 *
 *   node batch-qa.mjs <out-dir> [--concurrency 4]
 *
 * Reads <out>/results.json (the expected set; for an `omd-*` run it is checked against the generated
 * oh-my-design index) and checks, before any browser starts, that the directory holds exactly those
 * pages (missing / extra / empty → exit 2). Pages are served over local HTTP. Per page in headless
 * Chromium:
 *   - loads without any console error or failed request;
 *   - the text of <main> equals the authored page's (results.page) — content preserved;
 *   - no horizontal overflow at 1440 px and 390 px;
 *   - every visible text element meets WCAG 1.4.3 against its real background
 *     (4.5:1, or 3:1 for ≥ 24 px / ≥ 18.66 px bold);
 *   - the face that drew the Korean text is a Hangul-capable face (CDP getPlatformFontsForNode);
 *   - every in-page #anchor points at an existing id.
 * Writes <out>/qa.json with each page's sha256 (batch.py ignores QA records for other bytes).
 * A browser that dies mid-run (load, OOM) is relaunched and the page is checked again, up to 3 times;
 * a page that never gets a clean browser fails — it is never skipped or passed.
 * Exit 0 only when every page passes; 1 when any page fails.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = resolve(process.argv[2] ?? '');
const ci = process.argv.indexOf('--concurrency');
const conc = ci > 0 ? Math.max(1, Number(process.argv[ci + 1]) || 4) : 4;
const resultsPath = join(out, 'results.json');
if (!process.argv[2] || !existsSync(resultsPath)) {
  console.error('usage: node batch-qa.mjs <out-dir>  (needs <out>/results.json from batch.py)');
  process.exit(2);
}
const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
const expected = results.references.map((r) => r.file);
if (expected.length === 0) {
  console.log('missing: (results.json lists no pages)');
  process.exit(2);
}
// The expected set is not taken on trust from batch.py: a full `omd-*` run must cover the whole
// generated oh-my-design index.
if (results.refs === 'omd-*' && results.omdIndex) {
  const want = JSON.parse(readFileSync(results.omdIndex, 'utf8')).references.map((r) => `${r.name}.html`);
  const gap = want.filter((f) => !expected.includes(f));
  if (gap.length || want.length !== expected.length) {
    console.log(`missing: ${gap.map((f) => f.replace(/\.html$/, '')).join(', ') || '(count differs from the index)'}`);
    process.exit(2);
  }
}
const present = readdirSync(out).filter((f) => f.endsWith('.html') && f !== 'index.html');
const missing = expected.filter((f) => !present.includes(f));
const extra = present.filter((f) => !expected.includes(f));
if (missing.length || extra.length) {
  if (missing.length) console.log(`missing: ${missing.map((f) => f.replace(/\.html$/, '')).join(', ')}`);
  if (extra.length) console.log(`extra: ${extra.join(', ')}`);
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
let chromium;
try {
  ({ chromium } = createRequire(`${here}/`)('playwright'));
} catch {
  ({ chromium } = await import('playwright'));
}

// Serve the batch over local HTTP: file:// pages make Chromium's CDP probes re-request the page as an
// "unsafe" file load, which would be tool noise. Over HTTP every console error and failed request counts.
const server = createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const path = url === '/__template__.html' ? results.page : join(out, url.replace(/^\/+/, ''));
  if (!path || (url !== '/__template__.html' && !resolve(path).startsWith(out)) || !existsSync(path)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(path));
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;

const HANGUL_FACE =
  /Pretendard|Noto (Sans|Serif) (KR|CJK)|Apple SD Gothic|AppleMyungjo|Nanum|Spoqa|SUIT|IBM Plex Sans KR|Malgun|Source Han|Gmarket|Wanted Sans|Gothic A1|Black Han|Do Hyeon|Jua|Gowun|Hahmlet/i;

// One shared browser; when it dies every worker waits on the same relaunch.
let browser = null;
let launching = null;
async function liveBrowser() {
  if (browser?.isConnected()) return browser;
  if (!launching) {
    launching = chromium
      .launch({ headless: true })
      .then((b) => {
        browser = b;
        return b;
      })
      .finally(() => {
        launching = null;
      });
  }
  return launching;
}
const BROWSER_GONE = /Target crashed|Target page, context or browser has been closed|Browser has been closed|Failed to find context/;

async function checkPage(file) {
  const b = await liveBrowser();
  const problems = [];
  let mainText = '';
  let fontsUsed = [];
  let ctx;
  try {
    ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 80)}`);
    });
    page.on('requestfailed', (r) => problems.push(`request failed: ${r.url().slice(0, 80)}`));
    await page.goto(`${base}/${file}`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.evaluate(() => document.fonts.ready);
    const info = await page.evaluate(() => {
      const rgba = (s) => (s.match(/[\d.]+/g) || []).map(Number);
      const lum = ([r, g, b]) => {
        const c = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
      };
      const ratio = (a, b) => {
        const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
        return (x + 0.05) / (y + 0.05);
      };
      const over = (fg, bg) => {
        const a = fg[3] ?? 1;
        return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
      };
      const bgOf = (el) => {
        const stack = [];
        for (let e = el; e; e = e.parentElement) stack.push(rgba(getComputedStyle(e).backgroundColor));
        let bg = [255, 255, 255];
        for (const c of stack.reverse()) if ((c[3] ?? 1) > 0) bg = over(c, bg);
        return bg;
      };
      const fails = [];
      let checked = 0;
      for (const el of document.querySelectorAll('body *')) {
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!own) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || el.getClientRects().length === 0) continue;
        const bg = bgOf(el);
        const fg = over(rgba(cs.color), bg);
        const size = parseFloat(cs.fontSize);
        const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
        const r = ratio(fg, bg);
        checked++;
        if (r < (large ? 3 : 4.5)) fails.push(`${el.tagName.toLowerCase()}.${el.className || ''} ${r.toFixed(2)}:1 @${size}px`);
      }
      const ids = new Set([...document.querySelectorAll('[id]')].map((e) => e.id));
      const deadLinks = [...document.querySelectorAll('a[href^="#"]')]
        .map((a) => a.getAttribute('href').slice(1))
        .filter((h) => h && !ids.has(h));
      return {
        main: (document.querySelector('main')?.innerText ?? '').replace(/\s+/g, ' ').trim(),
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        contrastFails: fails.slice(0, 3),
        contrastFailCount: fails.length,
        checked,
        deadLinks,
      };
    });
    mainText = info.main;
    if (!mainText) problems.push('empty <main>');
    if (info.overflow > 1) problems.push(`overflow ${info.overflow}px @1440`);
    if (info.contrastFailCount) problems.push(`contrast ×${info.contrastFailCount}: ${info.contrastFails.join(' | ')}`);
    if (info.deadLinks.length) problems.push(`dead anchors: ${info.deadLinks.join(', ')}`);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const names = new Set();
    for (const sel of ['h1', 'main p', 'main td', 'main li']) {
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
      if (!nodeId) continue;
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      for (const f of fonts) names.add(f.familyName);
    }
    fontsUsed = [...names].sort();
    if (!fontsUsed.some((n) => HANGUL_FACE.test(n))) problems.push(`no Hangul face drew the text (${fontsUsed.join(', ')})`);
    await page.setViewportSize({ width: 390, height: 844 });
    const ov = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (ov > 1) problems.push(`overflow ${ov}px @390`);
  } catch (e) {
    const msg = String(e.message).slice(0, 100);
    // The browser, not the page, failed: report it so the caller relaunches and checks again.
    if (!b.isConnected() || BROWSER_GONE.test(msg)) return { crashed: msg };
    problems.push(`load: ${msg}`);
  } finally {
    if (ctx && b.isConnected()) {
      await ctx.close().catch((e) => {
        if (b.isConnected()) problems.push(`context close: ${String(e.message).slice(0, 80)}`);
      });
    }
  }
  const pageSha = createHash('sha256').update(readFileSync(join(out, file))).digest('hex');
  return { name: file.replace(/\.html$/, ''), file, page_sha256: pageSha, ok: problems.length === 0, problems, fontsUsed, mainText };
}

const pages = [];
let next = 0;
await Promise.all(
  Array.from({ length: conc }, async () => {
    while (next < expected.length) {
      const file = expected[next++];
      for (let attempt = 1; ; attempt++) {
        const r = await checkPage(file);
        if (!r.crashed) {
          pages.push(r);
          break;
        }
        console.log(`browser lost on ${file} (attempt ${attempt}/3): ${r.crashed}`);
        if (attempt === 3) {
          const pageSha = createHash('sha256').update(readFileSync(join(out, file))).digest('hex');
          pages.push({
            name: file.replace(/\.html$/, ''),
            file,
            page_sha256: pageSha,
            ok: false,
            problems: [`browser lost 3 times while checking: ${r.crashed}`],
            fontsUsed: [],
            mainText: '',
          });
          break;
        }
      }
      if (pages.length % 50 === 0) console.log(`${pages.length}/${expected.length}`);
    }
  }),
);

// Content preservation: every page's <main> text must equal the authored page's, taken from the
// template itself (not from the pages under test).
let canonical = '';
if (results.page && existsSync(results.page)) {
  const ctx = await (await liveBrowser()).newContext();
  const tp = await ctx.newPage();
  await tp.goto(`${base}/__template__.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  canonical = (await tp.evaluate(() => document.querySelector('main')?.innerText ?? '')).replace(/\s+/g, ' ').trim();
  await ctx.close();
}
for (const p of pages) {
  if (!canonical) {
    p.ok = false;
    p.problems.push('no authored page to compare <main> text against (results.page)');
  } else if (p.mainText !== canonical) {
    p.ok = false;
    p.problems.push('main text differs from the authored page');
  }
  delete p.mainText;
}
const order = new Map(expected.map((f, i) => [f, i]));
pages.sort((a, b) => order.get(a.file) - order.get(b.file));
await browser?.close();
server.close();
const failed = pages.filter((p) => !p.ok);
writeFileSync(
  join(out, 'qa.json'),
  JSON.stringify({ checked: pages.length, passed: pages.length - failed.length, pages }, null, 1),
);
console.log(`checked ${pages.length}, passed ${pages.length - failed.length}, failed ${failed.length}`);
for (const f of failed.slice(0, 25)) console.log(`FAIL ${f.name}: ${f.problems.join('; ')}`);
process.exit(failed.length ? 1 : 0);
