# Cinematic film review rubric

Give this rubric to an independent reviewer, someone who did not make the film. The reviewer extracts frames with
ffmpeg (every 10-15 frames through each plate, plus the frames on both sides of every cut), looks at them, and
reports with frame numbers. The reviewer does not edit files.

## Must-fix (any one means FIX)

- **Privacy.** Any readable host name, internal domain, private repository or channel, personal ID, token or
  user-named path, anywhere in the frame, including the out-of-focus background.
- **Wrong story.** A shot says something the footage does not show. For example, "Ask in Slack." followed by a task
  that was really typed on the dashboard. The film must not claim what it did not record.
- **Content the owner asked to see is hidden.** For example, the owner asked for the work to be readable and it
  isn't.
- **Broken frames.** A flash of a wrong card, a half-rendered page or a black frame at a cut.

## Should-fix

- **Focus cuts a line mid-word.** Use a wider ellipse, or a feathered rectangle (`rect: true`).
- **Page edge visible.** The plane's edge shows into black. Tighten the zoom or move the camera.
- **Busy background.** Large, sharp fragments of another pane pull the eye.
- **Cut reads as a jump.** Two shots of the same panel back to back. Open the second shot on a soft rack.
- **Inconsistent treatment.** Two landings or two similar shots are framed differently for no reason.
- **Unreadable text in focus.** Text is too small, too dim or too soft. Raise `lift`, zoom in, or use a 4x take.
- **Off the beat.** A cut misses the beat, or a title or end line misses the drop.
- **Audio.** Loudness is not -14 LUFS ±1, the true peak is over -1.5 dBTP, a voice is masked by the music, or a click
  is not on its event.

## Per shot

For each shot, the reviewer answers in one line: what does the viewer understand, and is anything confusing?

## Verdict

End with a score out of 10, then **SHIP** or **FIX**, with the must-fix items first and the should-fix items after.
