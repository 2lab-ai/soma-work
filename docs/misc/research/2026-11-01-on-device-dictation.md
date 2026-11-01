# On-device live dictation for the new task composer

Research date: 1 November 2026. Decision: use the browser's built-in speech recogniser (Web Speech API) for live dictation in the dashboard's new task composer. Ask for on-device processing where the browser offers it. Leave in-browser models for later.

## Why this was needed

The new task mic recorded an audio file and posted it with the task. The server transcribes it later with a Python faster-whisper worker. When that worker is not running, the prompt says "A2T service not available" and the instruction is lost. On 1 November 2026 a request arrived exactly this way.

## Status by platform

- Desktop Chrome: supported, with interim results and continuous mode. Korean (ko-KR) works. Audio goes to Google by default. On-device processing shipped in Chrome 139 for Windows, Mac and Linux. A bug switched it off until Chrome 142.
- Edge: the object exists, but recognition often fails with "language-not-supported" or fires no events.
- Safari on Mac: `webkitSpeechRecognition` since 14.1, with interim results. Continuous mode was fixed in 17. Siri must be on. WebKit asks Apple's recogniser for on-device recognition whenever the language supports it.
- Safari on iPhone, and Chrome on iPhone (WebKit): supported from 14.5. Korean is on Apple's on-device dictation list. It does not work in a web app opened from the Home Screen (WebKit bug 225298).
- Chrome on Android: supported, with interim results. Continuous mode has no effect. Each update can repeat a growing phrase marked final, so naive code repeats words. A page cannot ask for on-device processing; Korean goes to Google.
- Samsung Internet: prefixed, partial support, treated like Chrome on Android. Test on a real Galaxy.
- Firefox: off by default. Only desktop Nightly has on-device recognition, behind a setting.

The API needs HTTPS. Each session takes one language; no engine documents mixed Korean and English speech. The ko-KR recogniser keeps common English terms inside Korean sentences.

## Chrome's on-device API

- `SpeechRecognition.available({ langs: ['ko-KR'], processLocally: true })` answers available, downloadable, downloading or unavailable.
- Until a site calls `install()`, Chrome answers downloadable, to protect privacy. `install()` needs a user press when it would start a download, so the page calls it inside the mic press.
- `recognition.processLocally = true` keeps the session on the device.
- Chrome 142 added phrase lists to bias recognition, which Chrome may apply only on-device. Not used yet.

## In-browser models (deferred)

- sherpa-onnx streaming Korean model: Korean only, about 132 MB (int8). No Korean-English streaming model and no ready Korean WebAssembly build.
- SenseVoice (Chinese, English, Japanese, Korean, Cantonese): not streaming, 239 MB.
- Whisper with transformers.js: re-transcribes the last 30 seconds; whisper-base is 73 MB (q8). Phones may run out of memory.
- Moonshine Tiny Korean: not streaming, non-commercial licence.
- Vosk small Korean: 82 MB, 28.1% word error rate.

Each means a download of 80 to 240 MB per device with weaker Korean than the built-in engines.

## What the dashboard does

1. 받아쓰기 is a tool beside the voice note, which stays (the user's correction on 1 November 2026: "음성녹음은 두고"). It is a pencil, labelled on wide screens. The new task composer and the session panel composer both have it, for every destination (it is text, so a dashboard task takes it). One dictation runs at a time.
2. The recogniser listens with `lang = 'ko-KR'`, `interimResults = true`, `continuous = true`. The field shows what was there, the settled words, then the words still being heard.
3. Where the words stay on the device (Safari and iPhone browsers, Chrome with Korean installed), the new task opens listening. A key typed stops it, and the typing goes on. A refused microphone ends the automatic start for that page.
4. The voice leaves the device only on a yes. Where it would (Chrome on Android, Samsung Internet, Chrome without Korean on the device), it never starts on its own; the first press says so and points to the keyboard's mic, and the second press is the yes, kept on that device.
5. In Chrome with `available()`, the page asks for on-device processing, calls `install()` on downloadable, and says in the status line where the words are processed.
6. Android's repeated phrases are folded on Android only, so a phrase said twice elsewhere stays.
7. When the recogniser ends by itself it listens again. Three silent sessions in a row end the dictation. A stop the recogniser never confirms is let go after 3 seconds.
8. On a phone the new task's character counter gives way to the tool row; the limit is checked on send.
9. Firefox and an iPhone Home Screen web app keep the voice note only.

## Follow-up candidates

- Phrase lists for English technical terms when Chrome runs on-device.
- A watchdog for Edge when recognition starts but no event arrives.
- An in-browser model for browsers without a recogniser.

## Sources

- [MDN browser compatibility data for SpeechRecognition](https://github.com/mdn/browser-compat-data/blob/main/api/SpeechRecognition.json)
- [Can I use: speech recognition](https://caniuse.com/speech-recognition)
- [Chrome 139 release notes](https://developer.chrome.com/release-notes/139)
- [Chromium bug that switched off on-device recognition](https://issues.chromium.org/issues/444393111)
- [On-device speech recognition explainer](https://github.com/WebAudio/web-speech-api/blob/main/explainers/on-device-speech-recognition.md)
- [MDN: SpeechRecognition.available()](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/available_static)
- [Web Speech API specification](https://webaudio.github.io/web-speech-api/)
- [Chrome 142 release notes (phrase lists)](https://developer.chrome.com/release-notes/142)
- [WebKit on-device recognition request](https://github.com/WebKit/WebKit/blob/ff9e538b9535f4a9a0a2e2187b36a4095ec1ab10/Source/WebCore/Modules/speech/cocoa/WebSpeechRecognizerTask.mm#L101-L106)
- [Apple feature availability (dictation languages)](https://www.apple.com/ios/feature-availability/)
- [WebKit bug 225298: speech recognition in Home Screen web apps](https://bugs.webkit.org/show_bug.cgi?id=225298)
- [Firefox 158 release notes (on-device recognition)](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/158)
- [sherpa-onnx streaming Korean model](https://huggingface.co/k2-fsa/sherpa-onnx-streaming-zipformer-korean-2024-06-16/tree/main)
- [transformers.js real-time Whisper example](https://github.com/huggingface/transformers.js-examples/tree/main/realtime-whisper-webgpu)
- [Vosk models](https://alphacephei.com/vosk/models)
