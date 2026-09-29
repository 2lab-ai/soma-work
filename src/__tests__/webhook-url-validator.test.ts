import { afterEach, describe, expect, it, vi } from 'vitest';
import { isBlockedIp, validateWebhookUrl, validateWebhookUrlWithDns } from '../webhook-url-validator';

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

  // Addresses outside the old private/loopback list that are still not globally reachable:
  // broadcast, multicast, IETF protocol assignments, and IPv6 forms that carry a blocked IPv4.
  it.each([
    'https://255.255.255.255/x', // limited broadcast
    'https://224.0.0.1/x', // IPv4 multicast
    'https://192.0.0.1/x', // IETF protocol assignments (192.0.0.0/24)
    'https://[::127.0.0.1]/x', // IPv4-compatible loopback, hostname [::7f00:1]
    'https://[64:ff9b::7f00:1]/x', // NAT64 of 127.0.0.1
    'https://[2002:7f00:1::]/x', // 6to4 of 127.0.0.1
    'https://[ff02::1]/x', // IPv6 multicast
    'https://[fec0::1]/x', // deprecated site-local
  ])('rejects %s', (url) => {
    expect(validateWebhookUrl(url)).toEqual({ valid: false, error: '내부 네트워크 주소는 등록할 수 없습니다.' });
  });

  // Every trailing dot is stripped before the name check, not just one.
  it.each([
    'https://localhost../x',
    'https://localhost.../x',
    'https://metadata.google.internal../computeMetadata/v1/',
  ])('rejects %s (trailing dots)', (url) => {
    expect(validateWebhookUrl(url)).toEqual({ valid: false, error: '내부 네트워크 주소는 등록할 수 없습니다.' });
  });

  // A host made only of dots leaves nothing to check once the trailing dots are stripped.
  it.each(['https://./x', 'https://.../x', 'https://%2e/x'])('rejects %s (no host left)', (url) => {
    expect(validateWebhookUrl(url)).toEqual({ valid: false, error: '올바른 URL 형식이 아닙니다.' });
  });
});

describe('isBlockedIp', () => {
  it('blocks ::1', () => expect(isBlockedIp('::1')).toBe(true));
  it('blocks ::ffff:127.0.0.1', () => expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true));
  it('blocks ::ffff:10.0.0.1', () => expect(isBlockedIp('::ffff:10.0.0.1')).toBe(true));
  // The IANA IPv6 registry marks all of ::ffff:0:0/96 "Globally Reachable: False".
  it('blocks ::ffff:8.8.8.8 (IPv4-mapped, not globally reachable)', () =>
    expect(isBlockedIp('::ffff:8.8.8.8')).toBe(true));
  it('blocks ::', () => expect(isBlockedIp('::')).toBe(true));

  // Resolvers print IPv4-compatible addresses with a dotted tail.
  it('blocks ::127.0.0.1 (IPv4-compatible loopback)', () => expect(isBlockedIp('::127.0.0.1')).toBe(true));
  // NAT64 (64:ff9b::/96) is globally reachable: the embedded IPv4 decides.
  it('allows 64:ff9b::808:808 (NAT64 of a public IPv4)', () => expect(isBlockedIp('64:ff9b::808:808')).toBe(false));
  it('blocks 64:ff9b::a00:1 (NAT64 of 10.0.0.1)', () => expect(isBlockedIp('64:ff9b::a00:1')).toBe(true));
  // IPv6 outside 2000::/3 (the only Global Unicast allocation) is blocked, NAT64 aside.
  // `fc::1` is 00fc::1 and `fe8::1` is 0fe8::1: reserved space, not ULA or link-local.
  it('blocks fc::1 (reserved, outside 2000::/3)', () => expect(isBlockedIp('fc::1')).toBe(true));
  it('blocks fe8::1 (reserved, outside 2000::/3)', () => expect(isBlockedIp('fe8::1')).toBe(true));
  it('blocks ::808:808 (IPv4-compatible, outside 2000::/3)', () => expect(isBlockedIp('::808:808')).toBe(true));
  it('allows 2001:4860:4860::8888 (global unicast, no special-purpose row)', () =>
    expect(isBlockedIp('2001:4860:4860::8888')).toBe(false));

  // Only an IPv6 literal contains ':' (DNS names never do). One this parser cannot read is blocked:
  // Node's net.isIP calls `fe80::1%eth0` an IP address.
  it('blocks fe80::1%eth0 (zone ID: an IPv6 literal it cannot read)', () =>
    expect(isBlockedIp('fe80::1%eth0')).toBe(true));
  it('blocks 1:2:3:4:5:6:7:8:9 (colon text that is not an address)', () =>
    expect(isBlockedIp('1:2:3:4:5:6:7:8:9')).toBe(true));
  it('allows example.com (a name, not an IP address)', () => expect(isBlockedIp('example.com')).toBe(false));

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

describe('validateWebhookUrlWithDns hostname handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function spyOnResolvers(v4: string[] | Error, v6: string[] | Error) {
    const dns = await import('node:dns');
    const stub = (answer: string[] | Error) =>
      answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    return {
      resolve4: vi.spyOn(dns.promises, 'resolve4').mockImplementation(() => stub(v4)),
      resolve6: vi.spyOn(dns.promises, 'resolve6').mockImplementation(() => stub(v6)),
    };
  }

  it('accepts a public IPv6 literal without resolving it', async () => {
    const noDns = new Error('IP literals must not reach DNS');
    const { resolve4, resolve6 } = await spyOnResolvers(noDns, noDns);

    expect(await validateWebhookUrlWithDns('https://[2606:4700:4700::1111]/hook')).toEqual({ valid: true });
    expect(resolve4).not.toHaveBeenCalled();
    expect(resolve6).not.toHaveBeenCalled();
  });

  it('resolves the hostname the static check examined (trailing dot removed)', async () => {
    const { resolve4, resolve6 } = await spyOnResolvers(['93.184.216.34'], []);

    expect(await validateWebhookUrlWithDns('https://example.com./hook')).toEqual({ valid: true });
    expect(resolve4).toHaveBeenCalledWith('example.com');
    expect(resolve6).toHaveBeenCalledWith('example.com');
  });

  it('resolves the hostname without any of its trailing dots', async () => {
    const { resolve4, resolve6 } = await spyOnResolvers(['93.184.216.34'], []);

    expect(await validateWebhookUrlWithDns('https://example.com../hook')).toEqual({ valid: true });
    expect(resolve4).toHaveBeenCalledWith('example.com');
    expect(resolve6).toHaveBeenCalledWith('example.com');
  });

  // An answer that is not an IP address cannot be checked, so it blocks (fail closed).
  it.each([
    [['not-an-ip'], []],
    [[], ['fe80::1%eth0']],
    [['93.184.216.34'], ['2606:4700:4700::1111', '']],
  ])('blocks when a resolver answer is unreadable (%j, %j)', async (v4, v6) => {
    await spyOnResolvers(v4, v6);

    expect(await validateWebhookUrlWithDns('https://garbage.example.com/hook')).toEqual({
      valid: false,
      error: '내부 네트워크 주소로 확인되는 도메인은 등록할 수 없습니다.',
    });
  });

  it('blocks a domain whose AAAA record is ::127.0.0.1 (IPv4-compatible loopback)', async () => {
    await spyOnResolvers([], ['::127.0.0.1']);

    expect(await validateWebhookUrlWithDns('https://rebind.example.com/hook')).toEqual({
      valid: false,
      error: '내부 네트워크 주소로 확인되는 도메인은 등록할 수 없습니다.',
    });
  });
});
