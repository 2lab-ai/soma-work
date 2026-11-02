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
`;
