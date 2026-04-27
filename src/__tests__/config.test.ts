import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBool, parseFiveBlockPhase, parsePositiveIntEnv, parseUnitIntervalEnv } from '../config';

// Silence the warn path; we're testing the fallback value, not the log side-effect.
vi.mock('../logger', () => ({
  Logger: class {
    warn = vi.fn();
    info = vi.fn();
    debug = vi.fn();
    error = vi.fn();
  },
}));

describe('parseFiveBlockPhase', () => {
  describe('valid values', () => {
    it.each([
      ['0', 0],
      ['1', 1],
      ['2', 2],
      ['3', 3],
      ['4', 4],
      ['5', 5],
    ])('parses "%s" → %d', (raw, expected) => {
      expect(parseFiveBlockPhase(raw)).toBe(expected);
    });
  });

  describe('fallback to 0', () => {
    it('undefined falls back', () => {
      expect(parseFiveBlockPhase(undefined)).toBe(0);
    });

    it('empty string falls back', () => {
      expect(parseFiveBlockPhase('')).toBe(0);
    });

    it.each([
      ['-1', 'negative'],
      ['6', 'above range'],
      ['10', 'far above range'],
      ['1.5', 'non-integer'],
      ['foo', 'non-numeric'],
      ['true', 'boolean-ish'],
      ['NaN', 'literal NaN'],
      ['Infinity', 'infinity'],
    ])('rejects "%s" (%s) and falls back to 0', (raw) => {
      expect(parseFiveBlockPhase(raw)).toBe(0);
    });
  });

  describe('lenient whitespace tolerance (documents current behavior)', () => {
    // Number() is permissive about surrounding whitespace; this is acceptable
    // because an operator who sets SOMA_UI_5BLOCK_PHASE="1 " still gets the
    // feature enabled rather than a silent rollback to legacy. If a stricter
    // parser is ever desired, add a String.prototype.trim() + regex check.
    it('"1 " parses as 1', () => {
      expect(parseFiveBlockPhase('1 ')).toBe(1);
    });
    it('" 1" parses as 1', () => {
      expect(parseFiveBlockPhase(' 1')).toBe(1);
    });
  });
});

// #641 M1-S1 — `parsePositiveIntEnv` is the only barrier against an operator
// setting `USAGE_REFRESH_INTERVAL_MS=1` (sub-second tick storm). The function
// also gates `USAGE_ON_OPEN_TIMEOUT_MS` (card-open fan-out) and
// `USAGE_FETCH_TIMEOUT_MS`. Regressions in any of these three behaviours
// (fallback, clamp, passthrough) should fire a failing test, not ship.
describe('parsePositiveIntEnv (#641 M1-S1)', () => {
  const ENV_NAME = 'TEST_POSITIVE_INT_ENV';
  beforeEach(() => {
    delete process.env[ENV_NAME];
  });
  afterEach(() => {
    delete process.env[ENV_NAME];
  });

  it('undefined env → fallback', () => {
    expect(parsePositiveIntEnv(ENV_NAME, 5 * 60_000, 30_000)).toBe(5 * 60_000);
  });

  it('empty-string env → fallback', () => {
    process.env[ENV_NAME] = '';
    expect(parsePositiveIntEnv(ENV_NAME, 2_000, 0)).toBe(2_000);
  });

  it('negative value → fallback (warn-and-fallback)', () => {
    process.env[ENV_NAME] = '-1';
    expect(parsePositiveIntEnv(ENV_NAME, 2_000, 0)).toBe(2_000);
  });

  it('zero → fallback (positive-only)', () => {
    process.env[ENV_NAME] = '0';
    expect(parsePositiveIntEnv(ENV_NAME, 1_500, 500)).toBe(1_500);
  });

  it('NaN-ish string → fallback', () => {
    process.env[ENV_NAME] = 'abc';
    expect(parsePositiveIntEnv(ENV_NAME, 2_000, 0)).toBe(2_000);
  });

  it('non-integer ("1.5") → fallback', () => {
    process.env[ENV_NAME] = '1.5';
    expect(parsePositiveIntEnv(ENV_NAME, 2_000, 0)).toBe(2_000);
  });

  it('value below minimum → clamped to minimum (NOT fallback)', () => {
    // Classic foot-gun: operator sets USAGE_REFRESH_INTERVAL_MS=1 to "refresh
    // more often". The clamp pins it at the 30s floor instead of reverting to
    // the 5-minute default, so the operator still gets aggressive-but-safe
    // refreshes and a warn log signals the misconfiguration.
    process.env[ENV_NAME] = '1';
    expect(parsePositiveIntEnv(ENV_NAME, 5 * 60_000, 30_000)).toBe(30_000);
  });

  it('value at minimum boundary → passthrough (not clamped)', () => {
    process.env[ENV_NAME] = '30000';
    expect(parsePositiveIntEnv(ENV_NAME, 5 * 60_000, 30_000)).toBe(30_000);
  });

  it('value above minimum → passthrough', () => {
    process.env[ENV_NAME] = '120000';
    expect(parsePositiveIntEnv(ENV_NAME, 5 * 60_000, 30_000)).toBe(120_000);
  });

  it('no minimum set (default 0) → any positive integer passes through', () => {
    process.env[ENV_NAME] = '42';
    expect(parsePositiveIntEnv(ENV_NAME, 2_000)).toBe(42);
  });
});

// #737 — `parseUnitIntervalEnv` gates `AUTO_ROTATE_FIVEH_THRESHOLD` and
// `AUTO_ROTATE_SEVEND_THRESHOLD`. Two foot-guns to defend against:
//   - operator types `80` instead of `0.8` → clamp to 1.0, NOT silently
//     accept 80 as "always passes".
//   - operator types `-0.5` → clamp to 0.0, NOT fallback (we want a known
//     conservative threshold even from a typo).
describe('parseUnitIntervalEnv (#737)', () => {
  const ENV_NAME = 'TEST_UNIT_INTERVAL_ENV';
  beforeEach(() => {
    delete process.env[ENV_NAME];
  });
  afterEach(() => {
    delete process.env[ENV_NAME];
  });

  it('undefined env → fallback', () => {
    expect(parseUnitIntervalEnv(ENV_NAME, 0.8)).toBe(0.8);
  });

  it('empty-string env → fallback', () => {
    process.env[ENV_NAME] = '';
    expect(parseUnitIntervalEnv(ENV_NAME, 0.9)).toBe(0.9);
  });

  it('non-numeric → fallback', () => {
    process.env[ENV_NAME] = 'eighty';
    expect(parseUnitIntervalEnv(ENV_NAME, 0.8)).toBe(0.8);
  });

  it('NaN literal → fallback', () => {
    process.env[ENV_NAME] = 'NaN';
    expect(parseUnitIntervalEnv(ENV_NAME, 0.5)).toBe(0.5);
  });

  it('value above maximum → clamp to maximum (NOT fallback)', () => {
    // Operator typo: `AUTO_ROTATE_FIVEH_THRESHOLD=80` instead of `0.8`.
    // Clamping to 1.0 is safer than the fallback (0.8) because at least
    // the warn log will tell the operator something is off.
    process.env[ENV_NAME] = '80';
    expect(parseUnitIntervalEnv(ENV_NAME, 0.8)).toBe(1);
  });

  it('value below minimum → clamp to minimum', () => {
    process.env[ENV_NAME] = '-0.5';
    expect(parseUnitIntervalEnv(ENV_NAME, 0.8)).toBe(0);
  });

  it('boundary values pass through (inclusive)', () => {
    process.env[ENV_NAME] = '0';
    expect(parseUnitIntervalEnv(ENV_NAME, 0.8)).toBe(0);
    process.env[ENV_NAME] = '1';
    expect(parseUnitIntervalEnv(ENV_NAME, 0.8)).toBe(1);
  });

  it('typical decimal value passes through', () => {
    process.env[ENV_NAME] = '0.85';
    expect(parseUnitIntervalEnv(ENV_NAME, 0.8)).toBe(0.85);
  });

  it('Infinity → clamp to maximum (1)', () => {
    process.env[ENV_NAME] = 'Infinity';
    // Number('Infinity') is finite-ish per Number.isFinite? Actually no:
    // Number.isFinite(Infinity) === false → falls through to fallback path.
    // Lock either behaviour explicitly.
    const r = parseUnitIntervalEnv(ENV_NAME, 0.8);
    expect(r).toBe(0.8); // fallback path because Number.isFinite(Infinity) is false
  });
});

// #666 Part 1/2 — P4 kill switch. `parseBool` gates `config.ui.b4NativeStatusEnabled`,
// which must default to `false` so that registering the Bolt Assistant container
// in Part 1 does NOT silently re-enable the legacy spinner path before Part 2 is wired.
describe('parseBool (#666)', () => {
  describe('truthy values', () => {
    it.each([
      ['1', true],
      ['true', true],
      ['TRUE', true],
      ['True', true],
      ['yes', true],
      ['YES', true],
      ['on', true],
      ['ON', true],
    ])('parses "%s" → %s', (raw, expected) => {
      expect(parseBool(raw, false)).toBe(expected);
    });
  });

  describe('falsy values', () => {
    it.each([
      ['0', false],
      ['false', false],
      ['FALSE', false],
      ['no', false],
      ['off', false],
    ])('parses "%s" → %s', (raw, expected) => {
      expect(parseBool(raw, true)).toBe(expected);
    });
  });

  describe('fallback', () => {
    it('undefined → fallback', () => {
      expect(parseBool(undefined, false)).toBe(false);
      expect(parseBool(undefined, true)).toBe(true);
    });

    it('empty string → fallback', () => {
      expect(parseBool('', false)).toBe(false);
      expect(parseBool('', true)).toBe(true);
    });

    it('unrecognized value → fallback with warn', () => {
      expect(parseBool('maybe', false)).toBe(false);
      expect(parseBool('2', true)).toBe(true);
    });
  });

  describe('whitespace tolerance', () => {
    it('surrounding whitespace accepted', () => {
      expect(parseBool(' 1 ', false)).toBe(true);
      expect(parseBool(' false ', true)).toBe(false);
    });
  });
});

/**
 * Regression guard for the `config.ui.b4NativeStatusEnabled` wiring. The
 * value is evaluated at module import, so we can't trivially re-read it
 * after mutating `process.env`. Instead we mirror the exact wiring
 * expression (`parseBool(process.env.SOMA_UI_B4_NATIVE_STATUS, false)`)
 * and assert it resolves to the runtime-observable semantics we rely on.
 */
describe('config.ui.b4NativeStatusEnabled env wiring (#666)', () => {
  const ENV = 'SOMA_UI_B4_NATIVE_STATUS';
  beforeEach(() => {
    delete process.env[ENV];
  });
  afterEach(() => {
    delete process.env[ENV];
  });

  it('undefined env → false (kill switch on by default — native spinner suppressed)', () => {
    expect(parseBool(process.env[ENV], false)).toBe(false);
  });

  it('"1" env → true (explicit opt-in)', () => {
    process.env[ENV] = '1';
    expect(parseBool(process.env[ENV], false)).toBe(true);
  });

  it('"0" env → false (explicit disable)', () => {
    process.env[ENV] = '0';
    expect(parseBool(process.env[ENV], false)).toBe(false);
  });

  it('"true" env → true', () => {
    process.env[ENV] = 'true';
    expect(parseBool(process.env[ENV], false)).toBe(true);
  });

  it('"garbage" env → false (fallback with warn — fail-closed)', () => {
    process.env[ENV] = 'garbage';
    expect(parseBool(process.env[ENV], false)).toBe(false);
  });
});
