import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  normalizePhoneNumber,
  PhoneConfigError,
  parsePhoneRequest,
  parsePhoneSection,
  writeJsonFileAtomic,
} from '../phone';

const SECTION = {
  apiKey: { $secret: 'koreaaitel-test' },
  accountId: 'ACtest0000',
  number: '070-1234-5678',
  owner: 'U0TESTUSER',
  voice: { url: 'http://voice-host:9999' },
};

describe('normalizePhoneNumber', () => {
  it('accepts Korean numbers in the shapes people write them', () => {
    expect(normalizePhoneNumber('010-1234-5678')).toBe('01012345678');
    expect(normalizePhoneNumber('+82 10 1234 5678')).toBe('01012345678');
    expect(normalizePhoneNumber('(02) 123-4567')).toBe('021234567');
    expect(normalizePhoneNumber('1544-6486')).toBe('15446486');
  });
  it('refuses anything else', () => {
    for (const bad of ['', '112', '12345678901234', '010-12a4-5678', '+1 415 555 0100', 42]) {
      expect(normalizePhoneNumber(bad)).toBeNull();
    }
  });
});

describe('parsePhoneSection', () => {
  it('fills the defaults: cwon on Drama 3, 5 minutes, inbound on with a greeting', () => {
    const c = parsePhoneSection('2lab-ai-dev', SECTION);
    expect(c.number).toBe('07012345678');
    expect(c.voice).toEqual({ url: 'http://voice-host:9999', voice: 'cwon', model: 'drama-3', language: 'ko' });
    expect(c.outbound.maxMinutes).toBe(5);
    expect(c.inbound.enabled).toBe(true);
    expect(c.inbound.greeting).toContain('안녕하세요');
    expect(c.apiKey).toEqual({ $secret: 'koreaaitel-test' });
  });

  it('normalizes allowTo and refuses a bad entry', () => {
    expect(parsePhoneSection('e', { ...SECTION, outbound: { allowTo: ['010-1111-2222'] } }).outbound.allowTo).toEqual([
      '01011112222',
    ]);
    expect(() => parsePhoneSection('e', { ...SECTION, outbound: { allowTo: ['nope'] } })).toThrow(PhoneConfigError);
  });

  it('names the field, never the value', () => {
    expect(() => parsePhoneSection('e', { ...SECTION, accountId: 'sk_secret' })).toThrow(/phone\.accountId/);
    try {
      parsePhoneSection('e', { ...SECTION, accountId: 'sk_secret' });
    } catch (err) {
      expect((err as Error).message).not.toContain('sk_secret');
    }
    expect(() => parsePhoneSection('e', { ...SECTION, apiKey: '' })).toThrow(/phone\.apiKey/);
    expect(
      parsePhoneSection('e', { ...SECTION, voice: { url: 'http://voice-host:9999', speed: 1.5 } }).voice.speed,
    ).toBe(1.5);
    for (const speed of [0.3, 3, 'fast', 0]) {
      expect(() => parsePhoneSection('e', { ...SECTION, voice: { url: 'http://voice-host:9999', speed } })).toThrow(
        /phone\.voice\.speed/,
      );
    }
    expect(() => parsePhoneSection('e', { ...SECTION, voice: { url: 'ftp://x' } })).toThrow(/voice\.url/);
    expect(() => parsePhoneSection('e', { ...SECTION, outbound: { maxMinutes: 99 } })).toThrow(/maxMinutes/);
    expect(() => parsePhoneSection('e', { ...SECTION, owner: 'zhuge' })).toThrow(/owner/);
  });
});

describe('request files', () => {
  it('parses a request field by field and clamps what it can', () => {
    const r = parsePhoneRequest({
      rid: 'abc123def456',
      env: 'e',
      to: '010-1234-5678',
      title: 'x'.repeat(500),
      purpose: 'p',
      maxMinutes: 99,
      requester: 'U0TESTUSER',
      context: { channel: 'C1', threadTs: '1.2', conversationId: 'conv', extra: 1 },
      createdAt: 5,
    });
    expect(r).toMatchObject({
      to: '01012345678',
      maxMinutes: 30,
      context: { channel: 'C1', threadTs: '1.2', conversationId: 'conv' },
    });
    expect(r?.title).toHaveLength(120);
  });

  it('refuses a request without a valid id, number or requester', () => {
    const ok = { rid: 'abc123def456', env: 'e', to: '01012345678', requester: 'U1' };
    expect(parsePhoneRequest(ok)).not.toBeNull();
    expect(parsePhoneRequest({ ...ok, rid: '../x' })).toBeNull();
    expect(parsePhoneRequest({ ...ok, to: '911' })).toBeNull();
    expect(parsePhoneRequest({ ...ok, requester: 'someone' })).toBeNull();
    expect(parsePhoneRequest(null)).toBeNull();
  });

  it('writes a whole file (0600) or nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-req-'));
    try {
      const f = path.join(dir, 'requests', 'r.json');
      writeJsonFileAtomic(f, { a: 1 });
      expect(JSON.parse(fs.readFileSync(f, 'utf-8'))).toEqual({ a: 1 });
      expect(fs.statSync(f).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(path.dirname(f))).toEqual(['r.json']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
