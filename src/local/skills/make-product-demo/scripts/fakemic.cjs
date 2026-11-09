// A microphone for the recording browser: getUserMedia({audio}) returns a stream that plays the given WAV (a TTS take)
// after `delayMs`, through the page's own audio pipeline, so the product's real dictation sends it to its real speech
// recogniser. Everything after the microphone is the product as it ships. (A browser's built-in Web Speech API listens to
// the system microphone, not getUserMedia, so this only feeds a product that records through getUserMedia.)
// The start time is left on window.__fakeMicStarted (ms) so a take can mark when the voice began.
const fs = require('fs');
module.exports = async function fakeMic(ctx, wavPath, delayMs = 700) {
  const b64 = fs.readFileSync(wavPath).toString('base64');
  await ctx.addInitScript(({ b64, delayMs }) => {
    const md = navigator.mediaDevices;
    if (!md) return;
    const orig = md.getUserMedia ? md.getUserMedia.bind(md) : null;
    md.getUserMedia = async (c) => {
      if (!c || !c.audio) return orig(c);
      const ac = new AudioContext();
      try { await ac.resume(); } catch {}
      const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const buf = await ac.decodeAudioData(bin.buffer);
      const dest = ac.createMediaStreamDestination();
      const src = ac.createBufferSource(); src.buffer = buf; src.connect(dest);
      setTimeout(() => { try { src.start(); } catch {} }, delayMs);
      window.__fakeMicStarted = Date.now() + delayMs;
      return dest.stream;
    };
  }, { b64, delayMs });
};
