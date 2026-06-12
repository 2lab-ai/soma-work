#!/usr/bin/env node
/**
 * Lottie JSON validator for the local:lottie skill.
 *
 * Loads the candidate animation into headless Chromium with pinned
 * lottie-web@5.13.0 (same engine the html skill's artifacts embed) and
 * reports whether it parses, how many frames/seconds it spans, and how many
 * SVG nodes it actually painted — a near-zero node count is the classic
 * "shapes not wrapped in a group" blank-render bug.
 *
 * Contract (CLI):
 *   node validate.mjs --input <lottie.json>
 *                     [--screenshot <out.png>] [--frame N] [--timeout 20000]
 *
 * stdout: single JSON object, e.g.
 *   { "ok": true, "frames": 120, "duration": 2, "size": { "w": 512, "h": 512 },
 *     "svgNodes": 14, "screenshot": "/abs/out.png" }
 *   { "ok": false, "error": "…parse/load failure…" }
 *
 * Exit codes: 0 ok, 1 CLI/input error, 2 validation failed / render error.
 */

import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const LOTTIE_CDN = 'https://cdn.jsdelivr.net/npm/lottie-web@5.13.0/build/player/lottie.min.js';

function parseArgs(argv) {
  const out = { timeout: 20000, frame: 0 };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input') out.input = argv[++i];
    else if (arg === '--screenshot') out.screenshot = argv[++i];
    else if (arg === '--frame') out.frame = Number(argv[++i]);
    else if (arg === '--timeout') out.timeout = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node validate.mjs --input <lottie.json> [--screenshot out.png] [--frame N] [--timeout ms]');
      process.exit(0);
    } else {
      console.error(`unknown arg: ${arg}`);
      process.exit(1);
    }
  }
  return out;
}

function fail(error) {
  console.log(JSON.stringify({ ok: false, error }));
  process.exit(2);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.input) {
    console.error('--input is required');
    process.exit(1);
  }
  const inputPath = isAbsolute(args.input) ? args.input : resolve(process.cwd(), args.input);
  if (!existsSync(inputPath)) {
    console.error(`input not found: ${inputPath}`);
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(readFileSync(inputPath, 'utf8'));
  } catch (err) {
    fail(`invalid JSON: ${err.message}`);
    return;
  }
  for (const field of ['v', 'fr', 'ip', 'op', 'w', 'h', 'layers']) {
    if (!(field in data)) fail(`missing required top-level field: "${field}"`);
  }
  if (!Array.isArray(data.layers) || data.layers.length === 0) {
    fail('layers must be a non-empty array');
  }

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    fail(`playwright is not installed: ${err.message}`);
    return;
  }

  const w = Number(data.w) || 512;
  const h = Number(data.h) || 512;
  const html = [
    '<!doctype html><html><head><meta charset="utf-8"></head>',
    `<body style="margin:0"><div id="anim" style="width:${w}px;height:${h}px"></div>`,
    `<script src="${LOTTIE_CDN}"><\/script>`,
    '<script>',
    `  const data = ${JSON.stringify(data)};`,
    '  try {',
    '    const anim = lottie.loadAnimation({',
    '      container: document.getElementById("anim"),',
    '      renderer: "svg", loop: false, autoplay: false, animationData: data',
    '    });',
    '    anim.addEventListener("DOMLoaded", () => {',
    `      anim.goToAndStop(${Number(args.frame) || 0}, true);`,
    '      window.__verdict = {',
    '        ok: true,',
    '        frames: anim.totalFrames,',
    '        duration: anim.getDuration(),',
    '        svgNodes: document.querySelectorAll("#anim svg *").length',
    '      };',
    '    });',
    '    anim.addEventListener("data_failed", () => { window.__verdict = { ok: false, error: "data_failed" }; });',
    '  } catch (err) { window.__verdict = { ok: false, error: String(err && err.message || err) }; }',
    '<\/script></body></html>',
  ].join('\n');

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await page.setContent(html, { waitUntil: 'networkidle', timeout: args.timeout });
    await page.waitForFunction(() => window.__verdict !== undefined, null, { timeout: args.timeout });
    const verdict = await page.evaluate(() => window.__verdict);

    if (!verdict.ok) {
      console.log(JSON.stringify({ ok: false, error: verdict.error, pageErrors }));
      process.exit(2);
    }

    const result = {
      ok: true,
      frames: verdict.frames,
      duration: verdict.duration,
      size: { w, h },
      svgNodes: verdict.svgNodes,
    };
    if (verdict.svgNodes < 2) {
      result.warning =
        'svgNodes < 2 — likely the blank-render gotcha: shape primitives must be wrapped in a "gr" group ending with a "tr" transform';
    }
    if (pageErrors.length > 0) result.pageErrors = pageErrors;

    if (args.screenshot) {
      const shot = isAbsolute(args.screenshot) ? args.screenshot : resolve(process.cwd(), args.screenshot);
      await page.locator('#anim').screenshot({ path: shot, type: 'png' });
      result.screenshot = shot;
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    fail(`render failed: ${err.message}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
