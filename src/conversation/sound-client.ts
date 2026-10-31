/**
 * Interface sound on the dashboard and the settings page — @2lab.ai/ui/sound (the policy every element follows) and
 * @2lab.ai/ui/sound-cuelume (Cuelume's cues, synthesized with Web Audio). Off until the person turns it on with the
 * speaker beside the theme switch; the choice belongs to this browser (localStorage `soma-sound`, like `soma-theme`).
 * Nothing loads for a page that never turned sound on until the person heads for the speaker (hover, focus, press):
 * then the player loads, so the click itself unlocks audio and plays its cue in the same task — some browsers start
 * audio only inside the gesture. The elements sound their own interactions; `bindSound` covers the page's own
 * controls marked `data-ui-sound`.
 *
 * The script is a String.raw literal with no backticks and no `${…}`, so it reaches the browser byte for byte and
 * the tests run it as shipped. It goes in <head>: `data-sound` on <html> picks the speaker's glyph before paint.
 */
import { uiIcon } from './ui-lib';

/** This browser's choice: 'on' | 'off' (absent = off). */
export const SOUND_STORAGE_KEY = 'soma-sound';

const SOUND_CLIENT_JS = String.raw`
// ── Interface sound — @2lab.ai/ui/sound, opt-in, the speaker beside the theme switch ──
var _somaSoundLib = null;  // Promise of { sound, cuelume } while loading or loaded
var _somaSoundMods = null; // { sound, cuelume } once loaded: the click then unlocks audio in the same task
var _somaSoundArmed = null; // a one-shot unlock waiting for the next press or key
function somaSoundSaved() {
  try { return localStorage.getItem('soma-sound') === 'on'; } catch (_e) { return false; }
}
// The page's state: read once from this browser, kept here — a storage that refuses writes cannot lock the speaker.
var _somaOn = somaSoundSaved();
function somaSoundShow(on) {
  document.documentElement.setAttribute('data-sound', on ? 'on' : 'off');
  var b = document.getElementById('sound-toggle');
  if (b) b.setAttribute('aria-pressed', on ? 'true' : 'false');
  // The dashboard's <ui-app-bar> draws its own speaker from data.sound (pressed while on).
  var bar = document.getElementById('app-bar');
  if (bar && bar.data && bar.data.sound !== on) bar.data = Object.assign({}, bar.data, { sound: on });
}
function somaSoundImport(url) {
  return import(url);
}
// sound.js unversioned: it is the module the elements import as ./sound.js, so the page and the elements share
// one cue queue. The player is versioned like the elements' entry files.
function somaSoundLoad() {
  if (!_somaSoundLib) {
    _somaSoundLib = Promise.all([
      somaSoundImport('/dashboard/ui/sound.js'),
      somaSoundImport('/dashboard/ui/sound-cuelume.js?v=__UI_V__'),
    ]).then(function (m) {
      m[0].bindSound(document);
      _somaSoundMods = { sound: m[0], cuelume: m[1] };
      return _somaSoundMods;
    });
    _somaSoundLib.catch(function () { _somaSoundLib = null; });
  }
  return _somaSoundLib;
}
// On the way to the speaker (hover, focus, press): load the player, so the click itself can start audio.
function somaSoundWarm() {
  somaSoundLoad().catch(function () {});
}
// Audio the click could not start (the player arrived after the gesture): the next press or key starts it, inside
// that gesture.
function somaSoundArm(m) {
  if (_somaSoundArmed) return;
  var types = ['pointerdown', 'pointerup', 'touchend', 'keydown', 'click'];
  var fn = function () {
    if (_somaOn) {
      // Keep listening until audio runs: not every browser counts every one of these events as a gesture.
      Promise.resolve(m.cuelume.unlockSound()).then(function (ok) { if (ok) off(); }, function () {});
      return;
    }
    off();
  };
  var off = function () {
    for (var i = 0; i < types.length; i++) document.removeEventListener(types[i], fn, true);
    if (_somaSoundArmed === fn) _somaSoundArmed = null;
  };
  _somaSoundArmed = fn;
  for (var j = 0; j < types.length; j++) document.addEventListener(types[j], fn, true);
}
// inGesture: still inside the click's task — unlock and confirm now. Otherwise (the player arrived after the
// gesture) try, and leave the start to the next gesture: outside one, WebKit's resume() may never settle.
// quiet: the control confirms with its own cue (<ui-app-bar>'s speaker sounds its toggle once its listeners ran).
function somaSoundApply(m, on, fromClick, inGesture, quiet) {
  m.sound.setSound(on ? { player: m.cuelume.cuelumeSound, enabled: true } : { enabled: false });
  if (!on || !fromClick) return on;
  var started = m.cuelume.unlockSound();
  if (!inGesture) {
    somaSoundArm(m);
    return on;
  }
  if (!quiet) m.sound.playSound('toggle', { direction: 'forward' });
  started.then(function (ok) { if (!ok) somaSoundArm(m); });
  return on;
}
// on: the choice; fromClick: inside the person's click (unlock audio there, and confirm with one cue).
function somaSoundKeep(on) {
  _somaOn = on;
  try { localStorage.setItem('soma-sound', on ? 'on' : 'off'); } catch (_e) {}
}
function somaSetSound(on, fromClick, quiet) {
  somaSoundKeep(on);
  somaSoundShow(on);
  // Loaded: no await between the click and the unlock (some browsers start audio only inside the gesture).
  if (_somaSoundMods) return Promise.resolve(somaSoundApply(_somaSoundMods, on, fromClick, fromClick, quiet));
  if (!on && !_somaSoundLib) return Promise.resolve(false);
  return somaSoundLoad().then(function (m) {
    // The latest choice wins: turned off while loading stays off.
    return somaSoundApply(m, _somaOn, fromClick, false, quiet);
  }, function () {
    // The player could not load: say off. A click's choice becomes off; a saved one is kept for the next page.
    if (fromClick) somaSoundKeep(false);
    else _somaOn = false;
    somaSoundShow(false);
    return false;
  });
}
function toggleSound() {
  return somaSetSound(!_somaOn, true);
}
// <ui-app-bar>'s speaker (the dashboard): ui-sound-change carries the new choice inside the click's task, so the
// unlock happens there; the bar plays its own toggle cue after this listener, so the page stays quiet. The player
// warms on the way to the speaker (inside the bar's shadow root: the event's first target is the button).
function somaSoundBindBar(bar) {
  if (!bar || bar._somaSound) return;
  bar._somaSound = true;
  bar.addEventListener('ui-sound-change', function (e) {
    somaSetSound(!!(e.detail && e.detail.sound), true, true);
  });
  var warm = function (e) {
    var t = e.composedPath ? e.composedPath()[0] : e.target;
    if (t && t.closest && t.closest('.ab-sound')) somaSoundWarm();
  };
  bar.addEventListener('pointerover', warm);
  bar.addEventListener('focusin', warm);
  bar.addEventListener('pointerdown', warm);
}
somaSoundShow(_somaOn);
if (_somaOn) somaSetSound(true, false);
document.addEventListener('DOMContentLoaded', function () {
  somaSoundBindBar(document.getElementById('app-bar'));
  somaSoundShow(_somaOn);
});
`;

/** The page script, its module URLs pinned to the installed @2lab.ai/ui version (cache-busting, like the elements). */
export function soundClientJs(uiVersion: string): string {
  return SOUND_CLIENT_JS.split('__UI_V__').join(encodeURIComponent(uiVersion));
}

/**
 * The speaker (server-drawn glyphs from @2lab.ai/ui's icon set): `sound` while on, `sound-off` while off — CSS picks
 * one by `data-sound` on <html>. For the settings page; the dashboard writes the same button with icon slots.
 */
export function soundToggleHtml(): string {
  return `<button type="button" id="sound-toggle" class="sound" onclick="toggleSound()" onpointerenter="somaSoundWarm()" onfocus="somaSoundWarm()" onpointerdown="somaSoundWarm()" aria-pressed="false" aria-label="인터페이스 소리" title="인터페이스 소리">${uiIcon('sound', { class: 'ic-sound' })}${uiIcon('sound-off', { class: 'ic-sound-off' })}</button>`;
}
