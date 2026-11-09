---
name: make-product-demo
description: Make a product demo from the real product — the story in the order the audience asks, real takes of real work (no mockups), one film per display language with a TTS voice for spoken input, README screenshots and GIFs per language, cut with the cinematic-film look, independently reviewed until it ships. Use when asked for a product demo, launch video, demo film, or README demo GIFs. Triggers on "make-product-demo", "제품 데모", "데모 영상", "런칭 영상", "demo video", "product demo", "README GIF".
allowed-tools: Read, Grep, Glob, Bash, Write, Edit
version: 1.0.0
---

# Make a product demo

A demo answers one viewer's questions in the order that viewer asks them, with the real product doing real work.
This skill decides **what** to film and **how to record it honestly**. The **look** (3D plane, depth of field, beat
cuts, titles, sound, review rubric) belongs to `cinematic-film`; use its rig and scripts rather than copying them.

## 1. Audience first

Write down, before recording anything:

- **Who watches first.** For example: a team lead deciding whether to try it, or a developer who wants only the
  plugin.
- **Their questions, in order.** For example: what is it → how do I give it work → what do I see while it works →
  can I step in → what do I get → how do I run it. Each question becomes one beat, and each beat becomes one shot (or
  one README section).
- **The one line** for the end card and the README's first line. For example: "Ask in Slack. Watch it work."

Cut every beat that answers a question nobody in the audience asks. Fewer beats is a better demo.

## 2. Real product, real work, never a mockup

- Record the **real product**, with real data, doing a real task. A recreated UI or a mockup is a different product,
  and viewers and owners notice.
- One task carries the story end to end where it can. The same task is asked, lands, shows its plan, and shows its
  live log.
- If a beat cannot be recorded for real (no access, a blocked integration), say so and leave it out. Don't fake it.
  Never present footage of one path as another: a task typed on the dashboard is not "asked in Slack".
- Each take creates real work, so pick short, read-only instructions in a public or test context.

## 3. Prepare the stage

- **Design:** use the product's own theme for README captures. A film may add a grade on top (for example, mono),
  but README images show the product as it ships.
- **Display language: one film and one README per language.** Switch the account's display language the way a user
  does (its own toggle), record that language's takes, then **restore** the original setting and verify it. Restore
  quickly: the setting usually changes more than the UI, such as bot replies and notifications.
- **Privacy filter first:** filter the view to the public project, hide cards that name private hosts, repos or
  people, and say in the caption that you did.
- **Auth for the capture browser:** use the product's own login, cookie or token for a dedicated capture browser.
  Never copy a person's browser profile or cookies.

## 4. Record the takes

Use `scripts/capture.cjs`: full Chromium at device scale 4, a CDP screencast of every painted frame, and markers at
each action. Type at a human rhythm (85-180 ms per key, longer on spaces). For each beat:

| Beat | Take |
|---|---|
| Ask in the product | open the composer → type → send → hold until the result lands |
| Watch it work | open the result → its plan/tasks → its live log, while it runs |
| Spoken input | a TTS voice (for example a voice API's cloned voice) fed through the **fake microphone** (`scripts/fakemic.cjs`) into the product's real dictation; verify the TTS with a local speech recogniser first |
| Another surface (chat app, IDE) | drive the person's **own logged-in app** only through a path they enabled, such as Chrome's remote debugging toggle (`chrome://inspect/#remote-debugging`) and `connectOverCDP`, recorded over CDP |

**Never kill, relaunch or restart a person's logged-in app** (chat client, browser) from an automation context. A
relaunch from a bot's process can lose the app's keychain access and sign the person out. Ask for the one switch
that lets you attach to the running app instead.

## 5. Cut and finish with cinematic-film

Follow `cinematic-film`: cut clips (`scripts/cut.py`), set up the Plate spec per shot, check stills, render, mix,
run the privacy scan and get an independent review until SHIP. A demo of an open product usually wants the "open"
depth of field: readable work, with blur only where private content would show.

## 6. README per language

- `README.md` uses captures in English UI; `README.<lang>.md` uses that language's UI. Never mix one language's
  captures into the other README.
- **Order:** the one line → the board/hero screenshot → each beat with its GIF → how to run → docs. Use as few words
  as possible.
- GIFs: `cinematic-film/scripts/make_gif.py`, 8-12 s each, about 1 MB, cropped to the action, sped up 1.4-1.6x.
- Every claim on the page is true in the code, and the captions say what was filtered.

## 7. Deliver

- Upload the films where the owner watches (the thread). Attach them to the release, with a CREDITS file for the music
  and sound effects.
- Open a pull request for the README. Its body lists each capture, how it was made and what was hidden.
- Report the review score history and anything not recorded for real, with the reason.

See `references/pitfalls.md` for what went wrong on real runs and how it was fixed.
