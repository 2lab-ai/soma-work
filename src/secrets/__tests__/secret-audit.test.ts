import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendSecretAudit, lastSecretChanges, SECRET_AUDIT_FILE } from '../secret-audit';

/**
 * secret-access WU1 (#1337, .prd/33 §2.1): one JSON line per change an admin makes to the secret store — who,
 * when, what, which name. Never the value: the record type has no field for it and the writer keeps only the
 * fields it knows.
 */

describe('secret-audit', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-audit-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('appends one 0600 line per change and keeps only the known fields', () => {
    appendSecretAudit({ actor: 'U_ADMIN', action: 'secret.create', name: 'gh-token' }, dir, new Date(1_000));
    // A caller that slips a value in (a bug) still never writes it.
    appendSecretAudit(
      { actor: 'U_ADMIN', action: 'secret.overwrite', name: 'gh-token', value: 'LEAK-MARKER' } as never,
      dir,
      new Date(2_000),
    );
    const file = path.join(dir, SECRET_AUDIT_FILE);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const raw = fs.readFileSync(file, 'utf-8');
    expect(raw).not.toContain('LEAK-MARKER');
    const lines = raw
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { at: new Date(1_000).toISOString(), actor: 'U_ADMIN', action: 'secret.create', name: 'gh-token' },
      { at: new Date(2_000).toISOString(), actor: 'U_ADMIN', action: 'secret.overwrite', name: 'gh-token' },
    ]);
  });

  it('starts a new line after a torn one', () => {
    fs.writeFileSync(path.join(dir, SECRET_AUDIT_FILE), '{"torn":', { mode: 0o600 });
    appendSecretAudit({ actor: 'U', action: 'secret.delete', name: 'x' }, dir, new Date(0));
    const lines = fs.readFileSync(path.join(dir, SECRET_AUDIT_FILE), 'utf-8').split('\n');
    expect(JSON.parse(lines[1]).action).toBe('secret.delete');
  });

  it('answers the last change per name, a deletion included', () => {
    appendSecretAudit({ actor: 'U1', action: 'secret.create', name: 'a' }, dir, new Date(1_000));
    appendSecretAudit({ actor: 'U2', action: 'secret.overwrite', name: 'a' }, dir, new Date(3_000));
    appendSecretAudit({ actor: 'U1', action: 'secret.create', name: 'b' }, dir, new Date(2_000));
    const last = lastSecretChanges(dir);
    expect(last.get('a')).toEqual({ at: new Date(3_000).toISOString(), actor: 'U2', action: 'secret.overwrite' });
    expect(last.get('b')?.actor).toBe('U1');
    expect(lastSecretChanges(path.join(dir, 'none')).size).toBe(0);
  });

  it('refuses to write through a link', () => {
    const outside = path.join(dir, 'outside.jsonl');
    fs.writeFileSync(outside, '');
    fs.symlinkSync(outside, path.join(dir, SECRET_AUDIT_FILE));
    expect(() => appendSecretAudit({ actor: 'U', action: 'secret.create', name: 'x' }, dir)).toThrow();
    expect(fs.readFileSync(outside, 'utf-8')).toBe('');
  });
});

describe('secret-audit — answers and grants (secret-access WU2)', () => {
  it('records who the answer was about, and the tool and server of the card', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-audit-wu2-'));
    try {
      appendSecretAudit(
        { actor: 'U_ADMIN', action: 'use.always', name: 'gh-token', userId: 'U_REQ', tool: 'gh_pr', server: 'dev2' },
        dir,
        new Date(0),
      );
      const line = JSON.parse(fs.readFileSync(path.join(dir, SECRET_AUDIT_FILE), 'utf-8'));
      expect(line).toEqual({
        at: new Date(0).toISOString(),
        actor: 'U_ADMIN',
        action: 'use.always',
        name: 'gh-token',
        userId: 'U_REQ',
        tool: 'gh_pr',
        server: 'dev2',
      });
      // a grant change is not a change of the secret itself
      expect(lastSecretChanges(dir).size).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
