/**
 * The task card's finish by model (SSOT 2026-11-17: "작업 카드의 테두리 라인은 모델에 따라 효과 — sonnet은 지금처럼 ·
 * sol, opus는 좀더 밝고 2px 두께 · astra, fable은 2px 두께에 그라데이션 효과 처리 카드 배경도 약간 포일 느낌") —
 * browser receipts.
 *
 * The real web server serves the real dashboard to a real sign-in; the sessions go through sessionToKanban as the
 * host's do; Chromium draws the board. For dark, light and dark·mono it asserts, from the computed styles inside the
 * board element's shadow root (exit 1 on any failure), and writes a screenshot of the board and of a foil card under
 * the pointer:
 *
 *   F1  sonnet (and grok) keep the element's own card: a 1px border in the card-border colour, the plain surface
 *   F2  opus and sol: a 2px border, brighter than the plain card's
 *   F3  astra and fable: a 2px transparent border over a gradient (the holo foil), four background layers (sheen,
 *       surface, glint, holo) — the surface is not the plain card's flat colour
 *   F4  a finished (DONE) fable card keeps the foil
 *   F5  NEEDS YOU still wins on an opus card: the edge takes the attention tone, the rail sits on the 2px edge
 *   F6  no page errors
 *
 * Run from the repo root with a clean env:
 *   T=$(mktemp -d); env -i PATH="$PATH" HOME="$T" TMPDIR="$T" SOMA_CONFIG_DIR=$T/cfg SOMA_INSTANCE_DIR=$T/inst \
 *     PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright" npx tsx scripts/screenshot-card-finish.ts [outDir]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Page } from 'playwright';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'card-finish');
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.CARD_FINISH_PORT || '33951';
process.env.CONVERSATION_VIEWER_PORT = PORT;
process.env.CONVERSATION_VIEWER_TOKEN = 'shot-token';
const BASE = `http://127.0.0.1:${PORT}`;
const CH = 'C_FINISH';
const M = 60_000;

// One card per model family, plus a finished fable (DONE) and an opus that waits on the viewer (NEEDS YOU).
const CARDS = [
  { id: 'sonnet', model: 'claude-sonnet-5-5[1m]', state: 'working', title: 'Sonnet — 로그 파서 정리' },
  { id: 'grok', model: 'grok-4.7', state: 'working', title: 'Grok — 비용 리포트 초안' },
  { id: 'opus', model: 'claude-opus-5-5[1m]', state: 'working', title: 'Opus — 결제 폼 검증' },
  { id: 'sol', model: 'gpt-6.1-sol[1m]', state: 'working', title: 'Sol — 마이그레이션 스크립트' },
  { id: 'astra', model: 'gpt-6-astra[1m]', state: 'working', title: 'Astra — 아키텍처 리뷰' },
  { id: 'fable', model: 'claude-fable-5-2[1m]', state: 'working', title: 'Fable — 대시보드 카드 효과' },
  { id: 'fable-idle', model: 'claude-fable-5-2[1m]', state: 'idle', title: 'Fable — 끝난 작업' },
  { id: 'opus-wait', model: 'claude-opus-5-5[1m]', state: 'waiting', title: 'Opus — 배포 순서 확인 필요' },
] as const;
const keyOf = (i: number) => `${CH}:1793000000.0001${String(i).padStart(2, '0')}`;

const failures: string[] = [];
const report: string[] = [];
function log(line: string) {
  report.push(line);
  console.log(line);
}
function check(ok: boolean, what: string, detail?: unknown) {
  log(`${ok ? '[ok]  ' : '[FAIL]'} ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 900)}` : ''}`);
  if (!ok) failures.push(what);
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

function sessions() {
  const now = Date.now();
  return new Map<string, Record<string, unknown>>(
    CARDS.map((c, i) => [
      keyOf(i),
      {
        ownerId: 'U001',
        ownerName: 'Zhuge',
        channelId: CH,
        threadTs: `1793000000.0001${String(i).padStart(2, '0')}`,
        sessionId: `sess-${c.id}`,
        model: c.model,
        state: 'MAIN',
        workflow: 'zwork',
        title: c.title,
        activityState: c.state,
        lastActivity: new Date(now - i * M),
        ...(c.state === 'working' ? { activeLegStartedAtMs: now - (5 + i) * M } : {}),
        ...(c.state === 'idle' ? { finishedAt: now - 30 * M } : {}),
        ...(c.state === 'waiting'
          ? {
              waitingSince: now - 3 * M,
              pendingQuestion: { type: 'user_choice', question: 'prod 먼저 배포할까요?', choices: [] },
            }
          : {}),
      },
    ]),
  );
}

type Probe = {
  id: string;
  bw: string;
  bc: string;
  bgImage: string;
  bgColor: string;
  layers: number;
  attention: boolean;
  railLeft: string;
};
async function probeCards(page: Page): Promise<Record<string, Probe>> {
  return page.evaluate(
    (cards) => {
      const root = document.getElementById('kanban')?.shadowRoot;
      const out: Record<string, Probe> = {};
      cards.forEach((c, i) => {
        const li = Array.from(root?.querySelectorAll<HTMLElement>('li.ib-card[data-card]') ?? []).find((el) =>
          (el.getAttribute('data-card') || '').endsWith(`.0001${String(i).padStart(2, '0')}`),
        );
        if (!li) return;
        const cs = getComputedStyle(li);
        const rail = getComputedStyle(li, '::before');
        out[c.id] = {
          id: li.getAttribute('data-card') || '',
          bw: cs.borderTopWidth,
          bc: cs.borderTopColor,
          bgImage: cs.backgroundImage,
          bgColor: cs.backgroundColor,
          layers:
            cs.backgroundImage === 'none'
              ? 0
              : cs.backgroundImage.split(/,\s*(?=(?:linear|radial|conic)-gradient)/).length,
          attention: li.classList.contains('is-attention'),
          railLeft: rail.content && rail.content !== 'none' ? rail.left : '',
        };
      });
      return out;
    },
    CARDS as unknown as Array<{ id: string }>,
  );
}
/** Relative luminance of an rgb()/rgba()/color(srgb …) string (alpha ignored). */
function relLuminance(c: string): number {
  const n = (c.match(/[\d.]+/g) || []).map(Number);
  const [r, g, b] = c.startsWith('color(') ? n.slice(0, 3).map((v) => v * 255) : n.slice(0, 3);
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const transparent = (c: string) => /rgba\(0, 0, 0, 0\)|transparent/.test(c) || /\/ 0\)$/.test(c);

async function main() {
  const live = sessions();
  const dashboard = await import('../src/conversation/dashboard');
  dashboard.setDashboardSessionAccessor(() => live);
  const ws = await import('../src/conversation/web-server');
  await ws.startWebServer({ listen: true });
  log(`server ${BASE}`);
  const { issueSlackToken } = await import('../src/conversation/oauth');
  const token = issueSlackToken({ slackUserId: 'U001', email: 'z@2lab.ai', name: 'Zhuge' });
  const sso = await fetch(`${BASE}/auth/sso?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
  const [cookieName, cookieValue] = String(sso.headers.get('set-cookie')).split(';')[0].split('=');

  try {
    for (const theme of [
      { tag: 'dark', scheme: 'dark' as const, mono: false },
      { tag: 'light', scheme: 'light' as const, mono: false },
      { tag: 'dark-mono', scheme: 'dark' as const, mono: true },
    ]) {
      log(`\n── ${theme.tag} ──`);
      const browser = await chromium.launch({ headless: true, args: ['--single-process', '--no-zygote'] });
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: theme.scheme });
      await ctx.addCookies([{ name: cookieName, value: cookieValue, url: BASE }]);
      if (theme.mono) await ctx.addInitScript(() => localStorage.setItem('soma-palette', 'mono'));
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(`${BASE}/dashboard/U001`);
      await page.waitForFunction(
        (n) => {
          const root = document.getElementById('kanban')?.shadowRoot;
          return (
            (root?.querySelectorAll('li.ib-card[data-card]').length ?? 0) >= n &&
            !!root?.querySelector('style[data-card-finish]')
          );
        },
        CARDS.length,
        { timeout: 20_000 },
      );
      await sleep(900);
      const p = await probeCards(page);
      log(
        `probe ${JSON.stringify(Object.fromEntries(Object.entries(p).map(([k, v]) => [k, [v.bw, v.bc, v.layers]])))}`,
      );
      const plain = p.sonnet;
      check(
        !!plain && plain.bw === '1px' && plain.layers === 0,
        `${theme.tag} F1 sonnet keeps the plain 1px card`,
        plain,
      );
      check(
        !!p.grok && p.grok.bw === '1px' && p.grok.bc === plain?.bc && p.grok.layers === 0,
        `${theme.tag} F1 grok (no finish named) keeps the plain card too`,
        p.grok,
      );
      for (const id of ['opus', 'sol']) {
        const c = p[id];
        const brighter =
          !!c &&
          !!plain &&
          (theme.scheme === 'dark'
            ? relLuminance(c.bc) > relLuminance(plain.bc)
            : relLuminance(c.bc) < relLuminance(plain.bc));
        check(
          !!c && c.bw === '2px' && brighter && c.layers === 0,
          `${theme.tag} F2 ${id}: 2px, a brighter edge than the plain card's (${theme.scheme === 'dark' ? 'lighter' : 'more ink'} on this ground)`,
          c && { bw: c.bw, bc: c.bc, plain: plain?.bc },
        );
      }
      for (const id of ['astra', 'fable']) {
        const c = p[id];
        check(
          !!c && c.bw === '2px' && transparent(c.bc) && c.layers === 4 && /linear-gradient/.test(c.bgImage),
          `${theme.tag} F3 ${id}: 2px transparent edge over the holo gradient, four layers (sheen · surface · glint · holo)`,
          c && { bw: c.bw, bc: c.bc, layers: c.layers },
        );
      }
      const idle = p['fable-idle'];
      check(
        !!idle && idle.bw === '2px' && idle.layers === 4,
        `${theme.tag} F4 a finished (DONE) fable card keeps the foil`,
        idle && { bw: idle.bw, layers: idle.layers, bg: idle.bgColor },
      );
      const wait = p['opus-wait'];
      check(
        !!wait && wait.attention && wait.bw === '2px' && wait.bc !== p.opus?.bc && wait.railLeft === '-2px',
        `${theme.tag} F5 NEEDS YOU still recolours the opus card's 2px edge; the rail sits on it (left -2px)`,
        wait && { attention: wait.attention, bc: wait.bc, opus: p.opus?.bc, rail: wait.railLeft },
      );

      await page.evaluate(() => window.scrollTo(0, 0));
      await page.locator('#kanban').screenshot({ path: path.join(OUT, `${theme.tag}-board.png`) });
      // The foil under the pointer: its sheen and glint have slid across (900 ms ease-out).
      const fableIdx = CARDS.findIndex((c) => c.id === 'fable');
      const fableCard = page.locator(`#kanban li.ib-card[data-card$=".0001${String(fableIdx).padStart(2, '0')}"]`);
      await fableCard.screenshot({ path: path.join(OUT, `${theme.tag}-fable.png`) });
      await fableCard.hover();
      await sleep(1100);
      await fableCard.screenshot({ path: path.join(OUT, `${theme.tag}-fable-hover.png`) });
      const opusIdx = CARDS.findIndex((c) => c.id === 'opus');
      await page
        .locator(`#kanban li.ib-card[data-card$=".0001${String(opusIdx).padStart(2, '0')}"]`)
        .screenshot({ path: path.join(OUT, `${theme.tag}-opus.png`) });
      check(errors.length === 0, `${theme.tag} F6 no page errors`, errors);
      await ctx.close();
      await browser.close();
    }
  } finally {
    await ws.stopWebServer();
  }
  fs.writeFileSync(path.join(OUT, 'report.txt'), `${report.join('\n')}\n`);
  log(
    `\n${report.filter((l) => l.startsWith('[ok]')).length}/${report.filter((l) => /^\[(ok|FAIL)/.test(l)).length} checks passed — ${OUT}`,
  );
  if (failures.length > 0) process.exit(1);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
