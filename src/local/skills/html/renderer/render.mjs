#!/usr/bin/env node
/**
 * HTML → PNG renderer for the local:html skill.
 *
 * Contract (CLI):
 *   node render.mjs --input <html-path> --output <png-path>
 *                   [--width 1200] [--height 1600] [--full-page]
 *                   [--selector body] [--device-scale-factor 1]
 *                   [--wait-ms 500] [--template <name>]
 *
 * Precedence for geometry: CLI args > --template entry in templates/index.json
 *   > built-in default (1200 × 1600, fullPage=true, deviceScaleFactor=1).
 *
 * The renderer expects a single, self-contained HTML file (CDN refs are OK
 * — Tailwind / Google Fonts / inline scripts all work). Headless Chromium
 * waits for `networkidle` before screenshotting, so externally-fetched
 * fonts have time to load.
 *
 * Exit codes:
 *   0  PNG written
 *   1  CLI / input error
 *   2  Playwright launch / render failure
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, '..');
const INDEX_JSON = resolve(SKILL_ROOT, 'templates', 'index.json');

function parseArgs(argv) {
  const out = { fullPage: undefined, waitMs: 500 };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input') out.input = argv[++i];
    else if (arg === '--output') out.output = argv[++i];
    else if (arg === '--width') out.width = Number(argv[++i]);
    else if (arg === '--height') out.height = Number(argv[++i]);
    else if (arg === '--full-page') out.fullPage = true;
    else if (arg === '--no-full-page') out.fullPage = false;
    else if (arg === '--selector') out.selector = argv[++i];
    else if (arg === '--device-scale-factor') out.deviceScaleFactor = Number(argv[++i]);
    else if (arg === '--wait-ms') out.waitMs = Number(argv[++i]);
    else if (arg === '--template') out.template = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`unknown arg: ${arg}`);
      process.exit(1);
    }
  }
  return out;
}

function printHelp() {
  console.log(
    'Usage: node render.mjs --input <html> --output <png> [--width N] [--height N]' +
      ' [--full-page] [--no-full-page] [--selector S] [--device-scale-factor N]' +
      ' [--wait-ms N] [--template NAME]',
  );
}

function loadTemplateViewport(templateName) {
  if (!templateName) return null;
  if (!existsSync(INDEX_JSON)) return null;
  try {
    const idx = JSON.parse(readFileSync(INDEX_JSON, 'utf8'));
    const entry = (idx.templates ?? []).find((t) => t.name === templateName);
    return entry?.viewport ?? null;
  } catch (err) {
    console.error(`templates/index.json parse error: ${err.message}`);
    return null;
  }
}

function resolveGeometry(args) {
  const defaults = { width: 1200, height: 1600, fullPage: true, deviceScaleFactor: 1, selector: 'body' };
  const tpl = loadTemplateViewport(args.template) ?? {};
  return {
    width: args.width ?? tpl.width ?? defaults.width,
    height: args.height ?? tpl.height ?? defaults.height,
    fullPage: args.fullPage ?? tpl.fullPage ?? defaults.fullPage,
    deviceScaleFactor: args.deviceScaleFactor ?? tpl.deviceScaleFactor ?? defaults.deviceScaleFactor,
    selector: args.selector ?? tpl.selector ?? defaults.selector,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.input || !args.output) {
    console.error('--input and --output are required');
    printHelp();
    process.exit(1);
  }
  const inputPath = isAbsolute(args.input) ? args.input : resolve(process.cwd(), args.input);
  const outputPath = isAbsolute(args.output) ? args.output : resolve(process.cwd(), args.output);
  if (!existsSync(inputPath)) {
    console.error(`input not found: ${inputPath}`);
    process.exit(1);
  }

  const geom = resolveGeometry(args);

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    console.error('playwright is not installed. add to dependencies: npm install playwright');
    console.error(err.message);
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: geom.width, height: geom.height },
      deviceScaleFactor: geom.deviceScaleFactor,
    });
    const page = await context.newPage();
    const url = pathToFileURL(inputPath).toString();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    if (geom.waitMs > 0 || args.waitMs > 0) {
      await page.waitForTimeout(args.waitMs ?? 500);
    }

    if (geom.fullPage) {
      await page.screenshot({ path: outputPath, fullPage: true, type: 'png' });
    } else {
      // Clipped screenshot of a named selector — used for fixed-canvas
      // surfaces like decks (1920×1080) and social cards (1600×900) where
      // fullPage would capture chrome/whitespace below the artifact.
      const target = page.locator(geom.selector).first();
      try {
        await target.waitFor({ state: 'visible', timeout: 5000 });
        await target.screenshot({ path: outputPath, type: 'png' });
      } catch {
        // Fallback to viewport screenshot if selector miss — better than
        // failing outright on a layout the agent slightly mistyped.
        console.error(`selector "${geom.selector}" not found; falling back to viewport screenshot`);
        await page.screenshot({ path: outputPath, fullPage: false, type: 'png' });
      }
    }
    console.log(`PNG written: ${outputPath} (${geom.width}x${geom.height}, fullPage=${geom.fullPage})`);
  } catch (err) {
    console.error(`render failed: ${err.message}`);
    process.exit(2);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
