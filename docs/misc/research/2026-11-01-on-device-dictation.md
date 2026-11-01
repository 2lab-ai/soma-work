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
- Samsung Internet: prefixed, the same Chromium code as Chrome on Android, so audio goes to Google's speech app on the phone. MDN marks `continuous` as "can be set, has no effect" for Chrome on Android, and Samsung Internet copies that entry. It fails with `service-not-allowed` when the "Speech Recognition and Synthesis from Google" app is disabled. Users also report it showing "listening" and returning no text. Test on a real Galaxy.
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
2. The recogniser listens with `lang = 'ko-KR'`, `interimResults = true`, and `continuous = true` everywhere except Android (item 6). The field shows what was there, the settled words, then the words still being heard.
3. The new task opens listening where the words stay on the device (Safari and iPhone browsers, Chrome with Korean installed) and on a Galaxy (Chrome and Samsung Internet), where the phone's own recogniser takes them. A key typed stops it, and the typing goes on. A refused microphone, or a recogniser that does not work, ends the automatic start for that page.
4. Every press starts listening at once. Desktop Chrome without Korean on the device never starts on its own; the status line says the voice goes to the browser's speech service. (A first version asked for a second press as consent. On 1 November 2026 the user reported "삼성인터넷브라우저에서 작동안하잖아", so the question was removed.)
5. In Chrome with `available()`, the page asks for on-device processing, calls `install()` on downloadable, and says in the status line where the words are processed.
6. On Android the recogniser listens for one utterance per session (`continuous = false`) and starts again after each one. Repeated phrases are folded on Android only, so a phrase said twice elsewhere stays. `available()` is not asked there, because a page cannot keep Android's recogniser on the device.
7. When the recogniser ends by itself it listens again. Three sessions in a row without words end the dictation: as silence, or, when sound was heard (`speechstart` — a noisy room, or Samsung Internet returning nothing), on the status line with what to try. Only a recogniser that never opens the microphone is called broken, on the red error line: two sessions with no `audiostart`, or a session with no answer for 12 seconds — both only until the microphone has opened once in that dictation. After that, a late `audiostart` is not a broken recogniser: a restart with no event for 30 seconds is let go on the status line ("다시 누르면 이어서"), keeping the automatic start. The 12-second watch waits while the microphone permission is still `prompt` (up to a minute, then it says it is waiting for that yes) and waits once more before the microphone has ever opened (iOS asks for speech recognition separately). A broken recogniser, or a microphone refused before it opened, ends the automatic start for the page. An error with no end after it, and a stop the recogniser never confirms, are let go after 3 seconds.
   - Read from Chromium's Android bridge (`SpeechRecognitionImpl.java`): an utterance it cannot match is a `nomatch` event, not an error. `ERROR_RECOGNIZER_BUSY` arrives as `not-allowed`, so on Android the first `not-allowed` in a stretch without words gets one more try after 400 ms; a second one is the permission. A page sent to the background on Android (or any session the browser aborts there) stops quietly instead of restarting into a refusal; desktop Chrome keeps listening in a background tab and restarts there.
8. Errors the person has to act on go on the red error line, not the small status line. On Android the wording names the setting: "Google 음성 인식 및 합성" for `service-not-allowed`, the site and app mic permission for `not-allowed`. If the line already shows another error (the context failed to load), that one stays and the dictation's reason goes on the status line. The next press clears only the dictation's own error. A voice note recording keeps the microphone: the automatic start waits, and a press says so.
9. On a phone the new task's character counter gives way to the tool row; the limit is checked on send. Under 360px wide (a Galaxy S9, a Fold's cover screen) the send button shows only its arrow, so it does not cover 받아쓰기.
10. Firefox and an iPhone Home Screen web app keep the voice note only.

## Follow-up candidates

- Phrase lists for English technical terms when Chrome runs on-device.
- A watchdog for Edge when recognition starts but no event arrives.
- An in-browser model for browsers without a recogniser, or whose recogniser does not work (Samsung Internet returning no words). getUserMedia works there, since the voice note records.

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
- [MDN: SpeechRecognition `continuous` on Chrome for Android ("can be set, but has no effect")](https://github.com/mdn/browser-compat-data/blob/main/api/SpeechRecognition.json)
- [Samsung Community: voice input fixed by enabling "Speech Recognition and Synthesis from Google"](https://us.community.samsung.com/t5/Galaxy-S24/Samsung-Internet-Search-Widget-Microphone/td-p/2984268)
- [Samsung Internet Developers: Speaking to the Web with the Web Speech API](https://medium.com/samsung-internet-dev/speaking-to-the-web-with-the-web-speech-api-980d12d34244)
