#!/usr/bin/env node
// polishing-ui audit — measures a rendered page against the numbers in reference/apple-metrics.md.
//
//   node audit.mjs <url> [--preset desktop|mobile|both] [--engine chromium|webkit] [--out <dir>]
//                        [--cookie name=value] [--storage key=value] [--theme light|dark]
//                        [--click <css>] [--wait <ms>] [--scope <css>] [--full]
//
// It opens the page in each preset, walks the whole DOM including open shadow roots, and prints one
// markdown table per preset: check, count, worst offenders. report.json and screenshots go to --out.
// It never edits anything. Thresholds live in THRESHOLDS below and must match reference/apple-metrics.md.

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

// Numbers from reference/apple-metrics.md. Change both together.
const THRESHOLDS = {
  desktop: {
    viewport: { width: 1440, height: 900 },
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 2,
    targetMin: 24, // WCAG 2.2 SC 2.5.8 (AA), CSS px
    targetPlatform: 28, // HIG macOS default control size, pt
    fontMin: 10, // HIG macOS smallest text style (Caption 1/2, Footnote), pt
    inputMinFont: 0, // no zoom-on-focus on desktop
  },
  mobile: {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    targetMin: 24,
    targetPlatform: 44, // HIG iOS/iPadOS default control size, pt
    fontMin: 11, // HIG iOS smallest text style (Caption 2), pt
    inputMinFont: 16, // iOS Safari zooms into a focused field whose text is smaller than 16px
  },
  contrastText: 4.5, // WCAG 1.4.3 AA, normal text
  contrastLarge: 3, // WCAG 1.4.3 AA, large text (>= 24px, or >= 18.66px bold)
  cornerTolerance: 2, // px a corner element may differ between its two edge distances
  radiusTolerance: 2, // px a nested radius may differ from outer radius - inset
  lineChars: 90, // characters per line above which a paragraph reads long (45-75 is the usual band)
};

function parseArgs(argv) {
  const out = { url: '', preset: 'both', engine: 'chromium', out: '', cookies: [], storage: [], theme: '', clicks: [], wait: 800, scope: '', full: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--preset') out.preset = next();
    else if (a === '--engine') out.engine = next();
    else if (a === '--out') out.out = next();
    else if (a === '--cookie') out.cookies.push(next());
    else if (a === '--storage') out.storage.push(next());
    else if (a === '--theme') out.theme = next();
    else if (a === '--click') out.clicks.push(next());
    else if (a === '--wait') out.wait = Number(next());
    else if (a === '--scope') out.scope = next();
    else if (a === '--full') out.full = true;
    else if (!a.startsWith('--') && !out.url) out.url = a;
  }
  if (!out.url) {
    console.error('usage: node audit.mjs <url> [--preset desktop|mobile|both] [--engine chromium|webkit] [--out dir] [--cookie k=v] [--storage k=v] [--theme light|dark] [--click css] [--wait ms] [--scope css] [--full]');
    process.exit(2);
  }
  if (!out.out) out.out = resolve(process.cwd(), 'polish-audit');
  return out;
}

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    // Run from outside an install: resolve from the current directory (a repo that has playwright).
    try {
      return createRequire(join(process.cwd(), 'package.json'))('playwright');
    } catch {
      console.error('playwright not found: run from a directory whose node_modules has playwright, or install it.');
      process.exit(2);
    }
  }
}

// Runs inside the page. Must be self-contained.
function measure(cfg) {
  const T = cfg.t;
  const scopeRoot = cfg.scope ? document.querySelector(cfg.scope) : document.documentElement;
  const results = { overflowX: null, target: [], fontMin: [], inputZoom: [], hairline: [], corner: [], radius: [], contrast: [], lineLength: [], name: [], rowHeight: [], fontSizes: {} };

  const all = [];
  (function walk(root) {
    for (const el of root.querySelectorAll('*')) {
      all.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  })(scopeRoot && scopeRoot.shadowRoot ? scopeRoot.shadowRoot : scopeRoot || document);
  if (scopeRoot && scopeRoot !== document.documentElement) all.unshift(scopeRoot);

  const vw = innerWidth;
  const vh = innerHeight;
  const cs = new Map();
  const style = (el) => {
    let s = cs.get(el);
    if (!s) cs.set(el, (s = getComputedStyle(el)));
    return s;
  };
  const px = (v) => parseFloat(v) || 0;
  const visible = (el) => {
    const s = style(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || px(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (el.closest('[inert],[hidden],[aria-hidden="true"]')) return false;
    return r.bottom > 0 && r.right > 0 && r.top < (cfg.full ? Infinity : vh * 3) && r.left < vw;
  };
  const host = (el) => {
    const root = el.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };
  const label = (el) => {
    const one = (e) => {
      let s = e.localName;
      if (e.id) return `${s}#${e.id}`;
      const cls = typeof e.className === 'string' ? e.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
      if (cls.length) s += '.' + cls.join('.');
      return s;
    };
    const parts = [];
    let e = el;
    for (let i = 0; e && i < 3; i++) {
      parts.unshift(one(e));
      if (e.id) break;
      e = e.parentElement;
    }
    const h = host(el);
    return (h ? label(h) + ' >>> ' : '') + parts.join(' > ');
  };
  const round = (n) => Math.round(n * 10) / 10;

  // 1. Horizontal overflow (the page scrolls sideways).
  const sw = document.documentElement.scrollWidth;
  results.overflowX = sw > vw + 1 ? { scrollWidth: sw, viewport: vw } : null;

  // 2. Hit targets.
  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=switch],[role=checkbox],[role=radio],[role=menuitem],[role=option],[tabindex]:not([tabindex="-1"])';
  const targets = all.filter((el) => el.matches(INTERACTIVE) && visible(el) && !el.disabled && !el.closest('[disabled]'));
  // A target nested in another target is one target (the outer one is what the finger hits).
  const outer = targets.filter((el) => !targets.some((o) => o !== el && o.contains(el)));
  // The hit area: the box, grown by an absolutely placed ::before/::after with negative insets (a common way to give a
  // small control a 44px target without changing its look).
  const hitRect = (el) => {
    const r = el.getBoundingClientRect();
    const box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    if (style(el).position === 'static') return box;
    for (const pseudo of ['::before', '::after']) {
      const p = getComputedStyle(el, pseudo);
      if (!p || p.content === 'none' || p.content === 'normal' || p.position !== 'absolute' || p.pointerEvents === 'none') continue;
      const v = (s) => (/px$/.test(s) ? parseFloat(s) : null);
      const [t, ri, b, l] = [v(p.top), v(p.right), v(p.bottom), v(p.left)];
      if (t !== null && b !== null) {
        box.top = Math.min(box.top, r.top + t);
        box.bottom = Math.max(box.bottom, r.bottom - b);
      }
      if (l !== null && ri !== null) {
        box.left = Math.min(box.left, r.left + l);
        box.right = Math.max(box.right, r.right - ri);
      }
    }
    return box;
  };
  const rects = outer.map((el) => {
    const b = hitRect(el);
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.right - b.left, height: b.bottom - b.top };
  });
  const inlineLink = (el) => el.localName === 'a' && style(el).display === 'inline' && el.parentElement && /\S/.test((el.parentElement.textContent || '').replace(el.textContent || '', ''));
  outer.forEach((el, i) => {
    const r = rects[i];
    const w = r.width;
    const h = r.height;
    if (Math.min(w, h) >= T.targetPlatform) return;
    if (inlineLink(el)) return; // WCAG 2.5.8 inline exception
    // WCAG 2.5.8 spacing exception: a 24px circle on the centre touches no other target.
    const cx = r.left + w / 2;
    const cy = r.top + h / 2;
    const spaced = rects.every((o, j) => {
      if (j === i) return true;
      const dx = Math.max(o.left - cx, 0, cx - o.right);
      const dy = Math.max(o.top - cy, 0, cy - o.bottom);
      return Math.hypot(dx, dy) >= T.targetMin / 2;
    });
    const level = Math.min(w, h) < T.targetMin && !spaced ? 'red' : 'amber';
    results.target.push({ level, el: label(el), w: round(w), h: round(h), need: Math.min(w, h) < T.targetMin ? T.targetMin : T.targetPlatform });
  });

  // 3. Text: minimum size, the size spread, line length, contrast.
  const parseColor = (c) => {
    const m = c && c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
  const lum = (c) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const backdrop = (el) => {
    // Composite solid backgrounds from the element up; give up on images and gradients.
    const layers = [];
    for (let e = el; e; e = e.parentElement || host(e)) {
      const s = style(e);
      if (s.backgroundImage && s.backgroundImage !== 'none') return null;
      const c = parseColor(s.backgroundColor);
      if (c && c.a > 0) {
        layers.push(c);
        if (c.a >= 1) break;
      }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    const rootBg = parseColor(getComputedStyle(document.documentElement).backgroundColor);
    if (rootBg && rootBg.a > 0) base = over(rootBg, base);
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return base;
  };
  const textEls = all.filter((el) => visible(el) && [...el.childNodes].some((n) => n.nodeType === 3 && /\S/.test(n.data)));
  for (const el of textEls) {
    const s = style(el);
    const size = px(s.fontSize);
    const key = String(round(size));
    results.fontSizes[key] = (results.fontSizes[key] || 0) + 1;
    if (size < T.fontMin) results.fontMin.push({ level: 'red', el: label(el), size: round(size), text: el.textContent.trim().slice(0, 40) });
    const fg = parseColor(s.color);
    const bg = backdrop(el);
    if (fg && bg && !el.closest('[disabled],[aria-disabled="true"]')) {
      const r = ratio(over({ ...fg, a: fg.a * (px(s.opacity) || 1) }, bg), bg);
      const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
      const need = large ? T.contrastLarge : T.contrastText;
      if (r < need) results.contrast.push({ level: r < 3 ? 'red' : 'amber', el: label(el), ratio: round(r), need, text: el.textContent.trim().slice(0, 40) });
    }
    const lh = px(s.lineHeight) || size * 1.2;
    const h = el.getBoundingClientRect().height;
    const lines = Math.round(h / lh);
    const chars = (el.textContent || '').trim().length;
    if (lines >= 2 && chars / lines > T.lineChars && s.whiteSpace !== 'pre' && !/mono|code/i.test(s.fontFamily)) {
      results.lineLength.push({ level: 'amber', el: label(el), charsPerLine: Math.round(chars / lines), lines });
    }
  }

  // 4. Inputs that make iOS Safari zoom in on focus.
  if (T.inputMinFont) {
    for (const el of all) {
      if (!el.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=hidden]),textarea,select,[contenteditable=""],[contenteditable=true]') || !visible(el)) continue;
      const size = px(style(el).fontSize);
      if (size < T.inputMinFont) results.inputZoom.push({ level: 'red', el: label(el), size: round(size) });
    }
  }

  // 5. Hairline edges (thinner than 1 CSS px).
  for (const el of all) {
    if (!visible(el)) continue;
    const s = style(el);
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      const w = px(s[`border${side}Width`]);
      if (w > 0 && w < 1 && s[`border${side}Style`] !== 'none') {
        results.hairline.push({ level: 'red', el: label(el), side: side.toLowerCase(), width: w });
        break;
      }
    }
  }

  // 6. Corners: a non-text element in a surface's corner sits the same distance from both edges.
  //    7. Nested radius: an inner rounded box near the corner uses outer radius - inset.
  const surface = (el) => {
    const s = style(el);
    const r = el.getBoundingClientRect();
    if (r.width < 48 || r.height < 28) return false;
    const radius = px(s.borderTopLeftRadius);
    const bg = parseColor(s.backgroundColor);
    const hasBg = bg && bg.a > 0.02;
    const hasBorder = px(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none';
    const hasShadow = s.boxShadow && s.boxShadow !== 'none';
    return radius >= 4 && (hasBg || hasBorder || hasShadow);
  };
  const isGlyph = (el) => {
    const n = el.localName;
    if (n === 'svg' || n === 'img' || n === 'canvas' || n === 'video') return true;
    if (n === 'i' || el.hasAttribute('data-ui-icon')) return true;
    const s = style(el);
    const r = el.getBoundingClientRect();
    const bg = parseColor(s.backgroundColor);
    // A small filled or bordered box (badge, dot, chip, icon button).
    return r.width <= 48 && r.height <= 48 && ((bg && bg.a > 0.02) || (px(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none'));
  };
  const surfaces = all.filter((el) => visible(el) && surface(el));
  for (const sEl of surfaces) {
    const s = style(sEl);
    const R = sEl.getBoundingClientRect();
    const inner = { top: R.top + px(s.borderTopWidth), left: R.left + px(s.borderLeftWidth), right: R.right - px(s.borderRightWidth), bottom: R.bottom - px(s.borderBottomWidth) };
    const kids = [];
    (function collect(root) {
      for (const k of root.querySelectorAll('*')) {
        if (k.shadowRoot) collect(k.shadowRoot);
        if (k !== sEl && visible(k) && isGlyph(k) && !k.parentElement?.closest('svg')) kids.push(k);
      }
    })(sEl.shadowRoot || sEl);
    const corners = [
      ['top-left', (r) => [r.top - inner.top, r.left - inner.left]],
      ['top-right', (r) => [r.top - inner.top, inner.right - r.right]],
    ];
    for (const [name, dist] of corners) {
      let best = null;
      for (const k of kids) {
        const r = k.getBoundingClientRect();
        const [a, b] = dist(r);
        if (a < 0 || b < 0 || a > 40 || b > 40) continue;
        // Skip a child that is a surface of its own nested deeper than the corner box.
        if (!best || a + b < best.a + best.b) best = { k, a, b, r };
      }
      if (!best) continue;
      // Only count it as the corner element when nothing else sits closer to that corner.
      const diff = Math.abs(best.a - best.b);
      if (diff > T.cornerTolerance) {
        results.corner.push({ level: 'amber', surface: label(sEl), corner: name, el: label(best.k), edges: name === 'top-left' ? `top ${round(best.a)} / left ${round(best.b)}` : `top ${round(best.a)} / right ${round(best.b)}` });
      }
      const kr = px(style(best.k).borderTopLeftRadius);
      const Rr = px(s.borderTopLeftRadius);
      const inset = Math.max(best.a, best.b);
      // Concentric corners matter for a box that hugs the corner (inset well inside the outer radius) and is big
      // enough to show its own corner; a pill (radius = half its height) keeps its shape.
      if (kr > 0 && kr < Math.min(best.r.width, best.r.height) / 2 && inset <= Rr * 0.75 && best.r.width >= 32 && best.r.height >= 20) {
        const want = Math.max(0, Rr - inset);
        if (Math.abs(kr - want) > T.radiusTolerance) results.radius.push({ level: 'amber', surface: label(sEl), el: label(best.k), outer: round(Rr), inset: round(inset), inner: round(kr), want: round(want) });
      }
    }
  }

  // 8. Accessible names: empty, or carrying a timestamp that belongs in the description.
  const nameOf = (el) => {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const root = el.getRootNode();
      const t = by.split(/\s+/).map((id) => (root.getElementById ? root.getElementById(id) : document.getElementById(id))?.textContent || '').join(' ').trim();
      if (t) return t;
    }
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return al.trim();
    if (el.matches('input,select,textarea')) {
      if (el.labels && el.labels.length) return [...el.labels].map((l) => l.textContent).join(' ').trim();
      return (el.getAttribute('placeholder') || el.getAttribute('title') || '').trim();
    }
    const text = (el.innerText || el.textContent || '').trim();
    if (text) return text;
    const img = el.querySelector('img[alt]');
    if (img && img.alt.trim()) return img.alt.trim();
    const svgTitle = el.querySelector('svg title');
    if (svgTitle && svgTitle.textContent.trim()) return svgTitle.textContent.trim();
    if (el.shadowRoot) {
      const t = (el.shadowRoot.textContent || '').trim();
      if (t) return t;
    }
    return (el.getAttribute('title') || '').trim();
  };
  const TIME = /(\d+\s*(초|분|시간|일|주|개월|년)\s*전|\b\d+\s*(s|m|h|d|w|mo|y|sec|min|hr|hour|day|week|month|year)s?\s+ago\b|\b\d{1,2}:\d{2}\b|어제|오늘|yesterday|today)/i;
  for (const el of outer) {
    const n = nameOf(el).replace(/\s+/g, ' ');
    if (!n) results.name.push({ level: 'red', el: label(el), issue: 'no accessible name' });
    else if (n.length > 80) results.name.push({ level: 'amber', el: label(el), issue: `name is ${n.length} chars — keep the name to what it is, the rest to aria-describedby`, name: n.slice(0, 60) });
    else if (TIME.test(n) && n.replace(TIME, '').trim().length > 0) results.name.push({ level: 'amber', el: label(el), issue: 'time in the name — move it to aria-describedby', name: n.slice(0, 60) });
  }

  // 9. One row, one control height: controls side by side in a flex row should share a height and a shape.
  const CONTROL = 'button,select,input:not([type=checkbox]):not([type=radio]):not([type=hidden]),a.ui-chip,a.ui-btn,[role=button],[role=tab],ui-segmented,ui-model-picker';
  const seenRows = new Set();
  for (const el of all) {
    if (!visible(el)) continue;
    const s = style(el);
    if (!/flex/.test(s.display) || !/^row/.test(s.flexDirection)) continue;
    const kids = [];
    const take = (k) => {
      if (k.matches && k.matches(CONTROL) && visible(k)) kids.push(k);
      else if (k.localName === 'slot') for (const a of k.assignedElements()) take(a);
      else if (k.children && style(k).display === 'contents') for (const c of k.children) take(c);
    };
    for (const k of el.children) take(k);
    if (kids.length < 3) continue;
    // Only controls on one visual line.
    const tops = kids.map((k) => k.getBoundingClientRect());
    const mid = tops.map((r) => r.top + r.height / 2);
    const line = kids.filter((k, i) => Math.abs(mid[i] - mid[0]) < 12);
    if (line.length < 3) continue;
    const hs = line.map((k) => round(k.getBoundingClientRect().height));
    const spread = Math.max(...hs) - Math.min(...hs);
    if (spread > 4 && !seenRows.has(el)) {
      seenRows.add(el);
      results.rowHeight.push({ level: 'amber', el: label(el), heights: [...new Set(hs)].sort((a, b) => a - b).join(' / '), controls: line.length });
    }
  }

  return results;
}

function summarize(preset, r) {
  const rows = [];
  const top = (list, fmt) => list.slice(0, 6).map(fmt).join('<br>');
  const count = (list) => `${list.filter((x) => x.level === 'red').length} red / ${list.filter((x) => x.level === 'amber').length} amber`;
  rows.push(['overflow-x', r.overflowX ? '1 red' : '0', r.overflowX ? `page ${r.overflowX.scrollWidth}px > viewport ${r.overflowX.viewport}px` : '']);
  rows.push(['hit target', count(r.target), top(r.target, (x) => `${x.level} ${x.w}×${x.h} < ${x.need} \`${x.el}\``)]);
  rows.push(['min text size', count(r.fontMin), top(r.fontMin, (x) => `${x.size}px "${x.text}" \`${x.el}\``)]);
  rows.push(['input zoom (iOS)', count(r.inputZoom), top(r.inputZoom, (x) => `${x.size}px \`${x.el}\``)]);
  rows.push(['hairline edge', count(r.hairline), top(r.hairline, (x) => `${x.width}px ${x.side} \`${x.el}\``)]);
  rows.push(['row height', count(r.rowHeight), top(r.rowHeight, (x) => `${x.heights} px across ${x.controls} controls \`${x.el}\``)]);
  rows.push(['corner distance', count(r.corner), top(r.corner, (x) => `${x.corner} ${x.edges} \`${x.el}\` in \`${x.surface}\``)]);
  rows.push(['nested radius', count(r.radius), top(r.radius, (x) => `inner ${x.inner} want ${x.want} (outer ${x.outer} − inset ${x.inset}) \`${x.el}\``)]);
  rows.push(['contrast', count(r.contrast), top(r.contrast, (x) => `${x.ratio}:1 < ${x.need} "${x.text}" \`${x.el}\``)]);
  rows.push(['line length', count(r.lineLength), top(r.lineLength, (x) => `${x.charsPerLine} ch × ${x.lines} \`${x.el}\``)]);
  rows.push(['accessible name', count(r.name), top(r.name, (x) => `${x.issue}${x.name ? ` "${x.name}"` : ''} \`${x.el}\``)]);
  const sizes = Object.entries(r.fontSizes)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([k, v]) => `${k}px×${v}`)
    .join(' ');
  rows.push(['type sizes in use', String(Object.keys(r.fontSizes).length), sizes]);
  const esc = (s) => String(s).replace(/\|/g, '\\|');
  return [`### ${preset}`, '', '| check | count | worst |', '|---|---|---|', ...rows.map((row) => `| ${row.map(esc).join(' | ')} |`), ''].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pw = await loadPlaywright();
  const engine = pw[args.engine] || pw.chromium;
  const presets = args.preset === 'both' ? ['desktop', 'mobile'] : [args.preset];
  mkdirSync(args.out, { recursive: true });
  const report = { url: args.url, engine: args.engine, theme: args.theme || 'default', at: new Date().toISOString(), presets: {} };
  const browser = await engine.launch();
  try {
    for (const preset of presets) {
      const p = THRESHOLDS[preset];
      const ctx = await browser.newContext({
        viewport: p.viewport,
        isMobile: args.engine === 'firefox' ? undefined : p.isMobile,
        hasTouch: p.hasTouch,
        deviceScaleFactor: p.deviceScaleFactor,
        colorScheme: args.theme === 'dark' ? 'dark' : args.theme === 'light' ? 'light' : undefined,
      });
      const u = new URL(args.url);
      if (args.cookies.length) {
        await ctx.addCookies(
          args.cookies.map((c) => {
            const i = c.indexOf('=');
            return { name: c.slice(0, i), value: c.slice(i + 1), domain: u.hostname, path: '/' };
          }),
        );
      }
      if (args.storage.length) {
        const pairs = args.storage.map((s) => {
          const i = s.indexOf('=');
          return [s.slice(0, i), s.slice(i + 1)];
        });
        await ctx.addInitScript((kv) => {
          for (const [k, v] of kv) {
            try {
              localStorage.setItem(k, v);
            } catch {}
          }
        }, pairs);
      }
      const page = await ctx.newPage();
      await page.goto(args.url, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => page.waitForLoadState('load'));
      await page.waitForTimeout(args.wait);
      for (const sel of args.clicks) {
        await page.locator(sel).first().click({ timeout: 10_000 });
        await page.waitForTimeout(args.wait);
      }
      await page.screenshot({ path: join(args.out, `${preset}.png`), fullPage: args.full });
      const t = { ...p, ...THRESHOLDS, desktop: undefined, mobile: undefined };
      const r = await page.evaluate(measure, { t, scope: args.scope, full: args.full });
      report.presets[preset] = r;
      console.log(summarize(`${preset} ${p.viewport.width}×${p.viewport.height}`, r));
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  writeFileSync(join(args.out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`report: ${join(args.out, 'report.json')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
