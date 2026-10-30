/**
 * Interface sound on the dashboard and the settings page — @2lab.ai/ui/sound (the policy every element follows) and
 * @2lab.ai/ui/sound-cuelume (Cuelume's cues, synthesized with Web Audio). Off until the person turns it on with the
 * speaker beside the theme switch; the choice belongs to this browser (localStorage `soma-sound`, like `soma-theme`).
 * Cuelume loads only once sound is on, and audio is unlocked inside the click that turned it on — some browsers
 * start audio only in a gesture. The elements sound their own interactions; `bindSound` covers the page's own
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
var _somaSoundLib = null; // Promise of { sound, cuelume } once sound was turned on
function somaSoundSaved() {
  try { return localStorage.getItem('soma-sound') === 'on'; } catch (_e) { return false; }
}
function somaSoundShow(on) {
  document.documentElement.setAttribute('data-sound', on ? 'on' : 'off');
  var b = document.getElementById('sound-toggle');
  if (!b) return;
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  b.setAttribute('aria-label', on ? '소리 끄기' : '소리 켜기');
}
function somaSoundImport(url) {
  return import(url);
}
function somaSoundLoad() {
  if (!_somaSoundLib) {
    _somaSoundLib = Promise.all([
      somaSoundImport('/dashboard/ui/sound.js?v=__UI_V__'),
      somaSoundImport('/dashboard/ui/sound-cuelume.js?v=__UI_V__'),
    ]).then(function (m) {
      m[0].bindSound(document);
      return { sound: m[0], cuelume: m[1] };
    });
    _somaSoundLib.catch(function () { _somaSoundLib = null; });
  }
  return _somaSoundLib;
}
// on: the choice; fromClick: inside the person's click (unlock audio there, and confirm with one cue).
function somaSetSound(on, fromClick) {
  try { localStorage.setItem('soma-sound', on ? 'on' : 'off'); } catch (_e) {}
  somaSoundShow(on);
  if (!on && !_somaSoundLib) return Promise.resolve(false);
  return somaSoundLoad().then(function (m) {
    m.sound.setSound(on ? { player: m.cuelume.cuelumeSound, enabled: true } : { enabled: false });
    if (on && fromClick) {
      m.cuelume.unlockSound();
      m.sound.playSound('toggle', { direction: 'forward' });
    }
    return on;
  }, function () { return false; });
}
function toggleSound() {
  return somaSetSound(!somaSoundSaved(), true);
}
somaSoundShow(somaSoundSaved());
if (somaSoundSaved()) somaSetSound(true, false);
document.addEventListener('DOMContentLoaded', function () { somaSoundShow(somaSoundSaved()); });
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
  return `<button type="button" id="sound-toggle" class="sound" onclick="toggleSound()" aria-pressed="false" aria-label="소리 켜기" title="인터페이스 소리">${uiIcon('sound', { class: 'ic-sound' })}${uiIcon('sound-off', { class: 'ic-sound-off' })}</button>`;
}
