---
description: Render Slack Block Kit JSON to PNG screenshot using Playwright. Use when you need to visually preview Block Kit layouts, compare design variants, or validate UI before deploying. Triggers on "block kit preview", "render block kit", "slack preview", "block kit screenshot", "block kit to png", "visualize blocks".
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent
---

# Block Kit Preview Skill

Slack Block Kit JSON을 Playwright + 자체 HTML 렌더러로 PNG 스크린샷으로 변환한다.
Slack Block Kit Builder는 로그인 필요 → 자체 CSS 렌더러로 우회.

## Prerequisites

- Node.js (이미 설치됨)
- Playwright (`npm install playwright` + `npx playwright install chromium`)

## Workflow

### 1. 입력 확인
사용자가 Block Kit JSON을 직접 제공하거나, 코드에서 Block Kit 생성 로직을 가리킬 수 있다.
- JSON 직접 제공 → 그대로 사용
- 코드 참조 → 해당 코드에서 생성되는 JSON 구조를 분석/추출

### 2. 렌더러 준비
작업 디렉토리(예: `/tmp/{userId}/block-kit-preview/`)에 렌더러 스크립트를 생성한다.

```bash
# 1회만 실행 (이미 설치된 경우 skip)
cd /tmp/{userId} && npm init -y --silent 2>/dev/null
npm install playwright 2>/dev/null
npx playwright install chromium 2>/dev/null
```

### 3. 렌더러 스크립트 생성
아래 템플릿을 사용하여 `.mjs` 파일을 생성한다. `BLOCK_KIT_JSON` 변수에 렌더링할 JSON을 넣는다.

```javascript
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

// ── Block Kit JSON ──
const BLOCK_KIT_JSON = {
  blocks: [
    // ... 여기에 Block Kit JSON blocks 배열
  ]
};

// ── Slack-style mrkdwn parser ──
function parseMrkdwn(text) {
  return text
    .replace(/\*([^*]+)\*/g, '<strong>$1</strong>')
    .replace(/(?<![a-zA-Z0-9])_([^_]+)_(?![a-zA-Z0-9])/g, '<em>$1</em>')
    .replace(/~([^~]+)~/g, '<s>$1</s>')
    .replace(/`([^`]+)`/g, '<code style="background:#f0f0f3;padding:2px 5px;border-radius:3px;font-size:12px;color:#e01e5a">$1</code>')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '<a href="$1" style="color:#1264a3;text-decoration:none">$2</a>')
    .replace(/<(https?:\/\/[^>]+)>/g, '<a href="$1" style="color:#1264a3;text-decoration:none">$1</a>');
}

// ── Block renderer ──
function renderBlock(block) {
  switch (block.type) {
    case 'header':
      return `<div style="padding:8px 16px;font-size:18px;font-weight:900;line-height:1.4">${block.text.text}</div>`;
    case 'divider':
      return '<div style="padding:4px 16px"><hr style="border:none;border-top:1px solid #e0e0e0;margin:0"/></div>';
    case 'section': {
      const textHtml = block.text ? parseMrkdwn(block.text.text) : '';
      let fieldsHtml = '';
      if (block.fields) {
        fieldsHtml = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 16px;margin-top:4px">' +
          block.fields.map(f => `<div style="font-size:14px;line-height:1.4">${parseMrkdwn(f.text)}</div>`).join('') +
          '</div>';
      }
      let accessoryHtml = '';
      if (block.accessory?.type === 'button') {
        const btn = block.accessory;
        const style = btn.style === 'danger'
          ? 'background:#e01e5a;color:#fff;border:none'
          : btn.style === 'primary'
            ? 'background:#007a5a;color:#fff;border:none'
            : 'background:#fff;color:#1d1c1d;border:1px solid #e0e0e0';
        accessoryHtml = `<button style="${style};padding:6px 14px;border-radius:6px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0">${btn.text.text}</button>`;
      }
      if (block.accessory?.type === 'image') {
        accessoryHtml = `<img src="${block.accessory.image_url}" alt="${block.accessory.alt_text || ''}" style="width:48px;height:48px;border-radius:4px;flex-shrink:0"/>`;
      }
      return `
        <div style="display:flex;align-items:flex-start;justify-content:space-between;padding:6px 16px;gap:12px">
          <div style="font-size:15px;line-height:1.5;color:#1d1c1d;flex:1;min-width:0">${textHtml}${fieldsHtml}</div>
          ${accessoryHtml ? `<div style="flex-shrink:0;padding-top:2px">${accessoryHtml}</div>` : ''}
        </div>`;
    }
    case 'context': {
      const els = block.elements.map(el => {
        if (el.type === 'mrkdwn') return parseMrkdwn(el.text);
        if (el.type === 'plain_text') return el.text;
        if (el.type === 'image') return `<img src="${el.image_url}" alt="${el.alt_text || ''}" style="width:16px;height:16px;border-radius:2px;vertical-align:middle;margin-right:4px"/>`;
        return '';
      }).join(' ');
      return `<div style="padding:2px 16px 6px 16px;font-size:12px;line-height:1.4;color:#616061">${els}</div>`;
    }
    case 'actions': {
      const buttons = block.elements.map(el => {
        if (el.type === 'button') {
          const style = el.style === 'primary'
            ? 'background:#007a5a;color:#fff;border:none'
            : el.style === 'danger'
              ? 'background:#e01e5a;color:#fff;border:none'
              : 'background:#fff;color:#1d1c1d;border:1px solid #e0e0e0';
          return `<button style="${style};padding:6px 14px;border-radius:6px;font-size:13px;font-weight:700;cursor:pointer;margin-right:8px">${el.text.text}</button>`;
        }
        if (el.type === 'static_select') {
          return `<select style="padding:6px 14px;border-radius:6px;font-size:13px;border:1px solid #e0e0e0;margin-right:8px"><option>${el.placeholder?.text || 'Select...'}</option></select>`;
        }
        return '';
      }).join('');
      return `<div style="padding:6px 16px">${buttons}</div>`;
    }
    case 'image':
      return `<div style="padding:8px 16px"><img src="${block.image_url}" alt="${block.alt_text || ''}" style="max-width:100%;border-radius:4px"/>${block.title ? `<div style="font-size:12px;color:#616061;margin-top:4px">${block.title.text}</div>` : ''}</div>`;
    case 'rich_text':
      return `<div style="padding:6px 16px;font-size:15px;color:#1d1c1d">[rich_text block]</div>`;
    case 'input':
      return `<div style="padding:6px 16px"><label style="font-size:14px;font-weight:700">${block.label?.text || 'Input'}</label><input style="width:100%;padding:8px;border:1px solid #e0e0e0;border-radius:4px;margin-top:4px" placeholder="${block.element?.placeholder?.text || ''}"/></div>`;
    default:
      return `<div style="padding:4px 16px;color:#999">[ unsupported: ${block.type} ]</div>`;
  }
}

function renderMessage(json, options = {}) {
  const { botName = 'Soma', botTime = '오후 2:30', label = '' } = options;
  const blocksHtml = json.blocks.map(renderBlock).join('\n');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#f8f8f8; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; padding:40px; }
  .message-container { max-width:680px; margin:0 auto; background:#fff; border-radius:8px; border:1px solid #e0e0e0; padding:12px 0; box-shadow:0 1px 3px rgba(0,0,0,0.08); }
  .variant-label { padding:8px 16px; font-size:11px; font-weight:800; color:#fff; background:#1d1c1d; margin:-12px 0 12px 0; border-radius:8px 8px 0 0; letter-spacing:0.5px; text-transform:uppercase; }
  .bot-header { display:flex; align-items:center; gap:8px; padding:4px 16px 8px 16px; }
  .bot-avatar { width:36px; height:36px; border-radius:4px; background:linear-gradient(135deg,#667eea 0%,#764ba2 100%); display:flex; align-items:center; justify-content:center; color:#fff; font-weight:900; font-size:18px; }
  .bot-name { font-weight:900; font-size:15px; color:#1d1c1d; }
  .bot-time { font-size:12px; color:#616061; margin-left:4px; }
  a { pointer-events:none; }
</style></head><body>
<div class="message-container">
  ${label ? `<div class="variant-label">${label}</div>` : ''}
  <div class="bot-header">
    <div class="bot-avatar">S</div>
    <span class="bot-name">${botName}</span>
    <span class="bot-time">${botTime}</span>
  </div>
  ${blocksHtml}
</div></body></html>`;
}

// ── Main ──
(async () => {
  const html = renderMessage(BLOCK_KIT_JSON);
  const htmlPath = '/tmp/block-kit-preview.html';
  writeFileSync(htmlPath, html);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  const container = page.locator('.message-container');
  const screenshotPath = '/tmp/block-kit-preview.png';
  await container.screenshot({ path: screenshotPath });
  console.log(`Screenshot saved: ${screenshotPath}`);

  await browser.close();
})();
```

### 4. 실행 및 스크린샷 확인
```bash
cd /tmp/{userId} && node block-kit-preview.mjs
```

### 5. 결과 확인
Read 도구로 생성된 PNG 파일을 열어 시각적으로 확인한다.

## 다중 변형 비교

여러 Block Kit JSON을 비교하려면 grid 레이아웃을 사용한다:

```javascript
const variants = [
  { json: VARIANT_A, label: 'Option A: Classic' },
  { json: VARIANT_B, label: 'Option B: Compact' },
];

const fullHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#f8f8f8; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; padding:30px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:24px; max-width:1500px; margin:0 auto; }
  /* ... same styles as single ... */
</style></head><body>
<h1>Block Kit Comparison</h1>
<div class="grid">
  ${variants.map(v => renderMessage(v.json, { label: v.label })).join('\n')}
</div></body></html>`;
```

## 지원하는 Block Kit 요소

| Block Type | 지원 수준 |
|------------|----------|
| `header` | Full |
| `divider` | Full |
| `section` (text) | Full (mrkdwn) |
| `section` (fields) | Full (2-column grid) |
| `section` (accessory: button) | Full (primary/danger/default) |
| `section` (accessory: image) | Basic |
| `context` | Full (mrkdwn, plain_text, image) |
| `actions` (buttons) | Full |
| `actions` (static_select) | Placeholder only |
| `image` | Basic |
| `input` | Placeholder only |
| `rich_text` | Not supported |

## Mrkdwn 파싱 지원

| Syntax | 예시 | 지원 |
|--------|-----|------|
| Bold | `*text*` | Yes |
| Italic | `_text_` | Yes |
| Strike | `~text~` | Yes |
| Code | `` `text` `` | Yes |
| Link | `<url\|label>` | Yes |

## 제한사항

- 실제 Slack 렌더링과 100% 동일하지 않음 (CSS 근사치)
- Emoji는 시스템 이모지로 렌더링 (Slack 커스텀 이모지 미지원)
- `rich_text` 블록은 미지원
- 이미지 URL은 실제 접근 가능한 URL이어야 렌더링됨
- Slack의 반응형 레이아웃(모바일)은 뷰포트 크기 조정으로 시뮬레이션 가능

## 출력 경로 규칙

- 단일 프리뷰: `/tmp/{userId}/block-kit-preview.png`
- 비교 프리뷰: `/tmp/{userId}/block-kit-comparison.png`
- 개별 변형: `/tmp/{userId}/variant-{label}.png`
