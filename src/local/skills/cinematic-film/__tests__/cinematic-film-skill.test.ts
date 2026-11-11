import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';

const SKILL_ROOT = resolve(__dirname, '..');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const read = (...p: string[]) => readFileSync(resolve(SKILL_ROOT, ...p), 'utf8');

function parseFrontmatter(md: string): Record<string, string> {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (key) out[key] = line.slice(colon + 1).trim();
  }
  return out;
}

describe('cinematic-film skill — contract', () => {
  it('SKILL.md front matter is valid YAML (a loader that parses YAML must not drop the skill)', () => {
    const fm = read('SKILL.md').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    expect(parseYaml(fm)).toMatchObject({
      name: 'cinematic-film',
      description: expect.stringMatching(/iPhone mockup/),
    });
  });

  it('SKILL.md has frontmatter name cinematic-film and a trigger-bearing description', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
    const fm = parseFrontmatter(read('SKILL.md'));
    expect(fm.name).toBe('cinematic-film');
    expect(fm.description).toMatch(/cinematic/i);
    expect(fm.description).toMatch(/시네마틱/);
    expect(fm.description).toMatch(/depth of field|out-of-focus|아웃오브포커스/i);
  });

  it('states the look as rules: fixed blur levels, moving focus masks, oversampled plane, beat cuts', () => {
    const md = read('SKILL.md');
    expect(md).toMatch(/never animate the blur radius/i);
    expect(md).toMatch(/oversampl/i);
    expect(md).toMatch(/rack/i);
    expect(md).toMatch(/beat/i);
    expect(md).toMatch(/-14 LUFS/);
  });

  it('carries the privacy rule: readable text is published text', () => {
    const md = read('SKILL.md');
    expect(md).toMatch(/privacy/i);
    expect(md).toMatch(/every readable/i);
  });

  it('requires an independent review loop until SHIP', () => {
    const md = read('SKILL.md');
    expect(md).toMatch(/independent review/i);
    expect(md).toMatch(/SHIP/);
    expect(existsSync(resolve(SKILL_ROOT, 'references', 'review-rubric.md'))).toBe(true);
  });

  it('ships the rig, the cut/GIF/mix scripts and the example film it describes', () => {
    for (const f of [
      'templates/remotion/Plate.tsx.template',
      'templates/remotion/Film.example.tsx.template',
      'scripts/cut.py',
      'scripts/make_gif.py',
      'scripts/mix_audio.py',
      'references/review-rubric.md',
    ]) {
      expect(existsSync(resolve(SKILL_ROOT, f)), f).toBe(true);
    }
    const plate = read('templates', 'remotion', 'Plate.tsx.template');
    // self-contained: no import from a project-specific lib path
    expect(plate).not.toMatch(/from '\.\.\/lib\//);
    expect(plate).toMatch(/export const Plate/);
  });

  it('ships the device look: its rules, the phone templates and the capture/cut scripts', () => {
    const md = read('SKILL.md');
    expect(md).toMatch(/device look/i);
    expect(md).toMatch(/iPhone/);
    expect(md).toMatch(/references\/device-demo\.md/);
    expect(md).toMatch(/cinetic/);
    const fm = parseFrontmatter(md);
    expect(fm.description).toMatch(/아이폰 목업|iPhone mockup/);
    for (const f of [
      'references/device-demo.md',
      'templates/remotion/device/Device.tsx.template',
      'templates/remotion/device/Keyboard.tsx.template',
      'templates/remotion/device/hangul.ts.template',
      'templates/remotion/device/Touch.tsx.template',
      'templates/remotion/device/Caption.tsx.template',
      'templates/remotion/device/Safari.tsx.template',
      'templates/remotion/device/Slack.tsx.template',
      'templates/remotion/device/tokens.ts.template',
      'templates/remotion/device/PhoneFilm.example.tsx.template',
      'scripts/mobile_capture.cjs',
      'scripts/cut_phone.py',
    ]) {
      expect(existsSync(resolve(SKILL_ROOT, f)), f).toBe(true);
    }
    for (const f of [
      'Device.tsx',
      'Keyboard.tsx',
      'Touch.tsx',
      'Caption.tsx',
      'Safari.tsx',
      'Slack.tsx',
      'PhoneFilm.example.tsx',
    ]) {
      expect(read('templates', 'remotion', 'device', `${f}.template`), f).not.toMatch(/from '\.\.\/lib\//);
    }
    const ref = read('references', 'device-demo.md');
    expect(ref).toMatch(/60 fps/);
    expect(ref).toMatch(/-14 LUFS/);
    expect(ref).toMatch(/Mock only what cannot be recorded/);
  });

  it('types Hangul jamo by jamo on the 2-set keyboard (hangul.ts.template)', () => {
    const src = read('templates', 'remotion', 'device', 'hangul.ts.template');
    const js = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const mod: { exports: Record<string, unknown> } = { exports: {} };
    new Function('module', 'exports', js)(mod, mod.exports);
    const presses = mod.exports.presses as (
      t: string,
    ) => Array<{ key: string; layout: string; shift: boolean; text: string }>;
    // 읽 = ㅇ ㅣ ㄹ ㄱ, composing in place
    expect(presses('읽').map((p) => p.key)).toEqual(['ㅇ', 'ㅣ', 'ㄹ', 'ㄱ']);
    expect(presses('읽').map((p) => p.text)).toEqual(['ㅇ', '이', '일', '읽']);
    // 와 = ㅇ ㅗ ㅏ (a compound vowel is two keys); 쌀 starts with shift + ㅅ
    expect(presses('와').map((p) => p.key)).toEqual(['ㅇ', 'ㅗ', 'ㅏ']);
    expect(presses('쌀')[0]).toMatchObject({ key: 'ㅅ', shift: true });
    // Latin switches to the English rows (capitals with shift); punctuation to 123
    expect(presses('A.').map((p) => [p.key, p.layout, p.shift])).toEqual([
      ['a', 'en', true],
      ['.', 'num', false],
    ]);
    // the 2-set IME puts a consonant on the last syllable first, then moves it when the vowel comes
    expect(presses('하이').map((p) => p.text)).toEqual(['ㅎ', '하', '항', '하이']);
    expect(presses('갈비').map((p) => p.text)).toEqual(['ㄱ', '가', '갈', '갋', '갈비']);
    expect(presses('아빠').map((p) => p.text)).toEqual(['ㅇ', '아', '아ㅃ', '아빠']); // ㅃ is never a final
    const typed = presses('세 줄');
    expect(typed[typed.length - 1]?.text).toBe('세 줄');
  });

  const hasPython = spawnSync('python3', ['--version']).status === 0;
  it.skipIf(!hasPython)(
    'cut_phone.py maps take markers to film frames (speed, offsets, swipe ends, extra taps)',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'cut-phone-'));
      mkdirSync(join(dir, 'takes', 't1'), { recursive: true });
      const marks = [
        { ts: 100, name: 'rec-start' },
        { ts: 101.5, name: 'swipe', x: 196, y: 420, dy: 300 },
        { ts: 102, name: 'tap', what: 'open', x: 120.04, y: 300 },
        { ts: 102.2, name: 'key', ch: '요' },
        { ts: 102.5, name: 'swipe-end' },
        { ts: 104, name: 'tap', what: 'outside', x: 1, y: 1 },
        { ts: 105, name: 'rec-stop', frames: 0 },
      ];
      writeFileSync(join(dir, 'takes', 't1', 'markers.jsonl'), `${marks.map((m) => JSON.stringify(m)).join('\n')}\n`);
      const shot = {
        id: 's1',
        take: 't1',
        t0: 1,
        t1: 3,
        speed: 2,
        vh: 716,
        drop: [[1.1, 1.2]],
        extra: [{ t: 2.5, x: 350, y: 26, what: 'close' }],
      };
      writeFileSync(join(dir, 'shots.json'), JSON.stringify({ fps: 60, shots: [shot] }));
      const gen = join(dir, 'shots.gen.ts');
      const args = [
        resolve(SKILL_ROOT, 'scripts', 'cut_phone.py'),
        join(dir, 'shots.json'),
        '--takes',
        join(dir, 'takes'),
      ];
      const r = spawnSync('python3', [...args, '--public', join(dir, 'pub'), '--gen', gen, '--events-only'], {
        encoding: 'utf8',
      });
      expect(r.status, r.stderr).toBe(0);
      const ts = readFileSync(gen, 'utf8');
      const table = JSON.parse(
        ts.slice(ts.indexOf('Record<string, Shot> = ') + 23, ts.indexOf(';\nexport const SHOT_ORDER')),
      );
      const s1 = table.s1;
      // 2 s of source at speed 2 = 1 s of film = 60 frames; source time t lands at (t - t0) / speed * 60
      expect(s1.dur).toBe(60);
      expect(s1.ev).toEqual(
        expect.arrayContaining([
          { f: 15, k: 'swipe', x: 196, y: 420, dy: 300, to: 45 },
          { f: 30, k: 'tap', x: 120, y: 300, what: 'open' },
          { f: 36, k: 'key', ch: '요' },
          { f: 45, k: 'tap', x: 350, y: 26, what: 'close' },
        ]),
      );
      expect(s1.ev.some((e: { what?: string }) => e.what === 'outside')).toBe(false);
      // cut-only fields never reach the film's Shot type
      expect(s1).not.toHaveProperty('drop');
      expect(s1).not.toHaveProperty('extra');
      expect(s1).not.toHaveProperty('take');
    },
  );

  // the cutter for real: frames on disk -> clip -> decoded colours per film frame
  const canCut =
    spawnSync('python3', ['-c', 'import PIL']).status === 0 && spawnSync('ffmpeg', ['-version']).status === 0;
  it.skipIf(!canCut)(
    'cut_phone.py keeps capture timing to the 60 fps frame, honours drops and covers the whole window',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'cut-phone-frames-'));
      const take = (name: string, frames: Array<[number, string, number?]>) => {
        mkdirSync(join(dir, 'takes', name, 'frames'), { recursive: true });
        const rows = frames.map(([ts, colour, height = 30], i) => {
          const file = `${String(i + 1).padStart(6, '0')}.jpg`;
          const r = spawnSync('ffmpeg', [
            '-loglevel',
            'error',
            '-y',
            '-f',
            'lavfi',
            '-i',
            `color=c=${colour}:s=1179x${height}`,
            '-frames:v',
            '1',
            join(dir, 'takes', name, 'frames', file),
          ]);
          expect(r.status, String(r.stderr)).toBe(0);
          return JSON.stringify({ i: i + 1, ts, file });
        });
        writeFileSync(join(dir, 'takes', name, 'frames.jsonl'), `${rows.join('\n')}\n`);
        const marks = [
          { ts: 100, name: 'rec-start' },
          { ts: 102, name: 'rec-stop', frames: frames.length },
        ];
        writeFileSync(join(dir, 'takes', name, 'markers.jsonl'), `${marks.map((m) => JSON.stringify(m)).join('\n')}\n`);
      };
      // t1: red, a magenta flash just before the window, a green flash inside it, blue 0.41 s into the window
      take('t1', [
        [100, 'red'],
        [100.15, 'magenta'],
        [100.3, 'lime'],
        [100.61, 'blue'],
      ]);
      // t2: the first frame arrives 0.1 s after the window opens
      take('t2', [
        [100.1, 'red'],
        [100.3, 'blue'],
      ]);
      // t3: blue 0.91 s into a window played at speed 2, so 0.455 s into the film: frame 27 (27.3)
      // t4: red at this height, then the viewport changes (green at another height), then blue at this height again
      take('t4', [
        [100, 'red'],
        [100.2, 'lime', 60],
        [100.5, 'blue'],
      ]);
      take('t3', [
        [100, 'red'],
        [100.91, 'blue'],
      ]);
      const shots = [
        {
          id: 'w',
          take: 't1',
          t0: 0.2,
          t1: 1,
          speed: 1,
          vh: 10,
          drop: [
            [0.12, 0.18],
            [0.25, 0.35],
          ],
        },
        { id: 'late', take: 't2', t0: 0, t1: 0.5, vh: 10 },
        { id: 'fast', take: 't3', t0: 0, t1: 1.6, speed: 2, vh: 10 },
        { id: 'resized', take: 't4', t0: 0.3, t1: 0.8, vh: 10 },
      ];
      writeFileSync(join(dir, 'shots.json'), JSON.stringify({ fps: 60, shots }));
      const gen = join(dir, 'shots.gen.ts');
      const r = spawnSync(
        'python3',
        [
          resolve(SKILL_ROOT, 'scripts', 'cut_phone.py'),
          join(dir, 'shots.json'),
          '--takes',
          join(dir, 'takes'),
          '--public',
          join(dir, 'pub'),
          '--gen',
          gen,
        ],
        { encoding: 'utf8' },
      );
      expect(r.status, r.stderr).toBe(0);
      const colours = (id: string) => {
        const raw = spawnSync('ffmpeg', [
          '-loglevel',
          'error',
          '-i',
          join(dir, 'pub', 'phone', `${id}.mp4`),
          '-vf',
          'scale=1:1',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          '-',
        ]).stdout;
        const out: string[] = [];
        for (let i = 0; i + 2 < raw.length; i += 3) {
          const [R, G, B] = [raw[i], raw[i + 1], raw[i + 2]];
          out.push(R > 128 && B > 128 ? 'magenta' : R > 128 ? 'red' : G > 128 ? 'green' : B > 128 ? 'blue' : '?');
        }
        return out;
      };
      const w = colours('w');
      expect(w.length).toBe(48); // 0.8 s at 60 fps
      // blue lands 0.41 s in: after film frame 24 (0.400 s), on frame 25 (0.417 s). A 25 fps time base moves it.
      expect(
        w.slice(0, 25).every((c) => c === 'red'),
        w.join(' '),
      ).toBe(true);
      expect(
        w.slice(25).every((c) => c === 'blue'),
        w.join(' '),
      ).toBe(true);
      // the late take still fills its whole window, opening on its first frame
      const late = colours('late');
      expect(late.length).toBe(30);
      expect(late[0]).toBe('red');
      // the default speed is written out: the film divides source seconds by it
      const ts = readFileSync(gen, 'utf8');
      const table = JSON.parse(
        ts.slice(ts.indexOf('Record<string, Shot> = ') + 23, ts.indexOf(';\nexport const SHOT_ORDER')),
      );
      expect(table.late.speed).toBe(1);
      // speed 2 halves the source timing in the encoded clip, to the frame
      const fast = colours('fast');
      expect(fast.length).toBe(48); // 1.6 s of source at speed 2
      expect(
        fast.slice(0, 27).every((c) => c === 'red') && fast.slice(27).every((c) => c === 'blue'),
        fast.join(' '),
      ).toBe(true);
      // after a viewport change the old red frame is stale: the shot holds its first frame of this size (blue)
      const resized = colours('resized');
      expect(resized.length).toBe(30);
      expect(
        resized.every((c) => c === 'blue'),
        resized.join(' '),
      ).toBe(true);
    },
    60_000, // seven ffmpeg runs: slow on a loaded runner
  );

  it('cut_phone.py refuses a failed or unfinished take', () => {
    if (!hasPython) return;
    const dir = mkdtempSync(join(tmpdir(), 'cut-phone-bad-'));
    const cut = (marks: object[], t1 = 1) => {
      mkdirSync(join(dir, 'takes', 't'), { recursive: true });
      writeFileSync(join(dir, 'takes', 't', 'markers.jsonl'), `${marks.map((m) => JSON.stringify(m)).join('\n')}\n`);
      writeFileSync(
        join(dir, 'shots.json'),
        JSON.stringify({ fps: 60, shots: [{ id: 's', take: 't', t0: 0, t1, vh: 716 }] }),
      );
      return spawnSync(
        'python3',
        [
          resolve(SKILL_ROOT, 'scripts', 'cut_phone.py'),
          join(dir, 'shots.json'),
          '--takes',
          join(dir, 'takes'),
          '--public',
          join(dir, 'pub'),
          '--gen',
          join(dir, 'g.ts'),
          '--events-only',
        ],
        { encoding: 'utf8' },
      );
    };
    const refused = (marks: object[], why: RegExp, t1 = 1) => {
      const r = cut(marks, t1);
      expect(r.status, r.stdout).not.toBe(0);
      expect(r.stderr).toMatch(why);
      expect(existsSync(join(dir, 'g.ts')), 'no shot table from a refused take').toBe(false);
    };
    refused(
      [
        { ts: 1, name: 'rec-start' },
        { ts: 3, name: 'rec-failed', frames: 0 },
      ],
      /rec-failed/,
    );
    refused([{ ts: 1, name: 'rec-start' }], /unfinished take/);
    // a window past the recording (a retake shorter than the plan)
    refused(
      [
        { ts: 1, name: 'rec-start' },
        { ts: 3, name: 'rec-stop', frames: 9 },
      ],
      /window outside the take/,
      2.5,
    );
    expect(
      cut([
        { ts: 1, name: 'rec-start' },
        { ts: 3, name: 'rec-stop', frames: 9 },
      ]).status,
    ).toBe(0);
  });

  it.skipIf(!hasPython)('cut_phone.py gives a tap on the boundary of two adjacent shots to one shot only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cut-phone-edge-'));
    mkdirSync(join(dir, 'takes', 't'), { recursive: true });
    const marks = [
      { ts: 100, name: 'rec-start' },
      { ts: 100.98, name: 'tap', what: 'edge', x: 10, y: 10 },
      { ts: 100.995, name: 'tap', what: 'last', x: 10, y: 10 },
      { ts: 101, name: 'tap', what: 'at-cut', x: 10, y: 10 },
      { ts: 101.4, name: 'swipe', x: 196, y: 420, dy: 300 },
      { ts: 102.3, name: 'swipe-end' },
      { ts: 103, name: 'rec-stop', frames: 0 },
    ];
    writeFileSync(join(dir, 'takes', 't', 'markers.jsonl'), `${marks.map((m) => JSON.stringify(m)).join('\n')}\n`);
    const shots = [
      { id: 'a', take: 't', t0: 0, t1: 1, vh: 716 },
      { id: 'b', take: 't', t0: 1, t1: 2, vh: 716 },
    ];
    writeFileSync(join(dir, 'shots.json'), JSON.stringify({ fps: 60, shots }));
    const gen = join(dir, 'g.ts');
    const r = spawnSync(
      'python3',
      [
        resolve(SKILL_ROOT, 'scripts', 'cut_phone.py'),
        join(dir, 'shots.json'),
        '--takes',
        join(dir, 'takes'),
        '--public',
        join(dir, 'pub'),
        '--gen',
        gen,
        '--events-only',
      ],
      { encoding: 'utf8' },
    );
    expect(r.status, r.stderr).toBe(0);
    const ts = readFileSync(gen, 'utf8');
    const table = JSON.parse(
      ts.slice(ts.indexOf('Record<string, Shot> = ') + 23, ts.indexOf(';\nexport const SHOT_ORDER')),
    );
    const whats = (id: string) =>
      table[id].ev.filter((e: { k: string }) => e.k === 'tap').map((e: { what: string }) => e.what);
    expect(whats('a')).toEqual(['edge', 'last']);
    expect(ts).toContain('export const SHOT_ORDER: string[] = ["a", "b"];');
    // 0.995 s rounds to frame 60 of a 60-frame shot: it stays on the shot's last frame (59)
    expect(table.a.ev.find((e: { what?: string }) => e.what === 'last').f).toBe(59);
    expect(whats('b')).toEqual(['at-cut']);
    // a swipe that runs past its shot keeps its end
    expect(table.b.ev).toContainEqual({ f: 24, k: 'swipe', x: 196, y: 420, dy: 300, to: 78 });
  });

  it('maskResponses rewrites a response, aborts on a failed fetch or rewrite (never replays), passes streams', async () => {
    const { maskResponses } = createRequire(__filename)(resolve(SKILL_ROOT, 'scripts', 'mobile_capture.cjs'));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handlerFor = async (opts?: object) => {
      let h: (route: unknown) => Promise<unknown> = async () => {};
      const ctx = {
        route: async (_m: unknown, fn: typeof h) => {
          h = fn;
        },
      };
      await maskResponses(
        ctx,
        () => true,
        (t: string) => {
          if (t.includes('boom')) throw new Error('bad');
          return t.replace('a@b.co', 'x@example.com');
        },
        opts,
      );
      return h;
    };
    const route = (accept: string, fetch: () => Promise<unknown>, method = 'GET') => ({
      request: () => ({ headers: () => ({ accept }), url: () => 'http://x/api', method: () => method }),
      fetch: vi.fn(fetch),
      fulfill: vi.fn(),
      abort: vi.fn(),
      continue: vi.fn(),
    });
    const disposed = vi.fn(async () => {});
    const json =
      (body: string, status = 200) =>
      async () => ({
        status: () => status,
        headers: () => ({ 'content-type': 'application/json' }),
        text: async () => body,
        dispose: disposed,
      });
    const redirect = (to: string) => async () => ({
      status: () => 302,
      headers: () => ({ location: to }),
      text: async () => '',
      dispose: disposed,
    });
    const h = await handlerFor();
    const ok = route('application/json', json('{"e":"a@b.co"}'));
    await h(ok);
    expect(ok.fulfill).toHaveBeenCalledWith(expect.objectContaining({ body: '{"e":"x@example.com"}' }));
    // redirects are followed inside the route (the browser would not route the redirected request), so the final
    // body is the one masked; the buffered response is freed after
    expect(ok.fetch).toHaveBeenCalledWith({ timeout: 15000, maxRedirects: 0 });
    expect(disposed).toHaveBeenCalledTimes(1);
    // a same-origin redirect is followed here and its final body masked; one to another origin is aborted
    // (each hop resolves against the URL before it: /api/v2 then ok -> /api/ok)
    const hop = route('application/json', redirect('/api/v2'));
    hop.fetch
      .mockImplementationOnce(redirect('/api/v2'))
      .mockImplementationOnce(redirect('ok'))
      .mockImplementationOnce(json('{"e":"a@b.co"}'));
    await h(hop);
    expect(hop.fetch).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: 'http://x/api/ok', method: 'GET', timeout: 15000, maxRedirects: 0 }),
    );
    expect(hop.fulfill).toHaveBeenCalledWith(expect.objectContaining({ body: '{"e":"x@example.com"}' }));
    // a POST answered 303 continues as a GET without its body; a 307 keeps the POST
    const see = (status: number) => async () => ({
      status: () => status,
      headers: () => ({ location: '/api/result' }),
      text: async () => '',
      dispose: disposed,
    });
    const posted = route('application/json', see(303), 'POST');
    posted.fetch.mockImplementationOnce(see(303)).mockImplementationOnce(json('{}'));
    await h(posted);
    expect(posted.fetch).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'GET', postData: '' }));
    const kept = route('application/json', see(307), 'POST');
    kept.fetch.mockImplementationOnce(see(307)).mockImplementationOnce(json('{}'));
    await h(kept);
    expect(kept.fetch).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'POST' }));
    expect((kept.fetch.mock.lastCall as unknown[] | undefined)?.[0]).not.toHaveProperty('postData');
    const away = route('application/json', redirect('http://127.0.0.1:9/secret'));
    await h(away);
    expect(away.fetch).toHaveBeenCalledTimes(1);
    expect(away.abort).toHaveBeenCalledWith('failed');
    expect(away.fulfill).not.toHaveBeenCalled();
    for (const bad of [
      route('application/json', json('boom')),
      route('application/json', async () => {
        throw new Error('timeout');
      }),
    ]) {
      await h(bad);
      expect(bad.abort).toHaveBeenCalledWith('failed');
      expect(bad.fulfill).not.toHaveBeenCalled();
      expect(bad.continue).not.toHaveBeenCalled();
      expect(bad.fetch).toHaveBeenCalledTimes(1);
    }
    const sse = route('text/event-stream', json('{}'));
    await h(sse);
    expect(sse.continue).toHaveBeenCalled();
    expect(sse.fetch).not.toHaveBeenCalled();
    // a custom predicate adds streams; EventSource still passes with it
    const custom = await handlerFor({ stream: (req: { url: () => string }) => req.url().endsWith('/feed') });
    const named = route('*/*', json('{}'));
    named.request = () => ({ headers: () => ({ accept: '*/*' }), url: () => 'http://x/feed', method: () => 'GET' });
    await custom(named);
    expect(named.continue).toHaveBeenCalled();
    expect(named.fetch).not.toHaveBeenCalled();
    const sse2 = route('text/event-stream', json('{}'));
    await custom(sse2);
    expect(sse2.continue).toHaveBeenCalled();
    expect(sse2.fetch).not.toHaveBeenCalled();
    quiet.mockRestore();
  });

  it('recorder.stop finalises the frame log, then marks rec-stop (or rec-failed and throws)', async () => {
    const req = createRequire(__filename);
    const { recorder } = req(resolve(SKILL_ROOT, 'scripts', 'mobile_capture.cjs'));
    // watch the two logs: when the frame log ends and when rec-stop is written
    const fsMod = req('node:fs');
    const order: string[] = [];
    const real = fsMod.createWriteStream;
    const spy = vi.spyOn(fsMod, 'createWriteStream').mockImplementation((...args: unknown[]) => {
      const w = real.apply(fsMod, args);
      const file = String(args[0]);
      const write = w.write.bind(w);
      // 'finish': the frame log is flushed and complete, not just asked to end
      if (file.endsWith('frames.jsonl')) w.on('finish', () => order.push('frames-end'));
      w.write = (chunk: unknown, ...a: unknown[]) => {
        if (file.endsWith('markers.jsonl') && /rec-(stop|failed)/.test(String(chunk))) order.push('rec-stop');
        return write(chunk, ...a);
      };
      return w;
    });
    const take = async (failStop: boolean) => {
      const out = join(mkdtempSync(join(tmpdir(), 'rec-')), 'take');
      let onFrame: (f: unknown) => Promise<void> = async () => {};
      const cdp = {
        on: (_e: string, fn: typeof onFrame) => {
          onFrame = fn;
        },
        send: async (m: string) => {
          if (failStop && m === 'Page.stopScreencast') throw new Error('target closed');
        },
      };
      const rec = await recorder({ newCDPSession: async () => cdp }, {}, out);
      await rec.start();
      rec.mark('tap', { what: 'x', x: 1, y: 1 });
      const jpeg = Buffer.from('ff', 'hex').toString('base64');
      await onFrame({ data: jpeg, sessionId: 1, metadata: { timestamp: 1 } });
      const stopping = rec.stop().then(
        () => null,
        (e: Error) => e,
      );
      const err = await stopping;
      await onFrame({ data: jpeg, sessionId: 2, metadata: { timestamp: 2 } }); // after stop: ignored
      const frames = readFileSync(join(out, 'frames.jsonl'), 'utf8').trim().split('\n');
      expect(frames.map((l) => JSON.parse(l).ts)).toEqual([1]);
      const names = readFileSync(join(out, 'markers.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).name);
      return { err, names };
    };
    const bad = await take(true);
    expect(String(bad.err)).toMatch(/target closed/);
    expect(bad.names).toEqual(['rec-start', 'tap', 'rec-failed']);
    const good = await take(false);
    expect(good.err).toBeNull();
    expect(good.names).toEqual(['rec-start', 'tap', 'rec-stop']);
    spy.mockRestore();
    // both takes closed the frame log before writing their completion marker
    expect(order).toEqual(['frames-end', 'rec-stop', 'frames-end', 'rec-stop']);
  });

  it('names the Remotion license condition instead of hiding it', () => {
    expect(read('SKILL.md')).toMatch(/Remotion.*licen[cs]e/i);
  });
});
