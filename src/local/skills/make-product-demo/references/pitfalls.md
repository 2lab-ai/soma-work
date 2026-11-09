# Pitfalls from real runs

These come from the soma-work v0.3 launch film and README (2026-11). Each entry gives what happened, then the fix.

## Story and honesty

- **A mockup was rejected outright.** The first film rebuilt the dashboard as a mock. The owner wanted the real
  product doing real work. Record the product itself.
- **Footage was presented as a path it did not take.** The film had an "Ask in Slack." shot, but the message on screen
  had been typed on the dashboard and mirrored into Slack. Label each shot with how it was really made, and re-shoot
  it if the label does not match.
- **The film was too complex.** It had a wide board shot, many cards and long titles. Fix: one task carried through,
  1-4-word titles, and no wide shot.

## Depth of field

- **Too much was hidden.** Heavy blur and 3-4x macro made the work unreadable. The owner said the content is open
  source and can show. Fix: open the plates (0.7-0.8x zoom, light blur) and keep heavy blur only below landing cards.
- **Opening up exposed private names.** Once the background was readable, a card naming private hosts showed under a
  landing. Fix: a per-shot override (strong blur and a tight near ring below the landed card), then a frame-by-frame
  privacy scan.
- **The focus oval cut lines mid-word.** Fix: wider spots (pad the width, not the height), or a feathered rectangle
  for a note.

## Capture

- **The screencast sent an odd low-resolution frame.** Drop frames smaller than the majority size before encoding.
- **Typing stuttered at low fps.** The system was under load (renders running). Record with nothing else heavy
  running, and re-take instead of patching.
- **Headless pages do not paint unless asked.** Keep a `requestAnimationFrame` loop in an init script.

## Voice

- **The server dictation was down after a restart.** A2T refused to start: free memory was below its floor at boot,
  and it only starts at boot. Check the product's dictation status before a voice take. If it needs a restart, do it
  when memory is free, and tell the owner first.
- **English dictation showed Korean guesses.** The dictation client sent a fixed `ko-KR` language, so interim results
  for English speech were Korean. The final result was right. Fix the product, or show only the listening state and
  the final text.
- **Check the TTS first.** Transcribe each TTS take locally (for example, mlx-whisper large-v3-turbo) before feeding it
  to the product. A voice clone can soften the first consonants of names.

## Other people's apps

- **A relaunched chat app lost its login.** The bot killed and relaunched the person's Slack desktop app to add a
  debugging port. Slack refused the port on the default profile, and the relaunch from the bot's context failed the
  keychain lookup, which signed the person out. Never relaunch someone's app. Ask them to enable Chrome's remote
  debugging toggle and attach to the browser they already use.
- **AppleScript and screen capture hang or fail from a service context.** The macOS consent prompts (Automation,
  Screen Recording) wait on a screen nobody is watching. Don't depend on them. Attach to Chrome over CDP instead.

## Display language

- **The saved setting beats the cookie.** A UI-language cookie is ignored once the account has a saved language.
  Switch the account setting through the product's own toggle, record, then restore it and verify through the API.
