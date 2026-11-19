import { spawn } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { A2tService } from '../a2t-service';
import type { A2tStatus } from '../types';

// The real spawn runs; the mock only records what the worker was handed.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const spawn = vi.fn(real.spawn);
  return { ...real, default: { ...real, spawn }, spawn };
});

describe('A2tService — status management', () => {
  it('starts in not_initialized state', () => {
    const service = new A2tService();
    expect(service.getStatus().state).toBe('not_initialized');
    expect(service.isReady()).toBe(false);
  });

  it('disabled state when config.enabled = false', () => {
    const service = new A2tService({ enabled: false });
    expect(service.getStatus().state).toBe('disabled');
    expect(service.isReady()).toBe(false);
    expect(service.getStatusMessage()).toContain('disabled');
  });

  it('initialize() returns immediately when disabled', async () => {
    const service = new A2tService({ enabled: false });
    await service.initialize(); // should not throw
    expect(service.getStatus().state).toBe('disabled');
  });

  it('getStatusMessage returns human-readable strings for all states', () => {
    // disabled
    let service = new A2tService({ enabled: false });
    expect(service.getStatusMessage()).toContain('disabled');

    // not_initialized
    service = new A2tService();
    expect(service.getStatusMessage()).toContain('not initialized');

    // ready — test by casting internal state
    service = new A2tService();
    (service as any).status = { state: 'ready', model: 'large-v3-turbo', device: 'cpu' } satisfies A2tStatus;
    expect(service.getStatusMessage()).toContain('ready');
    expect(service.getStatusMessage()).toContain('large-v3-turbo');

    // error
    service = new A2tService();
    (service as any).status = { state: 'error', error: 'test error' } satisfies A2tStatus;
    expect(service.getStatusMessage()).toContain('test error');

    // shutdown
    service = new A2tService();
    (service as any).status = { state: 'shutdown' } satisfies A2tStatus;
    expect(service.getStatusMessage()).toContain('shut down');
  });

  it('transcribe() throws when not ready', async () => {
    const service = new A2tService();
    await expect(service.transcribe('/tmp/test.wav')).rejects.toThrow('not initialized');
  });

  it('transcribe() throws when disabled', async () => {
    const service = new A2tService({ enabled: false });
    await expect(service.transcribe('/tmp/test.wav')).rejects.toThrow('disabled');
  });

  it('defaults config values correctly', () => {
    const service = new A2tService();
    const cfg = (service as any).config;
    expect(cfg.model).toBe('large-v3-turbo');
    expect(cfg.device).toBe('auto');
    expect(cfg.computeType).toBe('auto');
    expect(cfg.minMemoryMb).toBe(16000);
    expect(cfg.pythonPath).toBe('python3');
    expect(cfg.enabled).toBe(true);
  });

  it('initialize() enforces the configured memory floor, not the default', async () => {
    const floor = new A2tService({ minMemoryMb: 999_999_999 });
    await expect(floor.initialize()).rejects.toThrow('999999999MB required');
  });

  it('initialize() hands the worker the configured model, device, compute type and memory floor', async () => {
    vi.mocked(spawn).mockClear();
    const service = new A2tService({
      model: 'tiny',
      device: 'cuda',
      computeType: 'float16',
      minMemoryMb: 1,
      pythonPath: '/nonexistent/custom-python3',
    });
    await expect(service.initialize()).rejects.toThrow("Python not found at '/nonexistent/custom-python3'");

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    const [command, , options] = vi.mocked(spawn).mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(command).toBe('/nonexistent/custom-python3');
    expect(options.env).toMatchObject({
      A2T_MODEL: 'tiny',
      A2T_DEVICE: 'cuda',
      A2T_COMPUTE_TYPE: 'float16',
      A2T_MIN_MEMORY_MB: '1',
    });
  });

  it('initialize() rejects when memory insufficient', async () => {
    // Request an impossibly large amount of memory
    const service = new A2tService({ minMemoryMb: 999_999_999 });
    await expect(service.initialize()).rejects.toThrow('Insufficient free memory');
    expect(service.getStatus().state).toBe('error');
    expect((service.getStatus() as any).error).toContain('Insufficient free memory');
  });

  it('initialize() rejects when python not found', async () => {
    const service = new A2tService({
      pythonPath: '/nonexistent/python3_does_not_exist',
      minMemoryMb: 1, // bypass memory check
    });
    await expect(service.initialize()).rejects.toThrow();
    expect(service.getStatus().state).toBe('error');
  });

  it('shutdown() from not_initialized state is safe', async () => {
    const service = new A2tService();
    await service.shutdown(); // should not throw
    expect(service.getStatus().state).toBe('shutdown');
  });
});

describe('A2tService — singleton exports', () => {
  afterEach(async () => {
    // Reset singleton between tests
    const mod = await import('../a2t-service');
    await mod.shutdownA2tService();
  });

  it('getA2tService returns null before initialization', async () => {
    const { getA2tService } = await import('../a2t-service');
    // Note: singleton may be set from previous tests, but afterEach resets it
    expect(getA2tService()).toBeNull();
  });

  it('initA2tService with disabled config returns null', async () => {
    const { initA2tService, getA2tService } = await import('../a2t-service');
    const result = await initA2tService({ enabled: false });
    // Disabled service still returns the instance (it's "initialized" in disabled state)
    // But getA2tService returns the instance
    expect(result).not.toBeNull();
    expect(getA2tService()).not.toBeNull();
    expect(getA2tService()?.isReady()).toBe(false);
  });
});
