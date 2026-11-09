/**
 * SSOT 2026-11-09 T4/T5 — one visual is one artifact. Every file a skill uploads to the thread becomes an entry
 * in the dashboard's 산출물, so a skill that uploads a picture of its own HTML (or the source next to the image,
 * or a still next to the film) lists the same visual twice. The html skill dropped its PNG on 2026-11-02; these
 * pin that and the visual skills that still uploaded two files.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const skill = (name: string) => readFileSync(resolve(__dirname, '..', '..', name, 'SKILL.md'), 'utf-8');
const section = (md: string, from: string, to: string) => md.slice(md.indexOf(from), md.indexOf(to, md.indexOf(from)));

describe('one visual, one artifact', () => {
  it('html: uploads the HTML only — the PNG is a QA snapshot (already so since 2026-11-02)', () => {
    const md = skill('html');
    const step8 = section(md, '### 8. Upload the HTML to Slack', '### 9. End the turn');
    expect(step8).toContain('mcp__slack-mcp__send_file(');
    expect(step8).toContain('Do **not** upload the PNG.');
  });

  it('architecture-diagram: uploads the PNG alone; the .excalidraw source only when asked', () => {
    const md = skill('architecture-diagram');
    expect(md).not.toMatch(/upload both|Dual upload/i);
    const step8 = section(md, '### 8. Upload the PNG to Slack', '### 9. End the turn');
    expect(step8).toContain('mcp__slack-mcp__send_media(');
    expect(step8).not.toContain('mcp__slack-mcp__send_file(');
    expect(step8).toContain('only when the user asks for the editable source');
  });

  it('diagram (GENERAL): uploads the PNG alone', () => {
    const md = skill('diagram');
    const general = section(md, '### GENERAL', '### MIXED');
    expect(general).not.toMatch(/Dual upload/);
    expect(general).toContain('Upload the PNG alone via `mcp__slack-mcp__send_media`');
    expect(general).toContain('only when the user asks for the editable source');
  });

  it('dimensional-drawing-motion: uploads the MP4 alone, no still', () => {
    const md = skill('dimensional-drawing-motion');
    expect(md).not.toMatch(/MP4 and one still/);
    expect(md).toContain('Upload the MP4 alone with `mcp__slack-mcp__send_media`');
  });

  it('dimensional-drawing: uploads the HTML only (already so)', () => {
    expect(skill('dimensional-drawing')).toMatch(/never upload the PNG snapshot/);
  });

  it('qa-report: one HTML, no PNG preview rendered or uploaded', () => {
    const md = skill('qa-report');
    expect(md).not.toMatch(/Render the PNG|png=<abs>|plus a PNG preview/);
    expect(md).toContain('no PNG preview');
  });
});
