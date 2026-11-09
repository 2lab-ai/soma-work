#!/usr/bin/env python3
"""README GIF from a CDP screencast take: frames.jsonl (ts per frame) between two marker times -> constant-rate frames ->
one palette (ffmpeg palettegen, stats_mode=diff) -> GIF. Crop in css px (the take's DSF scales it)."""
import json, subprocess, sys, os, argparse
ap = argparse.ArgumentParser()
ap.add_argument('take'); ap.add_argument('out')
ap.add_argument('--start', required=True); ap.add_argument('--end', required=True)  # marker[+/-sec], e.g. send+3
ap.add_argument('--crop', default=''); ap.add_argument('--dsf', type=float, default=2)
ap.add_argument('--width', type=int, default=960); ap.add_argument('--fps', type=int, default=12)
ap.add_argument('--hold', type=float, default=1.2)
ap.add_argument('--speed', type=float, default=1.0)  # hold the last frame (s)
a = ap.parse_args()
fr = [json.loads(l) for l in open(f'{a.take}/frames.jsonl')]
def jsize(p):
    b = open(p, 'rb').read(65536); i = 2
    while i < len(b):
        if b[i] != 0xFF: i += 1; continue
        m = b[i + 1]
        if m in (0xC0, 0xC1, 0xC2): return (b[i + 7] << 8 | b[i + 8], b[i + 5] << 8 | b[i + 6])
        i += 2 + (b[i + 2] << 8 | b[i + 3])
    return None
from collections import Counter
sz = {f['file']: jsize(f'{a.take}/frames/{f["file"]}') for f in fr}
big = Counter(sz.values()).most_common(1)[0][0]
fr = [f for f in fr if sz[f['file']] == big]
mk = [json.loads(l) for l in open(f'{a.take}/markers.jsonl')]
def t(spec):
    import re
    g = re.match(r'^(.*?)([+-]\d+(?:\.\d+)?)?$', spec)
    m = [x for x in mk if x['name'] == g.group(1)]
    return m[0]['ts'] + (float(g.group(2)) if g.group(2) else 0)
t0, t1 = t(a.start), t(a.end)
lst = f'{a.out}.txt'
seq = []
k = 0
n = int((t1 - t0) * a.fps / a.speed)
for i in range(n + 1):
    tt = t0 + i * a.speed / a.fps
    while k + 1 < len(fr) and fr[k + 1]['ts'] <= tt: k += 1
    seq.append(fr[k]['file'])
seq += [seq[-1]] * int(a.hold * a.fps)
with open(lst, 'w') as f:
    for s in seq: f.write(f"file '{os.path.abspath(a.take)}/frames/{s}'\nduration {1 / a.fps:.5f}\n")
    f.write(f"file '{os.path.abspath(a.take)}/frames/{seq[-1]}'\n")
crop = ''
if a.crop:
    x, y, w, h = [float(v) * a.dsf for v in a.crop.split(',')]
    crop = f'crop={int(w)}:{int(h)}:{int(x)}:{int(y)},'
vf = f"{crop}scale={a.width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle"
subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lst, '-vf', vf, '-r', str(a.fps), '-loop', '0', a.out], check=True)
os.remove(lst)
print(a.out, f'{os.path.getsize(a.out) / 1e6:.2f} MB', f'{len(seq) / a.fps:.1f} s', f'{len(seq)} frames')
