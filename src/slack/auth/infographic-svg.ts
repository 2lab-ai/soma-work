/**
 * `auth` infographic SVG — the two pictures, drawn from `infographic-model.ts`.
 *
 *   buildAuthSummarySvg     one panel per provider: the usable amount as a hero
 *                           number + a stacked bar (usable / held back / used),
 *                           and a 7-day step chart of the usable amount coming back.
 *   buildAccountReportSvg   one row per account: state, plan, weekly and model-scoped
 *                           remaining bars, when it fills again, in-flight, age.
 *
 * Rendered by resvg (`metrics/usage-render/svg-to-png.ts`) with the bundled
 * Noto Sans KR. resvg picks one face of that variable font for every weight,
 * so emphasis is a same-colour stroke (`bold()`), not `font-weight`.
 *
 * Colour (dataviz method): one quantity, one colour — the usable amount is
 * blue everywhere (bar, step chart, account bars); the model-scoped window is
 * orange; status colours (good / warning / critical) always ship with an icon
 * and a label; text stays in text inks.
 *
 * Pure: strings in, string out. Every label is XML-escaped.
 */

import {
  type AccountReport,
  type AccountReportGroup,
  type AccountReportRow,
  type AuthInfographic,
  FORECAST_SECS,
  formatAge,
  formatIn,
  formatKstMoment,
  formatKstStamp,
  type GroupInfographic,
} from './infographic-model';

/** Logical canvas widths; the PNG is drawn at {@link INFOGRAPHIC_SCALE}× for sharp text. */
export const SUMMARY_WIDTH = 1200;
export const REPORT_WIDTH = 1400;
export const INFOGRAPHIC_SCALE = 2;

const C = {
  bg: '#1a1a19',
  panel: '#232321',
  panelLine: '#31312e',
  zebra: '#20201e',
  grid: '#3a3a37',
  track: '#363632',
  text: '#f0efec',
  text2: '#c3c2b7',
  muted: '#8f8e86',
  usable: '#3987e5',
  scoped: '#d95926',
  good: '#0ca30c',
  warning: '#fab219',
  critical: '#d03b3b',
} as const;

/** A measurement older than this reads as stale. */
const STALE_SECS = 86_400;

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Rough advance width of `s` in Noto Sans KR at `size` px — layout only. */
export function textWidth(s: string, size: number): number {
  let em = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x3130 && c <= 0x318f)) em += 0.92;
    else if (c >= 0x30 && c <= 0x39) em += 0.56;
    else if (c >= 0x41 && c <= 0x5a) em += 0.64;
    else if (c >= 0x61 && c <= 0x7a) em += 0.52;
    else if (c === 0x20) em += 0.25;
    else if (c < 0x80) em += 0.34;
    else em += 0.95;
  }
  return em * size;
}

type Weight = 'regular' | 'medium' | 'bold';
/**
 * Same-colour stroke per weight, as a share of the font size. The bundled
 * variable font renders its light default face in resvg; `regular` lifts it to
 * a reading weight, `bold` to a display weight.
 */
const WEIGHT_STROKE: Record<Weight, number> = { regular: 0.016, medium: 0.034, bold: 0.05 };

interface TextOpts {
  size: number;
  fill?: string;
  anchor?: 'start' | 'middle' | 'end';
  weight?: Weight;
}

function text(x: number, y: number, s: string, o: TextOpts): string {
  const fill = o.fill ?? C.text;
  const stroke = Math.round(o.size * WEIGHT_STROKE[o.weight ?? 'regular'] * 100) / 100;
  const bold = ` stroke="${fill}" stroke-width="${stroke}" stroke-linejoin="round" paint-order="stroke"`;
  const anchor = o.anchor && o.anchor !== 'start' ? ` text-anchor="${o.anchor}"` : '';
  return `<text x="${f(x)}" y="${f(y)}" font-size="${o.size}" fill="${fill}"${anchor}${bold}>${escapeXml(s)}</text>`;
}

function rect(x: number, y: number, w: number, h: number, fill: string, rx = 0): string {
  if (w <= 0 || h <= 0) return '';
  return `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="${rx}" fill="${fill}"/>`;
}

function line(x1: number, y1: number, x2: number, y2: number, stroke: string, width = 1): string {
  return `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${stroke}" stroke-width="${width}"/>`;
}

const f = (n: number): string => String(Math.round(n * 100) / 100);

type IconKind = 'dot' | 'triangle' | 'cross' | 'pause' | 'bang' | 'ring';

/** Status icon drawn as shapes (font glyphs for these fall back to boxed forms). Centre (cx, cy), box `s`. */
function icon(kind: IconKind, cx: number, cy: number, s: number, color: string): string {
  const r = s / 2;
  switch (kind) {
    case 'dot':
      return `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="${color}"/>`;
    case 'triangle':
      return `<polygon points="${f(cx)},${f(cy - r)} ${f(cx + r * 1.1)},${f(cy + r * 0.85)} ${f(cx - r * 1.1)},${f(cy + r * 0.85)}" fill="${color}" stroke="${color}" stroke-width="1" stroke-linejoin="round"/>`;
    case 'cross': {
      const k = r * 0.8;
      const w = Math.max(2, s * 0.2);
      return `<path d="M${f(cx - k)},${f(cy - k)} L${f(cx + k)},${f(cy + k)} M${f(cx + k)},${f(cy - k)} L${f(cx - k)},${f(cy + k)}" stroke="${color}" stroke-width="${f(w)}" stroke-linecap="round"/>`;
    }
    case 'pause': {
      const w = s * 0.26;
      return `${rect(cx - r * 0.75, cy - r, w, s, color, 1)}${rect(cx + r * 0.75 - w, cy - r, w, s, color, 1)}`;
    }
    case 'bang':
      return `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="${color}"/>${rect(cx - s * 0.07, cy - r * 0.6, s * 0.14, r * 0.8, C.bg, 1)}<circle cx="${f(cx)}" cy="${f(cy + r * 0.48)}" r="${f(s * 0.08)}" fill="${C.bg}"/>`;
    case 'ring':
      return `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r - 1)}" fill="none" stroke="${color}" stroke-width="2"/>`;
  }
}
/** One decimal, `−0` never shown. */
export const fmt1 = (n: number): string => (Math.abs(n) < 0.05 ? '0' : (Math.round(n * 10) / 10).toFixed(1));
const pct = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 100) : 0);

function svgDoc(width: number, height: number, body: string[]): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width * INFOGRAPHIC_SCALE}" height="${Math.ceil(height) * INFOGRAPHIC_SCALE}" viewBox="0 0 ${width} ${Math.ceil(height)}" font-family="Noto Sans KR">`,
    rect(0, 0, width, Math.ceil(height), C.bg),
    ...body,
    '</svg>',
  ].join('\n');
}

/** `llmux 0.2.26 (preview …)` → `llmux 0.2.26`. */
function shortVersion(version: string | undefined): string | undefined {
  if (!version) return undefined;
  const m = version.match(/(\d+\.\d+\.\d+)/);
  return m ? `llmux ${m[1]}` : version.slice(0, 24);
}

/** Split `parts` into lines no wider than `max` px, joined by ` · `. */
function wrapParts(parts: string[], size: number, max: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const p of parts) {
    const next = cur ? `${cur} · ${p}` : p;
    if (cur && textWidth(next, size) > max) {
      lines.push(cur);
      cur = p;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

const STATE_CHIP: Record<GroupInfographic['state'], { icon: IconKind; color: string; label: string }> = {
  ok: { icon: 'dot', color: C.good, label: '여유' },
  low: { icon: 'triangle', color: C.warning, label: '부족' },
  empty: { icon: 'cross', color: C.critical, label: '지금 쓸 몫 없음' },
  unknown: { icon: 'ring', color: C.muted, label: '계산 불가' },
};

const PANEL_H = 326;
const PANEL_GAP = 18;
const HEADER_H = 96;

function namesLine(accounts: string[]): string {
  const shown = accounts.slice(0, 3).join(', ');
  return accounts.length > 3 ? `${shown} 외 ${accounts.length - 3}` : shown;
}

function stepPaths(
  g: GroupInfographic,
  x: (t: number) => number,
  y: (v: number) => number,
  x1: number,
  bottom: number,
): { area: string; stroke: string } {
  const [first, ...rest] = g.points;
  let d = `M${f(x(first.at))},${f(y(first.value))}`;
  for (const p of rest) d += ` H${f(x(p.at))} V${f(y(p.value))}`;
  d += ` H${f(x1)}`;
  return { stroke: d, area: `${d} V${f(bottom)} H${f(x(first.at))} Z` };
}

function summaryPanel(g: GroupInfographic, py: number, nowS: number): string[] {
  const out: string[] = [];
  out.push(
    `<rect x="24" y="${py}" width="${SUMMARY_WIDTH - 48}" height="${PANEL_H}" rx="16" fill="${C.panel}" stroke="${C.panelLine}" stroke-width="1"/>`,
  );

  // ── left: how much is left ────────────────────────────────────────
  const lx = 56;
  const chip = STATE_CHIP[g.state];
  out.push(text(lx, py + 50, g.label, { size: 28, weight: 'bold' }));
  let cx = lx + textWidth(g.label, 28) + 16;
  out.push(icon(chip.icon, cx + 8, py + 42, 16, chip.color));
  cx += 24;
  out.push(text(cx, py + 49, chip.label, { size: 20, fill: C.text2, weight: 'medium' }));
  cx += textWidth(chip.label, 20) + 14;
  out.push(text(cx, py + 49, `${g.accountCount}계정`, { size: 18, fill: C.muted }));

  if (g.total <= 0) {
    out.push(text(lx, py + 126, '집계할 계정이 없습니다', { size: 30, fill: C.text2, weight: 'medium' }));
    const why: string[] = [];
    if (g.counts.held) why.push(`보류 ${g.counts.held}`);
    if (g.counts.noMeasure) why.push(`측정 없음 ${g.counts.noMeasure}`);
    if (g.counts.unknownTier) why.push(`플랜 미상 ${g.counts.unknownTier}`);
    if (why.length) out.push(text(lx, py + 166, why.join(' · '), { size: 18, fill: C.muted }));
    return out;
  }

  const hero = fmt1(g.now);
  out.push(text(lx, py + 134, hero, { size: 76, weight: 'bold' }));
  out.push(text(lx + textWidth(hero, 76) + 10, py + 134, `/ ${fmt1(g.total)} 계정분`, { size: 26, fill: C.text2 }));
  out.push(text(lx, py + 170, `지금 바로 쓸 수 있는 양 · 전체의 ${pct(g.now, g.total)}%`, { size: 19, fill: C.text2 }));

  // Stacked bar: usable | held back | used — 2px surface gaps between segments.
  const bw = 424;
  const by = py + 188;
  const bh = 20;
  const seg = (v: number) => (v / g.total) * bw;
  const parts = [
    { v: g.now, color: C.usable, label: `지금 사용 가능 ${fmt1(g.now)}` },
    { v: g.waiting, color: C.warning, label: `막힘(풀리면 사용) ${fmt1(g.waiting)}` },
    { v: g.used, color: C.track, label: `이번 주 사용함 ${fmt1(g.used)}` },
  ].filter((p) => p.v > 0.0005);
  let bx = lx;
  for (const [i, p] of parts.entries()) {
    const w = Math.max(2, seg(p.v) - (i < parts.length - 1 ? 2 : 0));
    out.push(rect(bx, by, w, bh, p.color, 4));
    bx += seg(p.v);
  }
  let legX = lx;
  for (const p of parts) {
    out.push(rect(legX, py + 222, 12, 12, p.color, 2));
    out.push(text(legX + 18, py + 233, p.label, { size: 15, fill: C.text2 }));
    legX += 18 + textWidth(p.label, 15) + 18;
  }

  // Model-scoped window (Fable): its own small bar, orange.
  let sy = py + 266;
  for (const s of g.scoped.slice(0, 2)) {
    const label = `${s.label} 모델 한도 남음`;
    out.push(text(lx, sy, label, { size: 16, fill: C.text2 }));
    const mx = lx + textWidth(label, 16) + 12;
    out.push(rect(mx, sy - 10, 140, 8, C.track, 3));
    out.push(rect(mx, sy - 10, Math.max(2, (Math.min(s.now, g.total) / g.total) * 140), 8, C.scoped, 3));
    out.push(text(mx + 152, sy, `${fmt1(s.now)} 계정분`, { size: 16, fill: C.text, weight: 'medium' }));
    sy += 26;
  }

  const counts = [`사용 가능 ${g.counts.usable}`, `소진·막힘 ${g.counts.drained}`];
  if (g.counts.held) counts.push(`보류 ${g.counts.held}`);
  if (g.counts.noMeasure) counts.push(`측정 없음 ${g.counts.noMeasure}`);
  if (g.counts.unknownTier) counts.push(`플랜 미상 ${g.counts.unknownTier}`);
  out.push(text(lx, py + PANEL_H - 22, counts.join(' · '), { size: 15, fill: C.muted }));
  if (g.oldestRefreshAt !== undefined) {
    const stale = nowS - g.oldestRefreshAt > STALE_SECS;
    const ageLabel = `측정 최대 ${formatAge(g.oldestRefreshAt, nowS)}`;
    const ax = lx + textWidth(counts.join(' · '), 15) + 16;
    if (stale) out.push(icon('triangle', ax + 7, py + PANEL_H - 28, 12, C.warning));
    out.push(text(ax + (stale ? 18 : 0), py + PANEL_H - 22, ageLabel, { size: 15, fill: stale ? C.text2 : C.muted }));
  }

  // ── right: when it comes back ────────────────────────────────────
  const x0 = 556;
  const x1 = SUMMARY_WIDTH - 64;
  const top = py + 138;
  const bottom = py + 254;
  out.push(text(x0 - 16, py + 50, '앞으로 7일 회복 예보', { size: 20, weight: 'medium' }));
  out.push(
    text(x0 - 16 + textWidth('앞으로 7일 회복 예보', 20) + 12, py + 50, '추가 사용이 없을 때', {
      size: 15,
      fill: C.muted,
    }),
  );
  if (g.next) {
    const head = `다음 +${fmt1(g.next.gain)} · ${formatKstMoment(g.next.at, nowS)}`;
    out.push(text(x0 - 16, py + 88, head, { size: 24, weight: 'medium' }));
    out.push(
      text(x0 - 16 + textWidth(head, 24) + 12, py + 88, `(${namesLine(g.next.accounts)})`, {
        size: 16,
        fill: C.muted,
      }),
    );
    const sub = [`24시간 안에 +${fmt1(g.within24h)}`];
    sub.push(g.fullAt !== undefined ? `전부 회복 ${formatKstMoment(g.fullAt, nowS)}` : '7일 안에 전부 회복되지 않음');
    out.push(text(x0 - 16, py + 116, sub.join(' · '), { size: 16, fill: C.text2 }));
  } else {
    out.push(
      text(x0 - 16, py + 88, g.now >= g.total - 1e-6 ? '이미 가득 참' : '7일 안에 돌아올 몫 없음', {
        size: 24,
        weight: 'medium',
      }),
    );
  }

  const span = x1 - x0;
  const tx = (t: number) => x0 + ((Math.min(Math.max(t, nowS), nowS + FORECAST_SECS) - nowS) / FORECAST_SECS) * span;
  const vy = (v: number) => bottom - (Math.min(Math.max(v, 0), g.total) / g.total) * (bottom - top);
  out.push(line(x0, top, x1, top, C.grid));
  out.push(line(x0, bottom, x1, bottom, C.grid));
  out.push(text(x0 - 8, top + 5, fmt1(g.total), { size: 13, fill: C.muted, anchor: 'end' }));
  out.push(text(x0 - 8, bottom + 5, '0', { size: 13, fill: C.muted, anchor: 'end' }));
  for (const d of g.days.slice(1)) out.push(line(tx(d.start), top, tx(d.start), bottom, C.grid));
  const { area, stroke } = stepPaths(g, tx, vy, x1, bottom);
  out.push(`<path d="${area}" fill="${C.usable}" fill-opacity="0.22"/>`);
  out.push(`<path d="${stroke}" fill="none" stroke="${C.usable}" stroke-width="2.5" stroke-linejoin="round"/>`);
  const dot = (x: number, y: number) =>
    `<circle cx="${f(x)}" cy="${f(y)}" r="5" fill="${C.usable}" stroke="${C.panel}" stroke-width="2"/>`;
  out.push(dot(x0, vy(g.now)));
  if (g.next) {
    const after = g.points.find((p) => p.at === g.next?.at);
    if (after) out.push(dot(tx(after.at), vy(after.value)));
  }
  for (const [i, d] of g.days.entries()) {
    const w = tx(d.end) - tx(d.start);
    const narrow = i === 0 && w < 52;
    const cxDay = narrow ? tx(d.start) : (tx(d.start) + tx(d.end)) / 2;
    const anchor = narrow ? 'start' : 'middle';
    if (w < 14 && d.gain <= 0) continue;
    out.push(text(cxDay, bottom + 22, d.label, { size: 14, fill: C.muted, anchor }));
    out.push(
      text(cxDay, bottom + 44, d.gain > 0.0005 ? `+${fmt1(d.gain)}` : '·', {
        size: 15,
        fill: d.gain > 0.0005 ? C.text : C.muted,
        anchor,
        weight: d.gain > 0.0005 ? 'medium' : 'regular',
      }),
    );
  }
  return out;
}

export function buildAuthSummarySvg(info: AuthInfographic): string {
  const out: string[] = [];
  out.push(text(40, 58, 'LLM 남은 용량', { size: 32, weight: 'bold' }));
  out.push(
    text(SUMMARY_WIDTH - 40, 48, `${formatKstStamp(info.nowS)} KST 기준`, { size: 19, fill: C.text2, anchor: 'end' }),
  );
  const version = shortVersion(info.version);
  if (version) out.push(text(SUMMARY_WIDTH - 40, 74, version, { size: 15, fill: C.muted, anchor: 'end' }));

  let py = HEADER_H;
  for (const g of info.groups) {
    out.push(...summaryPanel(g, py, info.nowS));
    py += PANEL_H + PANEL_GAP;
  }
  if (!info.groups.length) {
    out.push(text(40, py + 40, '구독 한도를 집계할 공급자가 없습니다.', { size: 22, fill: C.text2 }));
    py += 70;
  }

  const notes = [
    '단위: 계정분 = 최상위 플랜 한 계정의 7일 한도 (Claude Max x20 · ChatGPT Pro $500 = 1, Max x5 = 0.25, Pro $200 = 0.4)',
    '토큰 수가 아닙니다',
    '예보는 지금부터 더 쓰지 않는다고 가정',
    '보류(일시정지·인증 실패) 계정은 집계에서 빠짐',
  ];
  const assumed = info.groups.reduce((t, g) => t + g.tierAssumed, 0);
  if (assumed) notes.push(`플랜 미지정 ${assumed}계정은 Max x20으로 가정`);
  if (info.others.length)
    notes.push(`그 밖의 공급자 ${info.others.map((o) => `${o.label} ${o.accounts}계정`).join(', ')}: 구독 한도 미집계`);
  notes.push('계정별 상세는 [계정별 리포트]');
  let ny = py + 12;
  for (const l of wrapParts(notes, 15, SUMMARY_WIDTH - 80)) {
    out.push(text(40, ny, l, { size: 15, fill: C.muted }));
    ny += 24;
  }
  return svgDoc(SUMMARY_WIDTH, ny + 8, out);
}

/* ------------------------------------------------------------------ *
 * Account report
 * ------------------------------------------------------------------ */

const ROW_H = 38;
const COL = {
  icon: 44,
  state: 64,
  name: 212,
  plan: 388,
  bar: 448,
  barW: 210,
  barPct: 668,
  scoped: 736,
  scopedW: 110,
  scopedPct: 856,
  when: 916,
  inFlight: 1238,
  age: REPORT_WIDTH - 40,
} as const;

const ROW_ICON: Record<AccountReportRow['state'], { icon: IconKind; color: string }> = {
  usable: { icon: 'dot', color: C.good },
  blocked: { icon: 'triangle', color: C.warning },
  drained: { icon: 'cross', color: C.critical },
  held: { icon: 'pause', color: C.muted },
  auth: { icon: 'bang', color: C.critical },
  unmeasured: { icon: 'ring', color: C.muted },
};

function bar(x: number, y: number, w: number, ratio: number | undefined, color: string): string[] {
  const out = [rect(x, y, w, 10, C.track, 3)];
  if (ratio !== undefined && ratio > 0.0005) out.push(rect(x, y, Math.max(3, ratio * w), 10, color, 3));
  return out;
}

function whenCell(r: AccountReportRow, nowS: number): { s: string; fill: string } {
  if (r.state === 'blocked')
    return r.returnAt !== undefined
      ? { s: `복귀 ${formatKstMoment(r.returnAt, nowS)} · ${formatIn(r.returnAt, nowS)}`, fill: C.text }
      : { s: '복귀 시각 미상', fill: C.muted };
  if (r.state === 'held' || r.state === 'auth') return { s: '복귀 시각 없음 (수동 해제)', fill: C.muted };
  if (r.resetAt !== undefined)
    return {
      s: `${r.state === 'drained' ? '복귀' : '리셋'} ${formatKstMoment(r.resetAt, nowS)} · ${formatIn(r.resetAt, nowS)}`,
      fill: r.state === 'drained' ? C.text : C.text2,
    };
  return { s: '리셋 시각 미제공', fill: C.muted };
}

function reportGroup(g: AccountReportGroup, y0: number, nowS: number): { out: string[]; height: number } {
  const out: string[] = [];
  const scopedLabel = g.rows.find((r) => r.scoped)?.scoped?.label;
  const countOf = (...s: AccountReportRow['state'][]) => g.rows.filter((r) => s.includes(r.state)).length;
  out.push(text(40, y0 + 30, g.label, { size: 24, weight: 'bold' }));
  const summary = [`${g.rows.length}계정`, `사용 가능 ${countOf('usable')}`];
  if (countOf('blocked')) summary.push(`막힘 ${countOf('blocked')}`);
  if (countOf('drained')) summary.push(`주간 소진 ${countOf('drained')}`);
  if (countOf('held', 'auth')) summary.push(`보류 ${countOf('held', 'auth')}`);
  if (countOf('unmeasured')) summary.push(`미측정 ${countOf('unmeasured')}`);
  out.push(text(40 + textWidth(g.label, 24) + 14, y0 + 29, summary.join(' · '), { size: 16, fill: C.muted }));

  const hy = y0 + 62;
  const head = (x: number, s: string, anchor: TextOpts['anchor'] = 'start') =>
    text(x, hy, s, { size: 13, fill: C.muted, anchor });
  out.push(head(COL.icon, '상태'), head(COL.name, '계정'), head(COL.plan, '플랜'), head(COL.bar, '7일 한도 남음'));
  if (scopedLabel) out.push(head(COL.scoped, `${scopedLabel} 남음`));
  out.push(
    head(COL.when, '다시 차는 시각 (KST)'),
    head(COL.inFlight, '처리 중', 'middle'),
    head(COL.age, '측정', 'end'),
  );
  out.push(line(40, hy + 10, REPORT_WIDTH - 40, hy + 10, C.grid));

  let y = hy + 12;
  for (const [i, r] of g.rows.entries()) {
    if (i % 2 === 1) out.push(rect(32, y, REPORT_WIDTH - 64, ROW_H, C.zebra, 6));
    const base = y + ROW_H / 2 + 6;
    const rowIcon = ROW_ICON[r.state];
    out.push(icon(rowIcon.icon, COL.icon + 7, base - 5, 13, rowIcon.color));
    out.push(text(COL.state, base, r.stateLabel, { size: 15, fill: C.text2 }));
    out.push(text(COL.name, base, r.name, { size: 17, weight: r.current ? 'bold' : 'regular' }));
    if (r.current) {
      const nx = COL.name + textWidth(r.name, 17) + 8;
      out.push(
        `<rect x="${f(nx)}" y="${f(base - 15)}" width="36" height="20" rx="10" fill="none" stroke="${C.usable}" stroke-width="1.2"/>`,
      );
      out.push(text(nx + 18, base - 1, '현재', { size: 12, fill: C.text, anchor: 'middle' }));
    }
    out.push(text(COL.plan, base, r.plan ?? '—', { size: 15, fill: r.plan ? C.text2 : C.muted }));
    out.push(...bar(COL.bar, base - 10, COL.barW, r.week, C.usable));
    out.push(
      text(COL.barPct, base, r.week !== undefined ? `${Math.round(r.week * 100)}%` : '—', {
        size: 15,
        fill: r.week !== undefined ? C.text : C.muted,
      }),
    );
    if (scopedLabel) {
      out.push(...bar(COL.scoped, base - 10, COL.scopedW, r.scoped?.remaining, C.scoped));
      out.push(
        text(
          COL.scopedPct,
          base,
          r.scoped?.remaining !== undefined ? `${Math.round(r.scoped.remaining * 100)}%` : '—',
          {
            size: 15,
            fill: r.scoped?.remaining !== undefined ? C.text : C.muted,
          },
        ),
      );
    }
    const when = whenCell(r, nowS);
    out.push(text(COL.when, base, when.s, { size: 15, fill: when.fill }));
    out.push(
      text(COL.inFlight, base, r.inFlight ? String(r.inFlight) : '·', {
        size: 15,
        fill: r.inFlight ? C.text : C.muted,
        anchor: 'middle',
      }),
    );
    if (r.measuredAt !== undefined) {
      const stale = nowS - r.measuredAt > STALE_SECS;
      const age = formatAge(r.measuredAt, nowS);
      out.push(text(COL.age, base, age, { size: 14, fill: stale ? C.text2 : C.muted, anchor: 'end' }));
      if (stale) out.push(icon('triangle', COL.age - textWidth(age, 14) - 12, base - 5, 11, C.warning));
    } else out.push(text(COL.age, base, '—', { size: 14, fill: C.muted, anchor: 'end' }));
    y += ROW_H;
  }
  return { out, height: y - y0 + 26 };
}

export function buildAccountReportSvg(report: AccountReport): string {
  const out: string[] = [];
  out.push(text(40, 56, '계정별 상세', { size: 30, weight: 'bold' }));
  out.push(
    text(REPORT_WIDTH - 40, 46, `${formatKstStamp(report.nowS)} KST 기준`, { size: 19, fill: C.text2, anchor: 'end' }),
  );
  const version = shortVersion(report.version);
  if (version) out.push(text(REPORT_WIDTH - 40, 72, version, { size: 15, fill: C.muted, anchor: 'end' }));
  let lx = 40;
  for (const [state, label] of [
    ['usable', '사용 가능'],
    ['blocked', '막힘 (풀리는 시각 있음)'],
    ['drained', '주간 소진'],
    ['held', '보류 (일시정지 등)'],
    ['auth', '인증 실패'],
  ] as const) {
    out.push(icon(ROW_ICON[state].icon, lx + 6, 87, 12, ROW_ICON[state].color));
    out.push(text(lx + 18, 92, label, { size: 14, fill: C.muted }));
    lx += 18 + textWidth(label, 14) + 22;
  }

  let y = 108;
  for (const g of report.groups) {
    const { out: rows, height } = reportGroup(g, y, report.nowS);
    out.push(...rows);
    y += height;
  }
  if (!report.groups.length) {
    out.push(text(40, y + 30, 'llmux 풀에 계정이 없습니다.', { size: 20, fill: C.text2 }));
    y += 60;
  }
  const notes = [
    '막대 = 그 계정 한도 중 남은 비율',
    '플랜 뒤 * = 설정이 없어 Max x20으로 가정',
    '"다시 차는 시각" = 막힘은 풀리는 시각, 그 밖에는 7일 한도 리셋',
    '측정 앞 노란 세모 = 하루 넘게 갱신되지 않음',
  ];
  let ny = y + 4;
  for (const l of wrapParts(notes, 14, REPORT_WIDTH - 80)) {
    out.push(text(40, ny, l, { size: 14, fill: C.muted }));
    ny += 22;
  }
  return svgDoc(REPORT_WIDTH, ny + 8, out);
}
