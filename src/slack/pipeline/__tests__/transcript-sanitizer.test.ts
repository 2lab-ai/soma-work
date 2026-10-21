/**
 * Transcript sanitizer — unit tests.
 *
 * Field incident (2026-07-07, session ccee16e0): a gpt-5.5 turn persisted an
 * assistant message with a single `{"type":"text","text":""}` block into the
 * SDK transcript. Every subsequent Anthropic-model request over that history
 * (fallback `/compact`, normal turns after the model switch) failed with
 * `400 "messages: text content blocks must be non-empty"` — session wedged.
 * The sanitizer repairs exactly that poison.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  EMPTY_TEXT_REPAIR_MARKER,
  findTranscriptPath,
  sanitizeTranscriptEmptyTextBlocks,
} from '@soma/slack/pipeline/transcript-sanitizer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SESSION_ID = 'ccee16e0-ffed-4c59-a1c1-732b89c5cf53';

let configDir: string;
let projectDir: string;

function writeTranscript(lines: unknown[]): string {
  const p = path.join(projectDir, `${SESSION_ID}.jsonl`);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');
  return p;
}

function readTranscript(p: string): any[] {
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l));
}

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-sanitizer-'));
  projectDir = path.join(configDir, 'projects', '-tmp-U123-session-42');
  fs.mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('findTranscriptPath', () => {
  it('locates the session jsonl under projects/<encoded-cwd>/', () => {
    const p = writeTranscript([{ type: 'user', message: { role: 'user', content: 'hi' } }]);
    expect(findTranscriptPath(SESSION_ID, configDir)).toBe(p);
  });

  it('returns null for a non-UUID session id (path-traversal guard)', () => {
    expect(findTranscriptPath('../../etc/passwd', configDir)).toBeNull();
    expect(findTranscriptPath('sess_ptl', configDir)).toBeNull();
  });

  it('returns null when the session file does not exist', () => {
    expect(findTranscriptPath(SESSION_ID, configDir)).toBeNull();
  });
});

describe('sanitizeTranscriptEmptyTextBlocks', () => {
  it('replaces a sole empty text block with the repair marker (incident shape, line 1311)', () => {
    // Exact incident shape: assistant record whose content is ONLY an empty
    // text block (stop_reason=tool_use; the tool_use lives in the next record).
    const p = writeTranscript([
      { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] } },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        message: { role: 'assistant', content: [{ type: 'text', text: '' }], stop_reason: 'tool_use' },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'a1',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: {} }] },
      },
    ]);

    const res = sanitizeTranscriptEmptyTextBlocks(SESSION_ID, { configDir });

    expect(res.transcriptPath).toBe(p);
    expect(res.repairedBlocks).toBe(1);
    const records = readTranscript(p);
    // Record count and lineage untouched.
    expect(records).toHaveLength(3);
    expect(records[1].uuid).toBe('a1');
    expect(records[1].parentUuid).toBe('u1');
    // Sole empty block replaced, never left empty.
    expect(records[1].message.content).toEqual([{ type: 'text', text: EMPTY_TEXT_REPAIR_MARKER }]);
  });

  it('drops empty text blocks when other content blocks remain', () => {
    const p = writeTranscript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
          ],
        },
      },
    ]);

    const res = sanitizeTranscriptEmptyTextBlocks(SESSION_ID, { configDir });

    expect(res.repairedBlocks).toBe(1);
    const records = readTranscript(p);
    expect(records[0].message.content).toEqual([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]);
  });

  it('treats whitespace-only and missing text as empty', () => {
    writeTranscript([
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '   ' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text' }] } },
    ]);

    const res = sanitizeTranscriptEmptyTextBlocks(SESSION_ID, { configDir });
    expect(res.repairedBlocks).toBe(2);
  });

  it('is a no-op on a clean transcript (returns 0, file byte-identical)', () => {
    const p = writeTranscript([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'world' }] } },
    ]);
    const before = fs.readFileSync(p, 'utf8');

    const res = sanitizeTranscriptEmptyTextBlocks(SESSION_ID, { configDir });

    expect(res.repairedBlocks).toBe(0);
    expect(fs.readFileSync(p, 'utf8')).toBe(before);
  });

  it('passes malformed lines through untouched while repairing valid ones', () => {
    const p = path.join(projectDir, `${SESSION_ID}.jsonl`);
    const malformed = '{"type":"assistant","message":{"content":[{"type":"text"'; // truncated JSON
    const poisoned = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '' }] },
    });
    fs.writeFileSync(p, `${malformed}\n${poisoned}`, 'utf8');

    const res = sanitizeTranscriptEmptyTextBlocks(SESSION_ID, { configDir });

    expect(res.repairedBlocks).toBe(1);
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    expect(lines[0]).toBe(malformed);
  });

  it('does not touch string-typed content or non-message records', () => {
    const p = writeTranscript([
      { type: 'system', subtype: 'local_command', content: '<local-command-stderr>Error…</local-command-stderr>' },
      { type: 'user', message: { role: 'user', content: 'plain string content' } },
    ]);
    const before = fs.readFileSync(p, 'utf8');

    const res = sanitizeTranscriptEmptyTextBlocks(SESSION_ID, { configDir });

    expect(res.repairedBlocks).toBe(0);
    expect(fs.readFileSync(p, 'utf8')).toBe(before);
  });

  it('returns transcriptPath=null when the session file is missing', () => {
    const res = sanitizeTranscriptEmptyTextBlocks(SESSION_ID, { configDir });
    expect(res.transcriptPath).toBeNull();
    expect(res.repairedBlocks).toBe(0);
  });
});
