#!/usr/bin/env python3
"""Cut a CDP screencast take (REC/frames/*.jpg + REC/frames.jsonl + REC/markers.jsonl) into a constant 30 fps clip.
The screencast sends a frame only when the page changes, at irregular times; each frame is held until the next one.
usage: REC=<take dir> cut.py <name> <t0> <t1> <speed> [--out DIR]   (t0/t1: seconds after the first marker; speed 1 =
real time). Needs ffmpeg and Pillow. Frames the screencast sent at a smaller size (it happens) are dropped."""
import json, os, subprocess, sys
name, t0, t1, speed = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])
REC = os.environ.get('REC', 'rec')
REC_ABS = os.path.abspath(REC)
out = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else 'public/clips'
os.makedirs(out, exist_ok=True)
fr = [json.loads(l) for l in open(REC + '/frames.jsonl')]
mk = [json.loads(l) for l in open(REC + '/markers.jsonl')]
T0 = mk[0]['ts']
sel = [f for f in fr if T0 + t0 <= f['ts'] <= T0 + t1]
# drop the odd frame the screencast sent at a lower size (a full-size neighbour holds its time instead)
from PIL import Image
_sz = {f['file']: Image.open(f'{REC}/frames/' + f['file']).size for f in sel}
_big = max(_sz.values(), key=lambda s: s[0] * s[1])
_n0 = len(sel)
sel = [f for f in sel if _sz[f['file']] == _big]
if len(sel) != _n0: print('dropped small frames:', _n0 - len(sel))
assert len(sel) > 2, 'no frames in window'
lst = f'{REC}/{name}.concat'
with open(lst, 'w') as fh:
    for a, b in zip(sel, sel[1:]):
        fh.write(f"file '{REC_ABS}/frames/{a['file']}'\nduration {max(0.0005, (b['ts'] - a['ts']) / speed):.6f}\n")
    tail = max(1 / 30, (T0 + t1 - sel[-1]['ts']) / speed)
    fh.write(f"file '{REC_ABS}/frames/{sel[-1]['file']}'\nduration {tail:.6f}\nfile '{REC_ABS}/frames/{sel[-1]['file']}'\n")
dst = os.path.join(out, f'{name}.mp4')
cmd = ['ffmpeg', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lst, '-vf', f'scale={_big[0]}:{_big[1]},fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', os.environ.get('CRF', '14'), '-preset', 'medium', '-movflags', '+faststart', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', dst]
subprocess.run(cmd, check=True)
dur = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', dst]).decode().strip())
print(json.dumps({'name': name, 'file': dst, 't0': t0, 't1': t1, 'speed': speed, 'frames_in': len(sel), 'dur': round(dur, 3), 'frames_out': round(dur * 30)}))
