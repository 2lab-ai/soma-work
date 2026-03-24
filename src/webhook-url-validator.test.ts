import { describe, expect, it } from 'vitest';
import { validateWebhookUrl } from './webhook-url-validator';

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
});
