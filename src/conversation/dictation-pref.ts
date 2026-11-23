/**
 * 받아쓰기 엔진 — each device's choice (SSOT 2026-11-02, epic #737, #738).
 *
 * "설정에서 온디바이스 기기 디폴트 STT와 실제 가장 훌륭한 모델(위스퍼) 중 선택할수 있게 해줘. 이건 기기별 설정을
 * 해당 기기에만 저장해줘. 서버에 저장하는 설정이 아님"
 *
 * The choice lives in this browser's localStorage and nowhere else: no request carries it, so another device and
 * the server keep their own. Shared by the settings page (which writes it) and the dashboard (which reads it).
 *
 * Client script: String.raw, no `${…}` and no backticks (ships byte for byte).
 */

/** The engines a device can choose, in the order the settings tab lists them. */
export const DICTATION_ENGINE_IDS = ['device', 'server', 'browser'] as const;
export type DictationEngineId = (typeof DICTATION_ENGINE_IDS)[number];

/** The localStorage key of a device's choice. */
export const DICTATION_ENGINE_KEY = 'soma-dictation-engine';
/** The localStorage key of a device's 브라우저 위스퍼 model size. */
export const DICTATION_BROWSER_MODEL_KEY = 'soma-dictation-browser-model';
/** The localStorage key of this device's preferred microphone deviceId ('' = system default). */
export const DICTATION_MIC_KEY = 'soma-dictation-mic';
/** The localStorage key of this device's keyboard shortcut for live dictation. */
export const DICTATION_HOTKEY_KEY = 'soma-dictation-hotkey';
/** The localStorage key of hotkey activation mode ('hold' = push-to-talk, 'toggle' = tap on/off). */
export const DICTATION_HOTKEY_MODE_KEY = 'soma-dictation-hotkey-mode';
/** The localStorage key for hardware-DSP raw mic mode ('on' disables browser echoCancellation/noiseSuppression). */
export const DICTATION_RAW_AUDIO_KEY = 'soma-dictation-raw-audio';

export const DICTATION_HOTKEY_IDS = ['auto', 'f19', 'f13', 'alt-shift-d', 'ctrl-shift-space', 'off'] as const;
export type DictationHotkeyId = (typeof DICTATION_HOTKEY_IDS)[number];

export const DICTATION_HOTKEY_MODES = ['hold', 'toggle'] as const;
export type DictationHotkeyMode = (typeof DICTATION_HOTKEY_MODES)[number];

export const DICTATION_PREF_JS = String.raw`
var DICTATION_ENGINE_KEY = 'soma-dictation-engine';
var DICTATION_ENGINE_IDS = ['device', 'server', 'browser'];

// The engine this device chose for 받아쓰기: 'device' (the browser's own recogniser — the default), 'server' (the
// server's Whisper) or 'browser' (Whisper in this browser). Read from this browser only; anything unknown, or a
// storage that refuses (private mode, blocked), is the default.
function dictationEngineChoice(store) {
  var v = null;
  try { v = store ? store.getItem(DICTATION_ENGINE_KEY) : null; } catch (_e) { v = null; }
  return DICTATION_ENGINE_IDS.indexOf(v) >= 0 ? v : 'device';
}

// Keep this device's choice — in this browser's storage only, never sent anywhere. False when the value is not an
// engine or the storage refuses it.
function dictationSaveEngine(store, v) {
  if (DICTATION_ENGINE_IDS.indexOf(v) < 0 || !store) return false;
  try { store.setItem(DICTATION_ENGINE_KEY, v); return true; } catch (_e) { return false; }
}

// 브라우저 위스퍼's model size on this device: 'base' · 'small' · 'turbo', or '' (not chosen — the device's default).
var DICTATION_BROWSER_MODEL_KEY = 'soma-dictation-browser-model';
var DICTATION_BROWSER_MODEL_IDS = ['base', 'small', 'turbo'];
function dictationBrowserModelChoice(store) {
  var v = null;
  try { v = store ? store.getItem(DICTATION_BROWSER_MODEL_KEY) : null; } catch (_e) { v = null; }
  return DICTATION_BROWSER_MODEL_IDS.indexOf(v) >= 0 ? v : '';
}
function dictationSaveBrowserModel(store, v) {
  if (DICTATION_BROWSER_MODEL_IDS.indexOf(v) < 0 || !store) return false;
  try { store.setItem(DICTATION_BROWSER_MODEL_KEY, v); return true; } catch (_e) { return false; }
}

// Preferred microphone deviceId on this device ('' = browser/OS default).
var DICTATION_MIC_KEY = 'soma-dictation-mic';
function dictationMicChoice(store) {
  var v = null;
  try { v = store ? store.getItem(DICTATION_MIC_KEY) : null; } catch (_e) { v = null; }
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}
function dictationSaveMic(store, id) {
  if (!store) return false;
  var clean = typeof id === 'string' ? id.trim() : '';
  try {
    if (!clean || clean === 'default') store.removeItem(DICTATION_MIC_KEY);
    else store.setItem(DICTATION_MIC_KEY, clean);
    return true;
  } catch (_e) { return false; }
}

// Hardware-DSP mic mode (e.g. AU05 with onboard denoise): 'on' disables browser echoCancellation/noiseSuppression.
var DICTATION_RAW_AUDIO_KEY = 'soma-dictation-raw-audio';
function dictationRawAudioChoice(store) {
  var v = null;
  try { v = store ? store.getItem(DICTATION_RAW_AUDIO_KEY) : null; } catch (_e) { v = null; }
  return v === 'on';
}
function dictationSaveRawAudio(store, on) {
  if (!store) return false;
  try { store.setItem(DICTATION_RAW_AUDIO_KEY, on ? 'on' : 'off'); return true; } catch (_e) { return false; }
}

// Dictation keyboard shortcut for hardware buttons (AU05 -> F19/F13) or keyboard (Alt+Shift+D, Ctrl+Shift+Space).
var DICTATION_HOTKEY_KEY = 'soma-dictation-hotkey';
var DICTATION_HOTKEY_IDS = ['auto', 'f19', 'f13', 'alt-shift-d', 'ctrl-shift-space', 'off'];
function dictationHotkeyChoice(store) {
  var v = null;
  try { v = store ? store.getItem(DICTATION_HOTKEY_KEY) : null; } catch (_e) { v = null; }
  return DICTATION_HOTKEY_IDS.indexOf(v) >= 0 ? v : 'auto';
}
function dictationSaveHotkey(store, v) {
  if (DICTATION_HOTKEY_IDS.indexOf(v) < 0 || !store) return false;
  try { store.setItem(DICTATION_HOTKEY_KEY, v); return true; } catch (_e) { return false; }
}

// Activation mode: 'hold' (push-to-talk: hold button to dictate, release to finish) or 'toggle' (tap start/stop).
var DICTATION_HOTKEY_MODE_KEY = 'soma-dictation-hotkey-mode';
var DICTATION_HOTKEY_MODES = ['hold', 'toggle'];
function dictationHotkeyModeChoice(store) {
  var v = null;
  try { v = store ? store.getItem(DICTATION_HOTKEY_MODE_KEY) : null; } catch (_e) { v = null; }
  return DICTATION_HOTKEY_MODES.indexOf(v) >= 0 ? v : 'hold';
}
function dictationSaveHotkeyMode(store, v) {
  if (DICTATION_HOTKEY_MODES.indexOf(v) < 0 || !store) return false;
  try { store.setItem(DICTATION_HOTKEY_MODE_KEY, v); return true; } catch (_e) { return false; }
}

// Identify the exact hotkey trigger matched by a KeyboardEvent ('f19' | 'f13' | 'alt-shift-d' | 'ctrl-shift-space' | '').
function dictationMatchedHotkeyId(e, pref) {
  if (!e || pref === 'off') return '';
  var code = String(e.code || '');
  var key = String(e.key || '');
  var noMod = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
  var isF19 = noMod && (code === 'F19' || key === 'F19');
  var isF13 = noMod && (code === 'F13' || key === 'F13');
  var isAltShiftD = !!e.altKey && !!e.shiftKey && !e.ctrlKey && !e.metaKey && (code === 'KeyD' || key.toLowerCase() === 'd');
  var isCtrlShiftSpace = !!e.ctrlKey && !!e.shiftKey && !e.altKey && !e.metaKey && (code === 'Space' || key === ' ');
  if (pref === 'f19') return isF19 ? 'f19' : '';
  if (pref === 'f13') return isF13 ? 'f13' : '';
  if (pref === 'alt-shift-d') return isAltShiftD ? 'alt-shift-d' : '';
  if (pref === 'ctrl-shift-space') return isCtrlShiftSpace ? 'ctrl-shift-space' : '';
  if (isF19) return 'f19';
  if (isF13) return 'f13';
  if (isAltShiftD) return 'alt-shift-d';
  return '';
}

// Match a KeyboardEvent against the chosen dictation hotkey ('auto' matches F19, F13, or Alt+Shift+D).
function dictationMatchHotkey(e, pref) {
  return !!dictationMatchedHotkeyId(e, pref);
}

// Match the keyup that ends a push-to-talk hold for a specific trigger ID (modifier keys may release before the main key).
function dictationMatchHotkeyRelease(e, trigger) {
  if (!e || !trigger || trigger === 'off') return false;
  var code = String(e.code || '');
  var key = String(e.key || '');
  if (trigger === 'f19') return code === 'F19' || key === 'F19';
  if (trigger === 'f13') return code === 'F13' || key === 'F13';
  if (trigger === 'alt-shift-d') return code === 'KeyD' || key.toLowerCase() === 'd' || key === 'Alt' || key === 'Shift';
  if (trigger === 'ctrl-shift-space') return code === 'Space' || key === ' ' || key === 'Control' || key === 'Shift';
  return code === 'F19' || key === 'F19' || code === 'F13' || key === 'F13';
}

// Build MediaTrackConstraints for getUserMedia from this device's mic + hardware-DSP preferences.
// Chromium/Edge on Linux ignores deviceId { ideal } in favor of "default", so an explicitly chosen mic uses
// exact first; dictationOpenMic() falls back to the system default if that USB mic is unplugged.
function dictationAudioConstraints(store, omitDevice) {
  var raw = dictationRawAudioChoice(store);
  var mic = omitDevice ? '' : dictationMicChoice(store);
  var audio = raw
    ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    : { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (mic) audio.deviceId = { exact: mic };
  return { audio: audio };
}

// Open the microphone with the saved deviceId (exact), falling back to the system default if unplugged.
function dictationOpenMic(nav, store) {
  var primary = dictationAudioConstraints(store, false);
  if (!primary.audio || !primary.audio.deviceId) return nav.mediaDevices.getUserMedia(primary);
  return nav.mediaDevices.getUserMedia(primary).then(null, function (e) {
    var n = e && e.name;
    if (n === 'OverconstrainedError' || n === 'NotFoundError') {
      return nav.mediaDevices.getUserMedia(dictationAudioConstraints(store, true));
    }
    throw e;
  });
}
`;
