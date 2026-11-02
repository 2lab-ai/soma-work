/**
 * Display-language catalog extractor (#771).
 *
 *   npx tsx scripts/i18n/extract.ts            — report what the English catalogs lack
 *   npx tsx scripts/i18n/extract.ts --write    — also write scripts/i18n/out/missing-{text,page}.json
 *   npx tsx scripts/i18n/extract.ts --prune    — drop catalog keys no source has any more
 *
 * Two key sets, the two catalogs of @soma/common/i18n-en:
 *
 * - text — every Korean string the server can send (Slack messages, server
 *   errors, settings labels): string literals as they are, template literals
 *   and `+` chains as `{0}` `{1}` … templates. Log lines, comparisons, object
 *   keys and other data are left out, as are the pages' own source (big code
 *   or HTML templates — the page set covers them).
 * - page — every Korean string of the rendered pages (dashboard, settings,
 *   conversation viewer, sign-in), as `scanPage` finds them.
 *
 * Each missing key comes with where it was found and the line around it, so a
 * translator sees the context.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanPage } from '@soma/common/i18n-page';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '..', '..');
const CATALOG_DIR = path.join(ROOT, 'packages/common/src/i18n-catalog');
const OUT_DIR = path.join(ROOT, 'scripts/i18n/out');
const HANGUL = /[ㄱ-ㆎ가-힣]/;

/** Where the server-side strings live. */
const TEXT_ROOTS = ['src', 'packages/slack/src', 'packages/process-shared/src', 'somalib'];
/** Not display text: tests, the terminal controller, model prompts, local plugins. */
const TEXT_EXCLUDE = [
  /(^|\/)__tests__\//,
  /(^|\/)__fixtures__\//,
  /\.test\.ts$/,
  /\.d\.ts$/,
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /^src\/test-utils\//,
  /^src\/cli\//,
  /^src\/prompt\//,
  /^src\/local\//,
];

const LOG_METHODS = new Set(['debug', 'info', 'warn', 'error', 'trace', 'fatal', 'log']);
const DATA_CALLS = new Set([
  'includes',
  'startsWith',
  'endsWith',
  'indexOf',
  'lastIndexOf',
  'has',
  'get',
  'delete',
  'test',
  'match',
  'replace',
  'replaceAll',
  'split',
  'search',
]);

export interface Found {
  key: string;
  where: string[];
  context: string;
}

function add(map: Map<string, Found>, key: string, where: string, context: string): void {
  const hit = map.get(key);
  if (hit) {
    if (hit.where.length < 3) hit.where.push(where);
    return;
  }
  map.set(key, { key, where: [where], context: context.slice(0, 220) });
}

function isLoggerCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (!LOG_METHODS.has(callee.name.text)) return false;
  return /(logger|console|log)$/i.test(callee.expression.getText());
}

function isDataPosition(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isBinaryExpression(p)) {
    const op = p.operatorToken.kind;
    return (
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.InKeyword
    );
  }
  if (ts.isCaseClause(p)) return true;
  if (ts.isPropertyAssignment(p) && p.name === node) return true;
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true;
  if (ts.isLiteralTypeNode(p)) return true;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return true;
  if (ts.isCallExpression(p) && p.arguments.includes(node as ts.Expression)) {
    const c = p.expression;
    if (ts.isPropertyAccessExpression(c) && DATA_CALLS.has(c.name.text)) return true;
    if (ts.isIdentifier(c) && (c.text === 'RegExp' || c.text === 'require')) return true;
  }
  if (ts.isNewExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === 'RegExp') return true;
  return false;
}

/** A `+` chain's operands, left to right. */
function flattenPlus(node: ts.Expression, out: ts.Expression[]): void {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    flattenPlus(node.left, out);
    flattenPlus(node.right, out);
  } else if (ts.isParenthesizedExpression(node) && ts.isBinaryExpression(node.expression)) {
    flattenPlus(node.expression, out);
  } else out.push(node);
}

/** Key + the expressions in placeholder order, or null when the node is not a Korean string expression. */
function stringKey(node: ts.Node): { key: string; holes: ts.Expression[] } | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { key: node.text, holes: [] };
  if (ts.isTemplateExpression(node)) {
    let key = node.head.text;
    const holes: ts.Expression[] = [];
    node.templateSpans.forEach((span) => {
      key += `{${holes.length}}${span.literal.text}`;
      holes.push(span.expression);
    });
    return { key, holes };
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const ops: ts.Expression[] = [];
    flattenPlus(node, ops);
    if (!ops.some((o) => (ts.isStringLiteral(o) || ts.isNoSubstitutionTemplateLiteral(o)) && HANGUL.test(o.text)))
      return null;
    let key = '';
    const holes: ts.Expression[] = [];
    for (const o of ops) {
      if (ts.isStringLiteral(o) || ts.isNoSubstitutionTemplateLiteral(o)) key += o.text;
      else if (ts.isTemplateExpression(o)) {
        key += o.head.text;
        for (const span of o.templateSpans) {
          key += `{${holes.length}}${span.literal.text}`;
          holes.push(span.expression);
        }
      } else {
        key += `{${holes.length}}`;
        holes.push(o);
      }
    }
    return { key, holes };
  }
  return null;
}

/** Page source or a model prompt, not a message: big, or HTML / script. */
/** A page string that is a module's source (an embedded Worker): it starts with an import, or runs past 1200 characters. */
function isEmbeddedSource(key: string): boolean {
  return key.length > 1200 || /^\s*(import|export)\s[\s\S]*\bfrom\s/.test(key);
}

function looksLikeCode(key: string): boolean {
  if (key.length > 1200) return true;
  if (/<(script|style|div|section|ui-[a-z-]+|!DOCTYPE)\b/i.test(key)) return true;
  if (/\bfunction\s*\w*\s*\(/.test(key) && /[{};]/.test(key)) return true;
  return false;
}

function scanTsFile(file: string, map: Map<string, Found>): void {
  const rel = path.relative(ROOT, file);
  const src = fs.readFileSync(file, 'utf8');
  if (!HANGUL.test(src)) return;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = src.split('\n');
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isLoggerCall(node)) return;
    const found = stringKey(node);
    if (found) {
      // A `+` chain inside a bigger chain is visited from the top only.
      const parentIsPlus =
        ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken;
      if (!(parentIsPlus && ts.isBinaryExpression(node)) && HANGUL.test(found.key) && !isDataPosition(node)) {
        if (!looksLikeCode(found.key)) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
          add(map, found.key, `${rel}:${line + 1}`, (lines[line] ?? '').trim());
        }
      }
      for (const h of found.holes) visit(h);
      if (found.holes.length > 0 || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(ROOT, p);
    if (TEXT_EXCLUDE.some((re) => re.test(rel + (e.isDirectory() ? '/' : '')))) continue;
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
}

export function extractTextKeys(): Map<string, Found> {
  const files: string[] = [];
  for (const r of TEXT_ROOTS) walk(path.join(ROOT, r), files);
  const map = new Map<string, Found>();
  for (const f of files.sort()) scanTsFile(f, map);
  return map;
}

/** The pages as a Korean user gets them (no request state: empty boards, a sample conversation). */
export async function renderPages(): Promise<Record<string, string>> {
  const { renderDashboardPage } = await import('../../src/conversation/dashboard');
  const { renderSettingsPage } = await import('../../src/conversation/settings-page');
  const viewer = await import('../../src/conversation/viewer');
  const auth = await import('../../src/conversation/auth-pages');
  const now = Date.UTC(2026, 10, 2);
  const record = {
    id: 'c1',
    channelId: 'C1',
    threadTs: '1.1',
    ownerId: 'U1',
    ownerName: 'owner',
    title: 'title',
    createdAt: now,
    updatedAt: now,
    turns: [],
  };
  const session = {
    kind: 'jwt',
    user: { slackUserId: 'U1', name: 'owner', email: 'o@example.com', provider: 'google' },
  };
  return {
    dashboard: renderDashboardPage(),
    settings: renderSettingsPage(),
    list: viewer.renderConversationListPage([
      { id: 'c1', ownerName: 'owner', title: 'title', createdAt: now, updatedAt: now, turnCount: 0 } as never,
    ]),
    view: viewer.renderConversationViewPage(record as never, []),
    viewSolo: viewer.renderConversationViewPage(record as never),
    login: auth.renderLoginPage({ googleEnabled: true, microsoftEnabled: true, session: null, error: 'x' }),
    loginSession: auth.renderLoginPage({ googleEnabled: true, microsoftEnabled: false, session: session as never }),
    sso: auth.renderSsoConfirmPage('tok', session as never, { sub: 'U2', name: 'other', email: 'x@example.com' }),
  };
}

export async function extractPageKeys(): Promise<Map<string, Found>> {
  const pages = await renderPages();
  const map = new Map<string, Found>();
  for (const [name, html] of Object.entries(pages)) {
    for (const seg of scanPage(html)) {
      // An embedded module or script source (a Worker's code) is code, not page text.
      if (seg.skip || isEmbeddedSource(seg.key)) continue;
      const a = Math.max(0, seg.start - 80);
      const ctx = html.slice(a, Math.min(html.length, seg.end + 60)).replace(/\s+/g, ' ');
      add(map, seg.key, `${name}:${seg.kind}`, ctx);
    }
  }
  return map;
}

function readCatalog(name: string): Record<string, string> {
  const p = path.join(CATALOG_DIR, name);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function sortedJson(obj: Record<string, string>): string {
  const out: Record<string, string> = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return `${JSON.stringify(out, null, 2)}\n`;
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  const prune = process.argv.includes('--prune');
  const sets: Array<[string, Map<string, Found>]> = [
    ['text', extractTextKeys()],
    ['page', await extractPageKeys()],
  ];
  for (const [name, keys] of sets) {
    const file = `en-${name}.json`;
    const catalog = readCatalog(file);
    const missing = [...keys.values()].filter((f) => !(f.key in catalog));
    // `key@@<context>` entries are hand-written overrides of a plain key (see registerPageCatalog).
    const stale = Object.keys(catalog).filter((k) => !keys.has(k) && !k.includes('@@'));
    console.log(`${name}: ${keys.size} keys, ${missing.length} missing, ${stale.length} stale`);
    if (write) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, `missing-${name}.json`), `${JSON.stringify(missing, null, 1)}\n`);
    }
    if (prune && stale.length > 0) {
      for (const k of stale) delete catalog[k];
      fs.writeFileSync(path.join(CATALOG_DIR, file), sortedJson(catalog));
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
