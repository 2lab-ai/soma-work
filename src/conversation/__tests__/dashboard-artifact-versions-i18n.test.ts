/**
 * #1074 — the artifact version strings in the display language: an en user's dashboard is the page run
 * through the English page catalog (`translatePage`). Every Korean string of the version client — the
 * badge, the viewer's 이전 판 열기 / 이전 판과 비교, the diff page — has its English.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pageText, registerPageCatalog, scanPage, translatePage } from '@soma/common/i18n-page';
import { describe, expect, it } from 'vitest';

const CATALOG = join(__dirname, '..', '..', '..', 'packages', 'common', 'src', 'i18n-catalog');
registerPageCatalog(JSON.parse(readFileSync(join(CATALOG, 'en-page.json'), 'utf8')));

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));
const cook = (fragment: string): string => new Function(`return \`${fragment}\`;`)() as string;

const VERSION_CLIENT = [
  'artLatestOnly',
  'artVersionLabel',
  'artVerBadge',
  'artFileItem',
  'artViewItem',
  'artVersionsOf',
  'artOpenPrevious',
  'artDiffItem',
  'artOpenDiff',
  'onArtViewerAction',
];
function clientFn(name: string): string {
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  return cook(TEMPLATE.slice(start + 1, TEMPLATE.indexOf('\n}\n', start) + 2));
}

describe('#1074 — every Korean string of the artifact versions has its English', () => {
  it('the version client: badge, viewer actions, diff page', () => {
    const script = `<script>\n${VERSION_CLIENT.map(clientFn).join('\n')}\n</script>`;
    const untranslated = scanPage(script)
      .filter((seg) => !seg.skip && pageText(seg.key) === undefined)
      .map((seg) => seg.key);
    expect(untranslated).toEqual([]);
  });

  it('reads as English, in English order', () => {
    // The page translates script literals inside <script>; the label runs on the translated source.
    const en = translatePage(`<script>\n${clientFn('artVersionLabel')}\n</script>`, 'en')
      .replace(/^<script>\n/, '')
      .replace(/\n<\/script>$/, '');
    const label = new Function(
      `function toNum(v) { var n = Number(v); return isFinite(n) ? n : 0; }\n${en}\nreturn artVersionLabel;`,
    )() as (a: unknown) => string;
    expect(label({ version: 2, changed: true })).toBe('Version 2 · changed since the previous version');
    expect(label({ version: 3 })).toBe('Version 3');
    expect(pageText('이전 판 열기')).toBe('Open the previous version');
    expect(pageText('이전 판과 비교')).toBe('Compare with the previous version');
  });
});
