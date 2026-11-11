import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const SKILL_ROOT = resolve(__dirname, '..');
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

describe('cinetic skill — a pinned loader for the upstream skill', () => {
  it('SKILL.md front matter is valid YAML', () => {
    const fm = read('SKILL.md').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    expect(parseYaml(fm)).toMatchObject({ name: 'cinetic', license: expect.stringMatching(/MIT/) });
  });

  it('SKILL.md has frontmatter name cinetic, EN/KO triggers and a license line', () => {
    const fm = parseFrontmatter(read('SKILL.md'));
    expect(fm.name).toBe('cinetic');
    expect(fm.description).toMatch(/cinetic/);
    expect(fm.description).toMatch(/시네틱/);
    expect(fm.description).toMatch(/cinematic-film/);
    expect(fm.license).toMatch(/MIT/);
  });

  it('pins one upstream commit, the same in the installer and the notice', () => {
    const sh = read('scripts', 'install.sh');
    const pin = sh.match(/CINETIC_PIN:-([0-9a-f]{40})/)?.[1];
    expect(pin, 'install.sh pins a full commit').toBeDefined();
    expect(sh).toMatch(/github\.com\/Leonxlnx\/cinetic/);
    expect(read('LICENSES', 'NOTICE.md')).toContain(pin as string);
    expect(statSync(resolve(SKILL_ROOT, 'scripts', 'install.sh')).mode & 0o111).not.toBe(0);
  });

  it('carries the upstream MIT license and routes recordings to cinematic-film', () => {
    expect(existsSync(resolve(SKILL_ROOT, 'LICENSES', 'cinetic-MIT.txt'))).toBe(true);
    expect(read('LICENSES', 'cinetic-MIT.txt')).toMatch(/MIT License/);
    const md = read('SKILL.md');
    expect(md).toMatch(/cinematic-film/);
    expect(md).toMatch(/Remotion.*licen[cs]e/i);
  });

  const hasGit = spawnSync('git', ['--version']).status === 0;
  it.skipIf(!hasGit)('install.sh checks out the pin once, even when two first runs race', async () => {
    // a local upstream: skills/cinetic/SKILL.md at a first commit, changed by a second (the pin is the first)
    const dir = mkdtempSync(join(tmpdir(), 'cinetic-install-'));
    const up = join(dir, 'upstream');
    mkdirSync(join(up, 'skills', 'cinetic'), { recursive: true });
    const git = (...a: string[]) => {
      const r = spawnSync('git', ['-C', up, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], {
        encoding: 'utf8',
      });
      expect(r.status, r.stderr).toBe(0);
      return r.stdout.trim();
    };
    git('init', '--quiet');
    writeFileSync(join(up, 'skills', 'cinetic', 'SKILL.md'), 'pinned\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'one');
    const pin = git('rev-parse', 'HEAD');
    writeFileSync(join(up, 'skills', 'cinetic', 'SKILL.md'), 'later\n');
    git('commit', '--quiet', '-am', 'two');
    const env = { ...process.env, CINETIC_REPO: `file://${up}`, CINETIC_PIN: pin, CINETIC_HOME: join(dir, 'home') };
    const run = () =>
      new Promise<{ code: number | null; out: string; err: string }>((done) => {
        const p = spawn('bash', [resolve(SKILL_ROOT, 'scripts', 'install.sh')], { env });
        let out = '';
        let err = '';
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => (err += d));
        p.on('close', (code) => done({ code, out: out.trim(), err }));
      });
    const [a, b] = await Promise.all([run(), run()]);
    const root = join(dir, 'home', pin, 'skills', 'cinetic');
    for (const r of [a, b]) {
      expect(r.code, r.err).toBe(0);
      expect(r.out).toBe(root);
    }
    expect(readFileSync(join(root, 'SKILL.md'), 'utf8')).toBe('pinned\n');
    expect(existsSync(join(dir, 'home', `${pin}.lock`))).toBe(false);
    // a finished checkout is returned again without touching the network (the upstream may be gone)
    env.CINETIC_REPO = `file://${join(dir, 'gone')}`;
    expect(await run()).toMatchObject({ code: 0, out: root });
    // a lock left by a killed install (its pid is gone) is taken over, not waited on for 2 minutes
    const dead = spawnSync('true').pid as number;
    const pin2 = git('rev-parse', 'HEAD');
    mkdirSync(join(dir, 'home', `${pin2}.lock`), { recursive: true });
    writeFileSync(join(dir, 'home', `${pin2}.lock`, 'pid'), String(dead));
    env.CINETIC_REPO = `file://${up}`;
    env.CINETIC_PIN = pin2;
    const t = Date.now();
    expect(await run()).toMatchObject({ code: 0, out: join(dir, 'home', pin2, 'skills', 'cinetic') });
    expect(Date.now() - t).toBeLessThan(20_000);
    expect(existsSync(join(dir, 'home', `${pin2}.lock`))).toBe(false);
    // a pin that is not a sha is refused before anything is removed or cloned
    env.CINETIC_PIN = '../..';
    expect((await run()).code).not.toBe(0);
  });

  it('loads through CLAUDE_PLUGIN_ROOT, never a runtime-root-relative runner command', () => {
    const md = read('SKILL.md');
    expect(md).toMatch(/export CLAUDE_PLUGIN_ROOT=/);
    expect(md).not.toMatch(/\b(?:npx\s+)?[A-Za-z0-9_.@/-]+\s+local\/[^\s"'`)]+/);
  });
});
