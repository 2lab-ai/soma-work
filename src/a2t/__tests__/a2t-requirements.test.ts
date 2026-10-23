/**
 * The A2T worker's Python dependency input (`services/a2t/requirements.txt`).
 *
 * faster-whisper (1.2.1, the latest release) decodes audio with
 * `av.open(..., metadata_errors="ignore")`; PyAV 19.0.0 removed that keyword
 * (PyAV CHANGELOG v19.0.0). An unpinned install resolves PyAV 19 and every
 * transcription fails with `open() got an unexpected keyword argument
 * 'metadata_errors'` — the worker still reports `ready`, so the failure only
 * shows on the first voice note. Reproduced 2026-10-24 with a dashboard voice
 * note (`audio/mp4`, Opus): av 19.0.2 → error; av 18.1.0 and 15.1.0 →
 * "대시보드 음성 녹음 테스트입니다. …" (ko, ≥ 0.998).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const REQUIREMENTS = path.join(__dirname, '..', '..', '..', 'services', 'a2t', 'requirements.txt');

function requirement(name: string): string | undefined {
  return fs
    .readFileSync(REQUIREMENTS, 'utf8')
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .find((line) => new RegExp(`^${name}\\s*([<>=!~]|$)`, 'i').test(line));
}

describe('services/a2t/requirements.txt', () => {
  it('caps PyAV below 19 (faster-whisper passes metadata_errors to av.open)', () => {
    const av = requirement('av');
    expect(av, 'av must be pinned explicitly').toBeDefined();
    expect(av).toMatch(/(^|[\s,])<\s*19(\s|,|$)/);
  });

  it('keeps PyAV at or above the floor faster-whisper requires', () => {
    expect(requirement('av')).toMatch(/(^|[\s,]|av)>=\s*11(\s|,|$)/);
  });

  it('still installs faster-whisper', () => {
    expect(requirement('faster-whisper')).toBeDefined();
  });
});
