import { describe, expect, it, vi } from 'vitest';
import { isBlockedIp, validateWebhookUrl, validateWebhookUrlWithDns } from './webhook-url-validator';

describe('validateWebhookUrl', () => {
  it('accepts valid HTTPS URL', () => {
    expect(validateWebhookUrl('https://example.com/webhook')).toEqual({ valid: true });
  });

  it('accepts HTTPS with port', () => {
    expect(validateWebhookUrl('https://api.example.com:8443/hook')).toEqual({ valid: true });
  });

  it('rejects HTTP URL', () => {
    const result = validateWebhookUrl('http://example.com/webhook');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('HTTPS');
  });

  it('rejects FTP URL', () => {
    const result = validateWebhookUrl('ftp://example.com/file');
    expect(result.valid).toBe(false);
  });

  it('rejects file:// URL', () => {
    const result = validateWebhookUrl('file:///etc/passwd');
    expect(result.valid).toBe(false);
  });

  it('rejects invalid URL', () => {
    const result = validateWebhookUrl('not-a-url');
    expect(result.valid).toBe(false);
  });

  // SSRF: loopback
  it('rejects localhost', () => {
    const result = validateWebhookUrl('https://localhost/hook');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('내부');
  });

  it('rejects 127.0.0.1', () => {
    const result = validateWebhookUrl('https://127.0.0.1/hook');
    expect(result.valid).toBe(false);
  });

  it('rejects 0.0.0.0', () => {
    const result = validateWebhookUrl('https://0.0.0.0/hook');
    expect(result.valid).toBe(false);
  });

  // SSRF: private ranges
  it('rejects 10.x.x.x', () => {
    const result = validateWebhookUrl('https://10.0.0.1/hook');
    expect(result.valid).toBe(false);
  });

  it('rejects 172.16.x.x', () => {
    const result = validateWebhookUrl('https://172.16.0.1/hook');
    expect(result.valid).toBe(false);
  });

  it('rejects 192.168.x.x', () => {
    const result = validateWebhookUrl('https://192.168.1.1/hook');
    expect(result.valid).toBe(false);
  });

  // SSRF: AWS metadata
  it('rejects 169.254.169.254 (AWS metadata)', () => {
    const result = validateWebhookUrl('https://169.254.169.254/latest/meta-data/');
    expect(result.valid).toBe(false);
  });

  // SSRF: GCP metadata
  it('rejects metadata.google.internal', () => {
    const result = validateWebhookUrl('https://metadata.google.internal/computeMetadata/v1/');
    expect(result.valid).toBe(false);
  });

  // Edge: 172.15 and 172.32 should be allowed (not in 172.16-31 range)
  it('accepts 172.15.x.x (not private)', () => {
    expect(validateWebhookUrl('https://172.15.0.1/hook')).toEqual({ valid: true });
  });

  it('accepts 172.32.x.x (not private)', () => {
    expect(validateWebhookUrl('https://172.32.0.1/hook')).toEqual({ valid: true });
  });

  // SSRF: CGNAT (RFC 6598)
  it('rejects 100.64.x.x (CGNAT)', () => {
    const result = validateWebhookUrl('https://100.64.0.1/hook');
    expect(result.valid).toBe(false);
  });

  it('rejects 100.127.x.x (CGNAT upper bound)', () => {
    const result = validateWebhookUrl('https://100.127.255.1/hook');
    expect(result.valid).toBe(false);
  });

  it('accepts 100.63.x.x (not CGNAT)', () => {
    expect(validateWebhookUrl('https://100.63.0.1/hook')).toEqual({ valid: true });
  });

  // SSRF: benchmarking (198.18/15)
  it('rejects 198.18.x.x (benchmarking)', () => {
    const result = validateWebhookUrl('https://198.18.0.1/hook');
    expect(result.valid).toBe(false);
  });

  // SSRF: IPv6 loopback
  it('rejects [::1] (IPv6 loopback)', () => {
    const result = validateWebhookUrl('https://[::1]/hook');
    expect(result.valid).toBe(false);
  });

  it('rejects [::0] (IPv6 unspecified)', () => {
    const result = validateWebhookUrl('https://[::0]/hook');
    expect(result.valid).toBe(false);
  });

  // SSRF: IPv6-mapped IPv4
  it('rejects [::ffff:127.0.0.1] (IPv6-mapped loopback)', () => {
    const result = validateWebhookUrl('https://[::ffff:127.0.0.1]/hook');
    expect(result.valid).toBe(false);
  });

  it('rejects [::ffff:10.0.0.1] (IPv6-mapped private)', () => {
    const result = validateWebhookUrl('https://[::ffff:10.0.0.1]/hook');
    expect(result.valid).toBe(false);
  });

  it('rejects [::ffff:169.254.169.254] (IPv6-mapped metadata)', () => {
    const result = validateWebhookUrl('https://[::ffff:169.254.169.254]/hook');
    expect(result.valid).toBe(false);
  });

  it('rejects [::ffff:192.168.1.1] (IPv6-mapped 192.168)', () => {
    const result = validateWebhookUrl('https://[::ffff:192.168.1.1]/hook');
    expect(result.valid).toBe(false);
  });
});

describe('isBlockedIp', () => {
  it('blocks ::1', () => expect(isBlockedIp('::1')).toBe(true));
  it('blocks ::ffff:127.0.0.1', () => expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true));
  it('blocks ::ffff:10.0.0.1', () => expect(isBlockedIp('::ffff:10.0.0.1')).toBe(true));
  it('allows ::ffff:8.8.8.8', () => expect(isBlockedIp('::ffff:8.8.8.8')).toBe(false));
  it('blocks ::', () => expect(isBlockedIp('::')).toBe(true));

  // IPv6 ULA (fc00::/7)
  it('blocks fd00::1 (ULA)', () => expect(isBlockedIp('fd00::1')).toBe(true));
  it('blocks fc00::1 (ULA)', () => expect(isBlockedIp('fc00::1')).toBe(true));

  // IPv6 link-local (fe80::/10)
  it('blocks fe80::1 (link-local)', () => expect(isBlockedIp('fe80::1')).toBe(true));

  // CGNAT
  it('blocks 100.64.0.1 (CGNAT)', () => expect(isBlockedIp('100.64.0.1')).toBe(true));
  it('allows 100.63.0.1 (not CGNAT)', () => expect(isBlockedIp('100.63.0.1')).toBe(false));
});

describe('validateWebhookUrlWithDns', () => {
  it('passes for domain resolving to public IP', async () => {
    const dns = await import('node:dns');
    vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['93.184.216.34']);
    vi.spyOn(dns.promises, 'resolve6').mockResolvedValue([]);

    const result = await validateWebhookUrlWithDns('https://example.com/hook');
    expect(result.valid).toBe(true);

    vi.restoreAllMocks();
  });

  it('blocks domain resolving to private IP (DNS rebinding)', async () => {
    const dns = await import('node:dns');
    vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['10.0.0.1']);
    vi.spyOn(dns.promises, 'resolve6').mockResolvedValue([]);

    const result = await validateWebhookUrlWithDns('https://evil.com/hook');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('내부');

    vi.restoreAllMocks();
  });

  it('blocks when DNS resolves to nothing', async () => {
    const dns = await import('node:dns');
    vi.spyOn(dns.promises, 'resolve4').mockResolvedValue([]);
    vi.spyOn(dns.promises, 'resolve6').mockResolvedValue([]);

    const result = await validateWebhookUrlWithDns('https://nxdomain.example.com/hook');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('DNS');

    vi.restoreAllMocks();
  });

  it('blocks when any resolved IP is private (mixed)', async () => {
    const dns = await import('node:dns');
    vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['93.184.216.34', '192.168.1.1']);
    vi.spyOn(dns.promises, 'resolve6').mockResolvedValue([]);

    const result = await validateWebhookUrlWithDns('https://mixed.example.com/hook');
    expect(result.valid).toBe(false);

    vi.restoreAllMocks();
  });
});
