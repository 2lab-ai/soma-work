/**
 * The surface layouts' client half (SSOT 2026-11-02, .prd/21) — one copy for the two pages that draw a layout:
 * the dashboard (its board, its open cards, its detail card) and the settings page's 대시보드 화면 preview.
 * Both pages embed this script as is, so a preview is the card the board will draw.
 *
 * The data is `src/view-layout.ts`'s: a saved document (`doc`), the built-in presets (`builtins`), a mode and the
 * quick switch (`plan`). Plain ES5 with no template syntax: it reaches the browser byte for byte (String.raw).
 */
export const VIEW_LAYOUT_CLIENT_JS = String.raw`
// ── Surface layouts (.prd/21) — shared by the dashboard and the settings preview (view-layout-client.ts) ──
// The preset a surface uses: the user's default for it, else the quick switch, else 1.
function layoutPreset(doc, surface, plan) {
  var a = doc && doc.active ? doc.active[surface] : '';
  if (a === '1' || a === '2' || a === '3') return a;
  return plan === '2' || plan === '3' ? plan : '1';
}
// One surface of one preset in one mode: the user's edit, else the built-in.
function layoutOf(doc, builtins, preset, mode, surface) {
  var p = doc && doc.presets ? doc.presets[preset] : null;
  var m = p ? p[mode] : null;
  if (m && m[surface]) return m[surface];
  return builtins[preset][mode === 'advanced' ? 'advanced' : 'minimal'][surface];
}
// What a mode draws: the task card (face + open card) from its preset, the detail card from its own.
function layoutsFor(doc, builtins, mode, plan) {
  var c = layoutPreset(doc, 'card', plan);
  var d = layoutPreset(doc, 'detail', plan);
  return {
    card: layoutOf(doc, builtins, c, mode, 'card'),
    open: layoutOf(doc, builtins, c, mode, 'open'),
    detail: layoutOf(doc, builtins, d, mode, 'detail'),
    cardPreset: c,
    detailPreset: d,
  };
}
// The face (an InboxCard of @2lab.ai/ui) a layout makes of the full card (cardOf): what is always there (title,
// status, time), the head's switches, the rows in the layout's order (card.rows), the foot's chips in its order.
// asks: the card asks the user something now (a permission, a goal decision, the question, a retry's error) —
// a summary row set to "물을 때만" shows only then.
var FACE_KEEP = ['id', 'title', 'status', 'statusText', 'bodyMode', 'since', 'elapsedMs', 'lead', 'badge', 'star', 'titles'];
var FACE_ROW_KEYS = { summary: ['summary'], task: ['task'], links: ['links'], agents: ['agents'], usage: ['tokens', 'costUsd'], arts: ['artifacts', 'artifactsCount'] };
var FACE_ROW_NAME = { summary: 'summary', task: 'task', links: 'links', agents: 'agents', usage: 'usage', arts: 'artifacts' };
function faceOf(card, model, face, asks) {
  var f = face || { rows: [], foot: [] };
  var out = {};
  var copy = function(k) {
    if (card && Object.prototype.hasOwnProperty.call(card, k) && card[k] !== undefined) out[k] = card[k];
  };
  for (var i = 0; i < FACE_KEEP.length; i++) copy(FACE_KEEP[i]);
  if (f.star === false) delete out.star;
  if (f.owner === false) delete out.badge;
  var rows = [];
  var list = f.rows || [];
  for (var r = 0; r < list.length; r++) {
    var row = list[r];
    if (!row || !row.on || !FACE_ROW_KEYS[row.id]) continue;
    if (row.id === 'summary' && row.opt === 'asks' && !asks) continue;
    var keys = FACE_ROW_KEYS[row.id];
    for (var k = 0; k < keys.length; k++) copy(keys[k]);
    if (row.id === 'arts' && out.artifacts) out.artifacts = out.artifacts.slice(0, Math.max(1, Number(row.opt) || 4));
    rows.push(FACE_ROW_NAME[row.id]);
  }
  out.rows = rows;
  // What the card is: an epic, a plan node or a cron run lead with their own; a plain task with the task mark.
  if (f.kind && !out.lead) out.lead = { glyph: 'task', title: '일반 작업' };
  var foot = faceFootMetrics(card, model, f.foot || []);
  if (foot.length) out.metrics = foot;
  return out;
}
function layoutTokens(n) {
  n = Math.max(0, Number(n) || 0);
  if (n < 999.5) return String(Math.round(n));
  var units = ['K', 'M', 'B', 'T'];
  for (var i = 0; i < units.length; i++) {
    n /= 1000;
    if (n < 999.95) return n.toFixed(1) + units[i];
  }
  return '999.9T+';
}
// The foot's chips in the layout's order (the host's metrics of the element): steps · context · the
// instruction's attachments · the PR · the artifact count · the cost (its tooltip also says the tokens) · the
// tokens · the model (its name with its vendor's mark).
function faceFootMetrics(card, model, foot) {
  var out = [];
  var c = card || {};
  var host = c.metrics || [];
  var hostOf = function(glyph) {
    for (var h = 0; h < host.length; h++) if (host[h] && host[h].glyph === glyph) return host[h];
    return null;
  };
  var titles = c.titles || {};
  for (var i = 0; i < (foot || []).length; i++) {
    var chip = foot[i];
    if (!chip || !chip.on) continue;
    var m = null;
    if (chip.id === 'steps' && c.steps && Number(c.steps.total) > 0) {
      m = { text: Math.min(Number(c.steps.done) || 0, Number(c.steps.total)) + '/' + Number(c.steps.total), glyph: 'tasks', title: titles.steps || '완료한 작업 / 전체' };
    } else if (chip.id === 'ctx' && Number(c.contextPct) > 0) {
      var pct = Math.round(Math.min(Number(c.contextPct), 100));
      m = { text: pct + '%', glyph: 'context', title: titles.context || '컨텍스트 윈도우 사용량' };
      var lv = c.contextLevel === 'warn' || c.contextLevel === 'danger' ? c.contextLevel : c.contextLevel === '' ? '' : pct > 80 ? 'danger' : pct > 60 ? 'warn' : '';
      if (lv) m.tone = lv;
    } else if (chip.id === 'media') m = hostOf('attach');
    else if (chip.id === 'pr') m = hostOf('pr');
    else if (chip.id === 'arts') {
      var n = Number(c.artifactsCount) || 0;
      if (n > 0) m = { text: String(n), glyph: 'file', title: '산출물 ' + n + '개', label: '산출물 ' + n + '개' };
    } else if (chip.id === 'cost') {
      var cost = Number(c.costUsd) || 0;
      if (cost > 0) {
        var price = cost < 0.01 ? '<$0.01' : '$' + (cost >= 100 ? cost.toFixed(0) : cost.toFixed(2));
        m = { text: price, title: (titles.cost || 'API 환산 비용') + (titles.tokens ? '\n' + titles.tokens : '') };
      }
    } else if (chip.id === 'tokens') {
      var t = Number(c.tokens) || 0;
      if (t > 0) m = { text: layoutTokens(t) + ' 토큰', title: titles.tokens || '총 토큰' };
    } else if (chip.id === 'model') {
      // 'unknown' is the server's placeholder for a model it does not know — no name to show.
      var md = model && model !== 'unknown' ? String(model) : '';
      if (md) m = { text: modelLabelOf(md), glyph: modelVendorOf(md), title: md };
    }
    if (m) out.push(m);
  }
  return out;
}
// Whose model it is, for its mark: claude · openai · grok · gemini · model (any other).
function modelVendorOf(model) {
  var m = String(model || '').toLowerCase();
  if (/claude|opus|sonnet|haiku|fable/.test(m)) return 'claude';
  if (/^gpt|^o[0-9]|codex|openai/.test(m)) return 'openai';
  if (/grok/.test(m)) return 'grok';
  if (/gemini/.test(m)) return 'gemini';
  return 'model';
}
// The model's name: the representative label (Opus 5.5), else its id without claude- and a date.
function modelLabelOf(model) {
  var models = typeof REPRESENTATIVE_MODELS !== 'undefined' && REPRESENTATIVE_MODELS ? REPRESENTATIVE_MODELS : [];
  for (var i = 0; i < models.length; i++) if (models[i].model === model && models[i].label) return String(models[i].label);
  return String(model || '').replace(/^claude-/, '').replace(/-[0-9]{8}(?=\[|$)/, '');
}
// The open card's parts after the actions and what asks, for a column: a built-in's per-column order, else the
// layout's one order (its shown parts).
function openPartsOf(open, col) {
  var lane = col === 'working' ? 'work' : col === 'waiting' ? 'wait' : 'done';
  if (open && open.byCol && open.byCol[lane]) return open.byCol[lane].slice();
  var out = [];
  var parts = (open && open.parts) || [];
  for (var i = 0; i < parts.length; i++) if (parts[i] && parts[i].on) out.push(parts[i].id);
  return out;
}
// The thread card a task card makes ("태스크 카드 따라감") — view-layout.ts followThreadLayout, the same mapping
// (a parity test keeps the two equal): the owner, then what the face shows that Slack can show, in the face's
// order — the task, tokens · cost (the usage row), the steps, the context, the cost, the tokens, the model — then
// the way back (the dashboard link; the link history when the face shows the PR), then 종료됨.
var THREAD_INFO_IDS = ['owner', 'workflow', 'model', 'ctx', 'cost', 'tokens', 'task', 'steps'];
function followThreadLayout(face) {
  var info = [];
  var add = function(id) { if (info.indexOf(id) < 0) info.push(id); };
  if (face && face.owner) add('owner');
  var rows = (face && face.rows) || [];
  for (var r = 0; r < rows.length; r++) {
    if (!rows[r] || !rows[r].on) continue;
    if (rows[r].id === 'task') add('task');
    if (rows[r].id === 'usage') { add('tokens'); add('cost'); }
  }
  // The link history when the face shows its links or its PR.
  var pr = false;
  for (var l = 0; l < rows.length; l++) if (rows[l] && rows[l].on && rows[l].id === 'links') pr = true;
  var foot = (face && face.foot) || [];
  var map = { steps: 'steps', ctx: 'ctx', cost: 'cost', tokens: 'tokens', model: 'model' };
  for (var f = 0; f < foot.length; f++) {
    if (!foot[f] || !foot[f].on) continue;
    if (foot[f].id === 'pr') pr = true;
    else if (map[foot[f].id]) add(map[foot[f].id]);
  }
  var items = [];
  for (var i = 0; i < info.length; i++) items.push({ id: info[i], on: true });
  for (var j = 0; j < THREAD_INFO_IDS.length; j++) if (info.indexOf(THREAD_INFO_IDS[j]) < 0) items.push({ id: THREAD_INFO_IDS[j], on: false });
  return {
    info: items,
    nav: [{ id: 'dashboardLink', on: true }, { id: 'linkhistory', on: pr }, { id: 'links', on: false }, { id: 'status', on: true }],
  };
}
// The detail card a layout makes, as the page's switches: the sections it shows (body[data-detail]), how its
// tasks read (data-tasks), the list's share (--ptl-max), whether its sections open unfolded, its top order.
function detailSpecOf(d) {
  var show = [];
  var top = (d && d.top) || [];
  var order = [];
  for (var i = 0; i < top.length; i++) {
    if (!top[i]) continue;
    order.push(top[i].id);
    if (top[i].on && top[i].id !== 'needs') show.push(top[i].id);
  }
  if (d && d.subtitle) show.push('subtitle');
  if (d && d.agenthead) show.push('agenthead');
  if (d && d.agents === 'all') show.push('agenttabs');
  else if (d && d.agents === 'sub') show.push('subtabs');
  if (d && d.sections) show.push('sections');
  if (d && d.controls) show.push('controls');
  var tasks = d && (d.tasks === 'list' || d.tasks === 'line' || d.tasks === 'none') ? d.tasks : 'runs';
  return {
    show: show,
    tasks: tasks,
    tasksMax: tasks === 'list' || tasks === 'line' ? Number(d.tasksMax) || 34 : 0,
    open: !!(d && d.open),
    order: order,
  };
}
`;
