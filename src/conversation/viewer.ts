import { ConversationRecord, ConversationMeta, ConversationTurn } from './types';

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Format timestamp for display
 */
function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Render the conversation list page
 */
export function renderConversationListPage(conversations: ConversationMeta[]): string {
  const rows = conversations.map(c => `
    <tr onclick="window.location='/conversations/${escapeHtml(c.id)}'" style="cursor:pointer">
      <td>${escapeHtml(c.title || '(no title)')}</td>
      <td>${escapeHtml(c.ownerName)}</td>
      <td><code>${escapeHtml(c.workflow || 'default')}</code></td>
      <td>${c.turnCount}</td>
      <td>${formatTime(c.updatedAt)}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Conversations</title>
  <style>${getBaseStyles()}</style>
</head>
<body>
  <div class="container">
    <h1>📝 Conversations</h1>
    <p class="subtitle">${conversations.length} conversations recorded</p>
    ${conversations.length === 0
      ? '<p class="empty">No conversations yet.</p>'
      : `<table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Owner</th>
            <th>Workflow</th>
            <th>Turns</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`
    }
  </div>
</body>
</html>`;
}

/**
 * Render a single conversation view page
 */
export function renderConversationViewPage(record: ConversationRecord): string {
  const turnsHtml = record.turns.map((turn, idx) => renderTurn(turn, idx, record.id)).join('');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(record.title || 'Conversation')}</title>
  <style>${getBaseStyles()}${getViewStyles()}</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <a href="/conversations" class="back">&larr; All Conversations</a>
      <h1>${escapeHtml(record.title || 'Conversation')}</h1>
      <div class="meta">
        <span>👤 ${escapeHtml(record.ownerName)}</span>
        <span>🔧 <code>${escapeHtml(record.workflow || 'default')}</code></span>
        <span>💬 ${record.turns.length} turns</span>
        <span>📅 ${formatTime(record.createdAt)}</span>
      </div>
    </div>

    <div class="toolbar">
      <button id="selectAllBtn" onclick="toggleSelectAll()">Select All</button>
      <button id="exportBtn" onclick="exportSelected()" disabled>Export Selected (.md)</button>
      <span id="selectedCount">0 selected</span>
    </div>

    <div class="turns">
      ${turnsHtml}
    </div>
  </div>

  <script>${getViewerScript(record.id)}</script>
</body>
</html>`;
}

/**
 * Render a single turn
 */
function renderTurn(turn: ConversationTurn, index: number, conversationId: string): string {
  const isUser = turn.role === 'user';
  const roleClass = isUser ? 'user' : 'assistant';
  const roleIcon = isUser ? '👤' : '🤖';
  const displayName = isUser ? escapeHtml(turn.userName || 'User') : 'Assistant';
  const time = formatTime(turn.timestamp);

  let contentHtml: string;

  if (isUser) {
    contentHtml = `<pre class="content">${escapeHtml(turn.rawContent)}</pre>`;
  } else {
    // Assistant: show summary with expand button
    const summaryHtml = turn.summarized && turn.summaryTitle
      ? `<div class="summary">
          <div class="summary-title">${escapeHtml(turn.summaryTitle)}</div>
          <div class="summary-body">${escapeHtml(turn.summaryBody || '')}</div>
        </div>`
      : `<div class="summary pending">
          <em>Summary pending...</em>
        </div>`;

    contentHtml = `
      ${summaryHtml}
      <details class="raw-details" data-conversation="${escapeHtml(conversationId)}" data-turn="${escapeHtml(turn.id)}">
        <summary class="expand-btn">Show raw response</summary>
        <div class="raw-content">
          <div class="loading">Loading...</div>
        </div>
      </details>`;
  }

  return `
    <div class="turn ${roleClass}" id="turn-${index}">
      <div class="turn-header">
        <label class="checkbox-label">
          <input type="checkbox" class="turn-checkbox" data-turn-id="${escapeHtml(turn.id)}" onchange="updateSelectedCount()">
        </label>
        <span class="role-icon">${roleIcon}</span>
        <span class="role-name">${displayName}</span>
        <span class="time">${time}</span>
      </div>
      <div class="turn-content">
        ${contentHtml}
      </div>
    </div>`;
}

/**
 * Base CSS styles
 */
function getBaseStyles(): string {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f5f5;
      color: #333;
      line-height: 1.6;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
      padding: 20px;
    }
    h1 { margin-bottom: 8px; }
    .subtitle { color: #666; margin-bottom: 20px; }
    .empty { color: #999; font-style: italic; padding: 40px 0; text-align: center; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #f8f9fa; font-weight: 600; }
    tr:hover { background: #f0f4ff; }
    code { background: #e8eef4; padding: 2px 6px; border-radius: 4px; font-size: 0.85em; }
    a { color: #0066cc; text-decoration: none; }
    a:hover { text-decoration: underline; }
  `;
}

/**
 * View page specific styles
 */
function getViewStyles(): string {
  return `
    .header { margin-bottom: 20px; }
    .back { display: inline-block; margin-bottom: 12px; font-size: 0.9em; }
    .meta { display: flex; gap: 20px; flex-wrap: wrap; color: #666; font-size: 0.9em; margin-top: 8px; }
    .toolbar {
      display: flex; gap: 10px; align-items: center;
      padding: 12px 16px; background: white; border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 16px;
    }
    .toolbar button {
      padding: 6px 14px; border: 1px solid #ddd; border-radius: 6px;
      background: white; cursor: pointer; font-size: 0.85em;
    }
    .toolbar button:hover { background: #f0f4ff; }
    .toolbar button:disabled { opacity: 0.5; cursor: not-allowed; }
    #selectedCount { color: #666; font-size: 0.85em; margin-left: auto; }

    .turns { display: flex; flex-direction: column; gap: 12px; }
    .turn {
      background: white; border-radius: 8px; padding: 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .turn.user { border-left: 4px solid #0066cc; }
    .turn.assistant { border-left: 4px solid #00994d; }
    .turn-header {
      display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
      font-size: 0.9em;
    }
    .checkbox-label { display: flex; align-items: center; }
    .role-icon { font-size: 1.1em; }
    .role-name { font-weight: 600; }
    .time { color: #999; margin-left: auto; font-size: 0.8em; }

    .turn-content { }
    .content {
      white-space: pre-wrap; word-break: break-word;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.85em; line-height: 1.5;
      background: #f8f9fa; padding: 12px; border-radius: 6px;
    }

    .summary { padding: 8px 0; }
    .summary-title { font-weight: 600; font-size: 1em; }
    .summary-body { color: #555; margin-top: 4px; white-space: pre-line; }
    .summary.pending { color: #999; font-style: italic; }

    .raw-details { margin-top: 10px; }
    .expand-btn {
      cursor: pointer; color: #0066cc; font-size: 0.85em;
      padding: 4px 0;
    }
    .expand-btn:hover { text-decoration: underline; }
    .raw-content {
      margin-top: 8px; background: #f8f9fa; padding: 12px;
      border-radius: 6px; font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.8em; line-height: 1.5; white-space: pre-wrap;
      word-break: break-word; max-height: 500px; overflow-y: auto;
    }
    .loading { color: #999; font-style: italic; }
  `;
}

/**
 * Client-side JavaScript for the viewer page
 */
function getViewerScript(conversationId: string): string {
  return `
    const CONVERSATION_ID = ${JSON.stringify(conversationId)};
    const loadedRawCache = {};

    // Lazy load raw content when details element is opened
    document.querySelectorAll('.raw-details').forEach(details => {
      details.addEventListener('toggle', async function() {
        if (!this.open) return;

        const convId = this.dataset.conversation;
        const turnId = this.dataset.turn;
        const contentDiv = this.querySelector('.raw-content');

        // Check cache
        if (loadedRawCache[turnId]) {
          contentDiv.textContent = loadedRawCache[turnId];
          return;
        }

        try {
          const res = await fetch('/api/conversations/' + convId + '/turns/' + turnId + '/raw');
          if (!res.ok) throw new Error('Failed to load');
          const data = await res.json();
          loadedRawCache[turnId] = data.raw;
          contentDiv.textContent = data.raw;
        } catch (err) {
          contentDiv.textContent = 'Error loading content: ' + err.message;
        }
      });
    });

    // Selection management
    function updateSelectedCount() {
      const checked = document.querySelectorAll('.turn-checkbox:checked');
      const countEl = document.getElementById('selectedCount');
      const exportBtn = document.getElementById('exportBtn');
      countEl.textContent = checked.length + ' selected';
      exportBtn.disabled = checked.length === 0;
    }

    function toggleSelectAll() {
      const checkboxes = document.querySelectorAll('.turn-checkbox');
      const allChecked = Array.from(checkboxes).every(cb => cb.checked);
      checkboxes.forEach(cb => { cb.checked = !allChecked; });
      updateSelectedCount();
    }

    // Export to markdown
    async function exportSelected() {
      const checked = document.querySelectorAll('.turn-checkbox:checked');
      const turnIds = Array.from(checked).map(cb => cb.dataset.turnId);

      try {
        const res = await fetch('/api/conversations/' + CONVERSATION_ID + '/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ turnIds }),
        });

        if (!res.ok) throw new Error('Export failed');
        const md = await res.text();

        // Download as file
        const blob = new Blob([md], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'conversation-' + CONVERSATION_ID.substring(0, 8) + '.md';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (err) {
        alert('Export failed: ' + err.message);
      }
    }
  `;
}
