/**
 * AU05 hardware dictation support: mic deviceId selection, hardware-DSP raw audio, stereo worklet downmix,
 * hotkey Push-to-Talk & Toggle, and fast detection of Linux Edge's empty-transcript Web Speech API.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DICTATION_PREF_JS } from '../dictation-pref';
import { DICTATION_SERVER_JS } from '../dictation-server-client';

function memStore(init: Record<string, string> = {}) {
  const data = { ...init };
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = String(v);
    },
    removeItem: (k: string) => {
      delete data[k];
    },
  };
}

const prefApi = new Function(
  `${DICTATION_PREF_JS}
return {
  dictationMicChoice, dictationSaveMic,
  dictationRawAudioChoice, dictationSaveRawAudio,
  dictationHotkeyChoice, dictationSaveHotkey,
  dictationHotkeyModeChoice, dictationSaveHotkeyMode,
  dictationMatchHotkey, dictationMatchHotkeyRelease,
  dictationAudioConstraints, dictationOpenMic
};`,
)() as Record<string, any>;

const serverApi = new Function(
  `${DICTATION_PREF_JS}
${DICTATION_SERVER_JS}
return { DICTATION_WORKLET_SRC, dictationPcmRms, dictationServerStart };`,
)() as Record<string, any>;

describe('dictation-pref — AU05 mic, raw audio, and hotkey preferences', () => {
  it('stores and clears preferred microphone deviceId and builds exact constraints with unplugged fallback', async () => {
    const store = memStore();
    expect(prefApi.dictationMicChoice(store)).toBe('');
    expect(prefApi.dictationAudioConstraints(store)).toEqual({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    expect(prefApi.dictationSaveMic(store, 'au05-device-id')).toBe(true);
    expect(prefApi.dictationMicChoice(store)).toBe('au05-device-id');
    expect(prefApi.dictationAudioConstraints(store)).toEqual({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        deviceId: { exact: 'au05-device-id' },
      },
    });

    // Hardware-DSP raw audio mode disables browser echo/noise suppression and leaves channel count unconstrained
    expect(prefApi.dictationSaveRawAudio(store, true)).toBe(true);
    expect(prefApi.dictationAudioConstraints(store)).toEqual({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        deviceId: { exact: 'au05-device-id' },
      },
    });

    // Unplugged saved mic falls back seamlessly to system default
    const calls: unknown[] = [];
    const nav = {
      mediaDevices: {
        getUserMedia: vi.fn(async (c: any) => {
          calls.push(c);
          if (c.audio.deviceId) throw Object.assign(new Error('gone'), { name: 'OverconstrainedError' });
          return { fallback: true };
        }),
      },
    };
    expect(await prefApi.dictationOpenMic(nav, store)).toEqual({ fallback: true });
    expect(calls).toHaveLength(2);
    expect((calls[1] as any).audio.deviceId).toBeUndefined();

    // Saving 'default' or '' reverts to system default
    expect(prefApi.dictationSaveMic(store, 'default')).toBe(true);
    expect(prefApi.dictationMicChoice(store)).toBe('');
  });

  it('matches F19, F13, Alt+Shift+D, and Ctrl+Shift+Space hotkeys and release events', () => {
    expect(prefApi.dictationMatchHotkey({ code: 'F19', key: 'F19' }, 'auto')).toBe(true);
    expect(prefApi.dictationMatchHotkey({ code: 'F13', key: 'LaunchApplication1' }, 'auto')).toBe(true);
    expect(prefApi.dictationMatchHotkey({ code: 'KeyD', key: 'D', altKey: true, shiftKey: true }, 'auto')).toBe(true);
    expect(prefApi.dictationMatchHotkey({ code: 'KeyD', key: 'd' }, 'auto')).toBe(false);
    expect(prefApi.dictationMatchHotkey({ code: 'F19', key: 'F19' }, 'off')).toBe(false);
    expect(
      prefApi.dictationMatchHotkey({ code: 'Space', key: ' ', ctrlKey: true, shiftKey: true }, 'ctrl-shift-space'),
    ).toBe(true);

    expect(prefApi.dictationMatchHotkeyRelease({ code: 'F19', key: 'F19' }, 'f19')).toBe(true);
    expect(prefApi.dictationMatchHotkeyRelease({ code: 'KeyD', key: 'd' }, 'alt-shift-d')).toBe(true);
  });
});

describe('SomaPcm16 worklet — stereo/multi-channel downmix', () => {
  it('preserves audio when speech arrives only on the right channel (channel 1)', () => {
    const posted: Int16Array[] = [];
    let Proc: any = null;
    class AudioWorkletProcessor {
      port = { postMessage: (buf: ArrayBuffer) => posted.push(new Int16Array(buf)) };
    }
    new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', serverApi.DICTATION_WORKLET_SRC)(
      AudioWorkletProcessor,
      (_n: string, c: any) => {
        Proc = c;
      },
      16000,
    );
    const p = new Proc();
    const silentLeft = new Float32Array(128).fill(0);
    const activeRight = new Float32Array(128).fill(0.5);
    for (let i = 0; i < 13; i++) p.process([[silentLeft, activeRight]]);
    expect(posted.length).toBe(1);
    // Average of 0.0 and 0.5 is 0.25 -> ~8191 in Int16
    expect(posted[0][0]).toBeGreaterThan(8000);
    expect(serverApi.dictationPcmRms(posted[0].buffer)).toBeGreaterThan(0.2);
  });

  it('dictationServerStart sends saved deviceId, keyterms in start, and reports audio level via onLevel', async () => {
    const store = memStore({ 'soma-dictation-mic': 'au05-usb', 'soma-dictation-raw-audio': 'on' });
    const gumCalls: unknown[] = [];
    const wsSent: unknown[] = [];
    const levels: number[] = [];
    let nodePort: any = null;
    let wsInst: any = null;

    class FakeWS {
      readyState = 1;
      binaryType = '';
      onopen: any = null;
      onmessage: any = null;
      onclose: any = null;
      constructor() {
        wsInst = this;
      }
      send(d: unknown) {
        wsSent.push(d);
      }
      close() {
        this.readyState = 3;
      }
    }
    class FakeNode {
      port = { onmessage: null as any };
      constructor() {
        nodePort = this.port;
      }
      connect() {}
      disconnect() {}
    }
    const env = {
      localStorage: store,
      location: { protocol: 'https:', host: 'agents.example' },
      document: { documentElement: { lang: 'ko' } },
      navigator: {
        mediaDevices: {
          getUserMedia: vi.fn(async (c: unknown) => {
            gumCalls.push(c);
            return { getTracks: () => [{ stop: vi.fn() }] };
          }),
        },
      },
      WebSocket: FakeWS,
      AudioContext: class {
        destination = {};
        audioWorklet = { addModule: async () => {} };
        createMediaStreamSource() {
          return { connect() {} };
        }
        createGain() {
          return { gain: { value: 0 }, connect() {} };
        }
        close() {}
      },
      AudioWorkletNode: FakeNode,
      URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
      Blob: class {},
    };

    const ctl = serverApi.dictationServerStart(
      {
        keyterms: ['AU05', 'soma-work'],
        onLevel: (rms: number) => levels.push(rms),
        onReady: () => {},
      },
      env,
    );
    await vi.waitFor(() => expect(wsInst).not.toBeNull());
    expect(gumCalls[0]).toEqual({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        deviceId: { exact: 'au05-usb' },
      },
    });
    wsInst.onopen();
    expect(JSON.parse(String(wsSent[0]))).toEqual({
      type: 'start',
      lang: 'ko-KR',
      keyterms: ['AU05', 'soma-work'],
    });
    const pcm = new Int16Array(1600).fill(8192);
    nodePort.onmessage({ data: pcm.buffer });
    expect(levels.length).toBe(1);
    expect(levels[0]).toBeCloseTo(0.25, 2);
    ctl.abort();
  });
});

describe('dashboard.ts — Linux Edge empty Web Speech detection & AU05 hotkey PTT', () => {
  const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
  const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

  it('ships ntOnDictationKeyDown, ntOnDictationKeyUp, and empty-final Linux Edge detection in template', () => {
    expect(TEMPLATE).toContain('function ntOnDictationKeyDown(');
    expect(TEMPLATE).toContain('function ntOnDictationKeyUp(');
    expect(TEMPLATE).toContain('function ntDictationKeyterms(');
    expect(TEMPLATE).toContain("document.addEventListener('keydown', ntOnDictationKeyDown, true)");
    expect(TEMPLATE).toContain("document.addEventListener('keyup', ntOnDictationKeyUp, true)");
    expect(TEMPLATE).toContain('이 브라우저의 기본 음성 인식이 빈 결과만 돌려줍니다');
  });
});
