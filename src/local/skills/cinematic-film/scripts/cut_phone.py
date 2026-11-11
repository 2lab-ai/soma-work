#!/usr/bin/env python3
"""Cut phone-viewport takes into 60 fps clips and write the film's shot table.

usage: cut_phone.py shots.json --takes takes/ --public <film>/public --gen <film>/src/phone/shots.gen.ts [ids...] [--events-only]

shots.json: {"fps": 60, "shots": [{"id": "c1a", "take": "c1", "t0": 0.3, "t1": 4.4, "speed": 1, "vh": 716,
             "domain": "app.example.com", "load": [0.8, 1.4]}, {"id": "c1b", "take": "c1", "t0": 4.4, "t1": 8.0,
             "speed": 1, "vh": 504, "kb": "ko", "drop": [[0.85, 0.94]], "extra": [{"t": 7.9, "x": 350, "y": 26, "what": "close"}]}, ...]}
t0/t1 are seconds from the take's rec-start marker; speed > 1 plays faster; vh is the viewport height the shot was
recorded at (716 with Safari's bar, 504 with the keyboard up); kb picks the keyboard rows (ko, en, num).

A screencast sends a frame only when the page changes, so a window opens on the last frame before it, and frames of
the other viewport height are dropped (one size per shot). Each shot's markers become events in film frames from the
shot's first frame: tap (x, y css), swipe (x, y, dy, to), key (ch), dict, mic (the fake microphone's start).
Only a clean take is cut: markers that open with rec-start and hold a rec-stop (a rec-failed take is refused).
"""
import json, os, subprocess, sys
args = sys.argv[1:]
events_only = '--events-only' in args  # the shot table only: no frames read, no ffmpeg (tests, re-timing)
spec = json.load(open(args[0]))
opt = lambda k, d=None: args[args.index(k) + 1] if k in args else d
TAKES, PUB, GEN = opt('--takes', 'takes'), opt('--public'), opt('--gen')
assert PUB and GEN, 'need --public and --gen'
only = {a for a in args[1:] if not a.startswith('--') and a not in (TAKES, PUB, GEN)}
if not events_only:
    from PIL import Image
FPS = spec.get('fps', 60)
os.makedirs(os.path.join(PUB, 'phone'), exist_ok=True)
gen, cache = [], {}

def owner(take, r):
    """The one shot a marker r seconds into a take belongs to: the first (in shots.json order) whose [t0, t1) holds it,
    else the first whose window widened by 50 ms does. Adjacent shots never both draw one tap."""
    same = [x for x in spec['shots'] if x['take'] == take]
    hit = next((x for x in same if x['t0'] <= r < x['t1']), None) or next((x for x in same if x['t0'] - 0.05 <= r < x['t1'] + 0.05), None)
    return hit and hit['id']

for s in spec['shots']:
    R = os.path.abspath(os.path.join(TAKES, s['take']))
    if s['take'] not in cache:
        fr = [] if events_only else sorted([json.loads(l) for l in open(R + '/frames.jsonl')], key=lambda f: f['ts'])
        mk = [json.loads(l) for l in open(R + '/markers.jsonl')]
        names = [m['name'] for m in mk]
        # a take is cut only when its recorder started and stopped cleanly: a failed or unfinished take would be padded
        # with its last frame and pass for a finished shot
        assert names and names[0] == 'rec-start', ('take does not start with rec-start', s['take'])
        assert 'rec-failed' not in names, ('failed take (rec-failed)', s['take'])
        assert 'rec-stop' in names, ('unfinished take (no rec-stop)', s['take'])
        cache[s['take']] = (fr, mk, mk[0]['ts'], {})
    fr, mk, T0, sizes = cache[s['take']]
    sp = s.get('speed', 1)
    # a window past the recording would be padded with its last frame: refuse it (a retake shorter than the plan)
    stop = next(m['ts'] for m in mk if m['name'] == 'rec-stop') - T0
    assert 0 <= s['t0'] < s['t1'] <= stop + 0.001, ('window outside the take', s['id'], s['t0'], s['t1'], round(stop, 3))
    a, b = T0 + s['t0'], T0 + s['t1']
    H = round(s['vh'] * 3)
    def h(f):
        if f['file'] not in sizes: sizes[f['file']] = Image.open(R + '/frames/' + f['file']).size
        return sizes[f['file']][1]
    drops = [(T0 + x, T0 + y) for x, y in s.get('drop', [])]  # flashes: their frames go, the frame before holds
    keep = lambda f: abs(h(f) - H) <= 6 and not any(x <= f['ts'] <= y for x, y in drops)
    sel = [f for f in fr if a <= f['ts'] <= b and keep(f)]
    # the shot opens on the frame on screen at t0 (drops apply to it too). If the screen at t0 was another height (a
    # viewport change just before), an older frame of this height is stale: hold the first frame back to t0 instead
    before = [f for f in fr if f['ts'] < a and not any(x <= f['ts'] <= y for x, y in drops)]
    prev = before[-1:] if before and keep(before[-1]) else []
    if prev: sel = [dict(prev[-1], ts=a)] + sel
    elif sel: sel[0] = dict(sel[0], ts=a)
    assert sel or events_only, ('no frames in window', s['id'])  # one held frame is a valid static shot
    n = round((s['t1'] - s['t0']) / sp * FPS)
    dst = os.path.join(PUB, 'phone', s['id'] + '.mp4')
    if not events_only and (not only or s['id'] in only):
        lst = os.path.join(R, s['id'] + '.concat')
        # every image is its own image2 input, read at 25 fps by default: its 40 ms time base would quantise each
        # duration and turn a 60 fps scroll into 25 distinct frames a second. A 1 ms time base keeps the capture timing.
        q = lambda p: p.replace("'", "'\\''")  # ffconcat quoting: a ' in a path closes the quote
        item = lambda f: f"file '{q(R + '/frames/' + f['file'])}'\noption framerate 1000\n"
        with open(lst, 'w') as fh:
            fh.write('ffconcat version 1.0\n')
            for x, y in zip(sel, sel[1:]):
                fh.write(item(x) + f"duration {max(0.0005, (y['ts'] - x['ts']) / sp):.6f}\n")
            fh.write(item(sel[-1]) + f"duration {max(1 / FPS, (b - sel[-1]['ts']) / sp):.6f}\n" + item(sel[-1]))
        # 1180 wide: libx264 needs even sizes (the capture is 1179 = 393 x 3)
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lst, '-vf', f'scale=1180:{H},fps={FPS},format=yuv420p', '-frames:v', str(n), '-c:v', 'libx264', '-crf', '15', '-preset', 'medium', '-movflags', '+faststart', dst], check=True)
    ev = []
    fof = lambda ts: round((ts - a) / sp * FPS)
    for i, m in enumerate(mk):
        if m['name'] in ('rec-start', 'rec-stop', 'swipe-end') or owner(s['take'], m['ts'] - T0) != s['id']: continue
        f, k = fof(m['ts']), m['name']
        if k == 'tap': ev.append({'f': f, 'k': 'tap', 'x': round(m['x'], 1), 'y': round(m['y'], 1), 'what': m.get('what', '')})
        elif k == 'swipe':
            end = next((e for e in mk[i + 1:] if e['name'] == 'swipe-end'), None)  # its end, wherever the shot ends
            ev.append({'f': f, 'k': 'swipe', 'x': m['x'], 'y': m['y'], 'dy': m['dy'], **({'to': fof(end['ts'])} if end else {})})
        elif k == 'key': ev.append({'f': f, 'k': 'key', 'ch': m['ch']})
        elif k == 'dict': ev.append({'f': f, 'k': 'dict', 'final': m.get('final', ''), 'interim': m.get('interim', '')})
    for x in s.get('extra', []):  # taps the take did not mark: {"t": source s, "x", "y", "what"}
        ev.append({'f': round((T0 + x['t'] - a) / sp * FPS), 'k': 'tap', 'x': x['x'], 'y': x['y'], 'what': x.get('what', '')})
    mic = [m for m in mk if m['name'] == 'mic-start-at']
    if s.get('voice') and mic: ev.append({'f': round((mic[0]['at'] - a) / sp * FPS), 'k': 'mic'})
    g = {k: v for k, v in s.items() if k not in ('take', 'drop', 'extra')}  # cut-only fields stay out of the film's Shot
    g.update({'speed': sp, 'src': 'phone/' + s['id'] + '.mp4', 'dur': n, 'ev': ev}); gen.append(g)  # speed: always set
    print(s['id'], n, 'frames', len(ev), 'events')
ts = '// Generated by cinematic-film/scripts/cut_phone.py from shots.json. Do not edit.\n'
ts += 'export type Ev = { f: number; k: string; x?: number; y?: number; dy?: number; to?: number; ch?: string; what?: string; final?: string; interim?: string };\n'
ts += 'export type Shot = { id: string; t0: number; t1: number; speed: number; vh: number; domain?: string; kb?: string; voice?: boolean; load?: number[]; src: string; dur: number; ev: Ev[] };\n'
ts += 'export const SHOTS: Record<string, Shot> = ' + json.dumps({g['id']: g for g in gen}, ensure_ascii=False, indent=1) + ';\n'
with open(GEN, 'w') as fh: fh.write(ts)  # closed (and flushed) before the run reports success
print('total', sum(g['dur'] for g in gen), 'frames =', round(sum(g['dur'] for g in gen) / FPS, 1), 's')
