/**
 * Files the CLI loads when a session starts (env-access, #1242): moved out of a model's reach before every
 * start, and refused to the file tools while the session runs.
 */

import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guardSessionStartFiles, SessionStartFileError, sessionStartFileDenyRules } from '../session-start-files';

let base: string;
let userRoot: string;
let cwd: string;
let quarantine: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'start-files-')));
  userRoot = path.join(base, 'U1');
  cwd = path.join(userRoot, 'session');
  quarantine = path.join(base, 'data', 'quarantine');
  fs.mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function write(p: string, text = '{}') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

const guard = () => guardSessionStartFiles({ cwd, writeRoots: [cwd, userRoot], quarantineDir: quarantine });

describe('guardSessionStartFiles', () => {
  it('moves the session settings and the project MCP config out of the session directory', () => {
    write(path.join(cwd, '.claude', 'settings.json'), '{"a":1}');
    write(path.join(cwd, '.claude', 'settings.local.json'), '{"b":2}');
    write(path.join(cwd, '.mcp.json'), '{"c":3}');
    const moved = guard();
    expect(moved.map((m) => path.relative(cwd, m.from)).sort()).toEqual(
      ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json'].sort(),
    );
    for (const m of moved) {
      expect(fs.existsSync(m.from)).toBe(false);
      expect(m.to.startsWith(quarantine + path.sep)).toBe(true);
      expect(fs.existsSync(m.to)).toBe(true);
    }
    const mcp = moved.find((m) => m.from.endsWith('.mcp.json'));
    expect(mcp && fs.readFileSync(mcp.to, 'utf8')).toBe('{"c":3}');
  });

  it('keeps the rest of .claude (plans, skills) where it is', () => {
    write(path.join(cwd, '.claude', 'plans', 'p.md'), '# plan');
    write(path.join(cwd, '.claude', 'settings.json'));
    guard();
    expect(fs.existsSync(path.join(cwd, '.claude', 'plans', 'p.md'))).toBe(true);
  });

  it('moves a .claude that is a link, not what it points at', () => {
    const elsewhere = path.join(userRoot, 'elsewhere');
    write(path.join(elsewhere, 'settings.json'), '{"x":1}');
    fs.symlinkSync(elsewhere, path.join(cwd, '.claude'));
    const moved = guard();
    expect(moved.map((m) => m.from)).toEqual([path.join(cwd, '.claude')]);
    expect(fs.existsSync(path.join(cwd, '.claude'))).toBe(false);
    expect(fs.readFileSync(path.join(elsewhere, 'settings.json'), 'utf8')).toBe('{"x":1}');
  });

  it('moves a settings file that is itself a link', () => {
    write(path.join(userRoot, 'real.json'), '{"y":1}');
    fs.mkdirSync(path.join(cwd, '.claude'));
    fs.symlinkSync(path.join(userRoot, 'real.json'), path.join(cwd, '.claude', 'settings.json'));
    const moved = guard();
    expect(moved).toHaveLength(1);
    expect(fs.existsSync(path.join(userRoot, 'real.json'))).toBe(true);
    expect(() => fs.lstatSync(path.join(cwd, '.claude', 'settings.json'))).toThrow();
  });

  it('moves .mcp.json above the session directory while still inside a write root, and nothing above the roots', () => {
    write(path.join(userRoot, '.mcp.json'), '{"up":1}');
    write(path.join(base, '.mcp.json'), '{"operator":1}');
    const moved = guard();
    expect(moved.map((m) => m.from)).toEqual([path.join(userRoot, '.mcp.json')]);
    expect(fs.existsSync(path.join(base, '.mcp.json'))).toBe(true);
  });

  it('never touches settings above the session directory: that can be the home directory', () => {
    write(path.join(userRoot, '.claude', 'settings.json'), '{"home":1}');
    expect(guard()).toEqual([]);
    expect(fs.existsSync(path.join(userRoot, '.claude', 'settings.json'))).toBe(true);
  });

  it('does nothing, and creates no quarantine, when no such file exists', () => {
    expect(guard()).toEqual([]);
    expect(fs.existsSync(quarantine)).toBe(false);
  });

  it('works for a session directory written through a link (/tmp on macOS)', () => {
    const alias = path.join(base, 'alias');
    fs.symlinkSync(userRoot, alias);
    write(path.join(cwd, '.mcp.json'));
    const moved = guardSessionStartFiles({
      cwd: path.join(alias, 'session'),
      writeRoots: [path.join(alias, 'session'), alias],
      quarantineDir: quarantine,
    });
    expect(moved).toHaveLength(1);
    expect(fs.existsSync(path.join(cwd, '.mcp.json'))).toBe(false);
  });

  it('copies and removes when the quarantine is on another volume (EXDEV)', () => {
    write(path.join(cwd, '.mcp.json'), '{"z":1}');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
    });
    const moved = guard();
    expect(moved).toHaveLength(1);
    expect(fs.existsSync(path.join(cwd, '.mcp.json'))).toBe(false);
    expect(fs.readFileSync(moved[0].to, 'utf8')).toBe('{"z":1}');
  });

  it('fails closed: a file it cannot move stops the session from starting', () => {
    write(path.join(cwd, '.mcp.json'));
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    expect(guard).toThrow(SessionStartFileError);
  });
});

describe('sessionStartFileDenyRules', () => {
  it('refuses the file tools the same files: settings in the session directory, .mcp.json up to the write roots', () => {
    const rules = sessionStartFileDenyRules({ cwd, writeRoots: [cwd, userRoot] });
    expect(rules).toEqual(
      expect.arrayContaining([
        `Edit(/${path.join(cwd, '.claude', 'settings.json')})`,
        `Edit(/${path.join(cwd, '.claude', 'settings.local.json')})`,
        `Edit(/${path.join(cwd, '.mcp.json')})`,
        `Edit(/${path.join(userRoot, '.mcp.json')})`,
      ]),
    );
    expect(rules).not.toContain(`Edit(/${path.join(base, '.mcp.json')})`);
    expect(rules).not.toContain(`Edit(/${path.join(userRoot, '.claude', 'settings.json')})`);
    expect(rules.every((r) => r.startsWith('Edit(//'))).toBe(true);
  });

  it('names both spellings of a linked session directory', () => {
    const alias = path.join(base, 'alias2');
    fs.symlinkSync(userRoot, alias);
    const rules = sessionStartFileDenyRules({ cwd: path.join(alias, 'session'), writeRoots: [alias] });
    expect(rules).toContain(`Edit(/${path.join(alias, 'session', '.mcp.json')})`);
    expect(rules).toContain(`Edit(/${path.join(cwd, '.mcp.json')})`);
  });
});
