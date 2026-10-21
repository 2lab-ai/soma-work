import { describe, expect, it } from 'vitest';
import { CommandParser } from '../command-parser';

describe('CommandParser.isAutoskillCommand', () => {
  it.each([
    'autoskill',
    'set autoskill',
    'set autoskill using-ssot, using-govuk',
    '/autoskill',
    '/set autoskill autoz',
    'autoskill clear',
  ])('recognizes "%s"', (text) => {
    expect(CommandParser.isAutoskillCommand(text)).toBe(true);
  });

  it.each(['autoskills', 'auto skill', 'skills list', 'set email x@y.com', 'hello'])('rejects "%s"', (text) => {
    expect(CommandParser.isAutoskillCommand(text)).toBe(false);
  });
});

describe('CommandParser.parseAutoskillCommand', () => {
  it('bare autoskill → status', () => {
    expect(CommandParser.parseAutoskillCommand('autoskill')).toEqual({ action: 'status' });
  });

  it('set autoskill with no list → status', () => {
    expect(CommandParser.parseAutoskillCommand('set autoskill')).toEqual({ action: 'status' });
  });

  it('comma-separated list → set', () => {
    expect(CommandParser.parseAutoskillCommand('set autoskill using-ssot, using-govuk')).toEqual({
      action: 'set',
      skills: ['using-ssot', 'using-govuk'],
    });
  });

  it('whitespace-separated list → set', () => {
    expect(CommandParser.parseAutoskillCommand('set autoskill using-ssot using-govuk autoz')).toEqual({
      action: 'set',
      skills: ['using-ssot', 'using-govuk', 'autoz'],
    });
  });

  it('strips leading $ from tokens', () => {
    expect(CommandParser.parseAutoskillCommand('set autoskill $using-ssot, $autoz')).toEqual({
      action: 'set',
      skills: ['using-ssot', 'autoz'],
    });
  });

  it.each(['clear', 'none', 'off', 'reset'])('"%s" clears the list', (kw) => {
    expect(CommandParser.parseAutoskillCommand(`set autoskill ${kw}`)).toEqual({ action: 'set', skills: [] });
    expect(CommandParser.parseAutoskillCommand(`autoskill ${kw}`)).toEqual({ action: 'set', skills: [] });
  });

  it('mixed delimiters collapse to a clean list', () => {
    expect(CommandParser.parseAutoskillCommand('autoskill a,  b ,c')).toEqual({
      action: 'set',
      skills: ['a', 'b', 'c'],
    });
  });
});
