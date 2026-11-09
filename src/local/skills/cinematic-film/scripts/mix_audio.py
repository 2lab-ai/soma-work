#!/usr/bin/env python3
"""The film's soundtrack from a JSON cue sheet: one music bed (ducked under speech), voice clips and sound effects at
film frames, a limiter, then two-pass loudnorm to -14 LUFS integrated / -1.5 dBTP. Needs ffmpeg.

usage: mix_audio.py cues.json

cues.json:
{
  "fps": 30, "total_frames": 687, "out": "public/audio/film.wav",
  "music": {"path": "audio/track.mp3", "start": 0.028, "gain_db": -2, "fade_out": 1.8,
            "duck": [{"from_frame": 412, "to_frame": 508, "db": -13}]},
  "voice": [{"path": "voice/ask.wav", "frame": 398, "trim": 3.6, "gain_db": -1}],
  "sfx":   [{"path": "kit/key_1.wav", "frame": 138, "gain_db": -19, "onset": 0.0, "trim": 0.085},
            {"path": "kit/hit.wav", "frame": 610, "gain_db": -8, "onset": 0.004}]
}

- "start" skips into the music file so a downbeat lands on frame 0 and every cut sits on a beat.
- "onset" is the seconds of silence before the sound's attack, so the attack (not the file start) lands on the frame.
- "trim" keeps only the first N seconds (one key stroke out of a typing recording).
"""
import json, subprocess, sys

spec = json.load(open(sys.argv[1]))
FPS = spec.get('fps', 30)
TOTAL = spec['total_frames'] / FPS
OUT = spec['out']
music = spec['music']

args = ['ffmpeg', '-loglevel', 'error', '-y', '-ss', str(music.get('start', 0)), '-t', f'{TOTAL + 0.2:.3f}', '-i', music['path']]
fc = []
duck = ''
for d in music.get('duck', []):
    a0, a1, g = d['from_frame'] / FPS - 0.3, d['to_frame'] / FPS + 0.4, d['db']
    duck += f",volume='if(between(t,{a0:.3f},{a1:.3f}),pow(10,({g}*min(1,min((t-{a0:.3f})/0.3,({a1:.3f}-t)/0.4)))/20),1)':eval=frame"
fade = music.get('fade_out', 1.8)
fc.append(f"[0:a]aresample=48000,aformat=channel_layouts=stereo,volume={music.get('gain_db', 0)}dB{duck},afade=t=out:st={TOTAL - fade:.3f}:d={fade},atrim=0:{TOTAL:.3f}[m]")

labels = ['[m]']
i = 1
for v in spec.get('voice', []):
    args += ['-i', v['path']]
    ms = int(round(v['frame'] / FPS * 1000))
    trim = f",atrim=0:{v['trim']},afade=t=out:st={v['trim'] - 0.3:.3f}:d=0.3" if v.get('trim') else ''
    fc.append(f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo{trim},highpass=f=90,volume={v.get('gain_db', 0)}dB,adelay={ms}|{ms}[v{i}]")
    labels.append(f'[v{i}]')
    i += 1
for s in spec.get('sfx', []):
    args += ['-i', s['path']]
    ms = max(0, int(round((s['frame'] / FPS - s.get('onset', 0)) * 1000)))
    trim = f",atrim=0:{s['trim']},afade=t=out:st={s['trim'] - 0.03:.3f}:d=0.03" if s.get('trim') else ''
    fc.append(f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo{trim},volume={s.get('gain_db', 0)}dB,adelay={ms}|{ms}[s{i}]")
    labels.append(f'[s{i}]')
    i += 1
fc.append(''.join(labels) + f'amix=inputs={len(labels)}:normalize=0:duration=first,alimiter=limit=0.5:attack=2:release=80:level=false[mix]')
raw = OUT.rsplit('.', 1)[0] + '-raw.wav'
subprocess.run(args + ['-filter_complex', ';'.join(fc), '-map', '[mix]', '-c:a', 'pcm_s24le', raw], check=True)

# two-pass loudnorm: measure, then apply linearly to -14 LUFS / -1.5 dBTP
m = subprocess.run(['ffmpeg', '-hide_banner', '-i', raw, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], capture_output=True, text=True).stderr
j = json.loads(m[m.rindex('{'):m.rindex('}') + 1])
af = (f"loudnorm=I=-14:TP=-1.5:LRA=11:measured_I={j['input_i']}:measured_TP={j['input_tp']}:measured_LRA={j['input_lra']}"
      f":measured_thresh={j['input_thresh']}:offset={j['target_offset']}:linear=true,aresample=48000")
subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', raw, '-af', af, '-ar', '48000', '-c:a', 'pcm_s24le', OUT], check=True)
m2 = subprocess.run(['ffmpeg', '-hide_banner', '-i', OUT, '-af', 'loudnorm=I=-14:TP=-1.5:print_format=json', '-f', 'null', '-'], capture_output=True, text=True).stderr
j2 = json.loads(m2[m2.rindex('{'):m2.rindex('}') + 1])
print(OUT, 'I', j2['input_i'], 'LUFS  TP', j2['input_tp'], 'dBTP')
