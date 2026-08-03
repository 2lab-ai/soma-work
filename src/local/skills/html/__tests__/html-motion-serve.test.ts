import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILL_ROOT = resolve(__dirname, '..');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const SERVER = resolve(SKILL_ROOT, 'server', 'serve.mjs');
const LOTTIE_SKILL_MD = resolve(SKILL_ROOT, '..', 'lottie', 'SKILL.md');

describe('local:html skill — motion layer + local web server contract', () => {
  it('wires the lottie skill in as the motion layer before HTML generation', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    // Step 3.7 consults skills/lottie before Step 4 writes HTML. If this
    // ordering is lost, motion becomes an afterthought bolted onto finished
    // markup instead of part of the design pass.
    expect(md).toMatch(/skills\/lottie\/SKILL\.md/);
    const lottieIdx = md.search(/skills\/lottie\/SKILL\.md/);
    const generateIdx = md.search(/###\s*4\.\s*Generate HTML/);
    expect(lottieIdx).toBeGreaterThan(-1);
    expect(generateIdx).toBeGreaterThan(-1);
    expect(lottieIdx).toBeLessThan(generateIdx);
    // Embed-mode invariants: inline data, capped count, reduced-motion guard.
    expect(md).toMatch(/animationData/);
    expect(md).toMatch(/prefers-reduced-motion/);
    expect(md).toMatch(/≤\s*3|<= 3|at most 3/i);
  });

  it('the lottie skill the motion layer points at actually exists', () => {
    expect(existsSync(LOTTIE_SKILL_MD)).toBe(true);
  });

  it('publishes to the local web server and treats the access link as a deliverable', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    expect(md).toMatch(/server\/serve\.mjs/);
    // The serve step must come before the Slack upload step so the link can
    // ride in the upload comment.
    const serveIdx = md.search(/###\s*7\.\s*Publish to the local web server/);
    const uploadIdx = md.search(/###\s*8\.\s*Dual upload/);
    expect(serveIdx).toBeGreaterThan(-1);
    expect(uploadIdx).toBeGreaterThan(-1);
    expect(serveIdx).toBeLessThan(uploadIdx);
    // Link hygiene: curl-verify, and LAN URL over localhost.
    expect(md).toMatch(/curl -fsS/);
    expect(md).toMatch(/localhost.*only (works|resolves)|only resolves on the host/i);
  });

  it('serves from a durable per-user archive root, never /tmp by default', () => {
    const src = readFileSync(SERVER, 'utf8');
    // The default root must resolve to user data dirs; /tmp is legacy-only.
    // OS temp cleanup wiping the serve root deleted every published artifact
    // once (2026-07 — recovered only by replaying session transcripts).
    expect(src).toMatch(/XDG_DATA_HOME/);
    expect(src).toMatch(/homedir/);
    expect(src).toMatch(/'\.local',\s*'share',\s*'soma-html-serve'/);
    expect(src).toMatch(/LEGACY_SERVE_ROOT\s*=\s*process\.env\.SOMA_HTML_LEGACY_ROOT\s*\|\|\s*'\/tmp\/soma-html-serve'/);
    expect(src).not.toMatch(/SOMA_HTML_SERVE_ROOT\s*\|\|\s*'\/tmp\/soma-html-serve'/);
    // Explicit override must stay supported.
    expect(src).toMatch(/SOMA_HTML_SERVE_ROOT/);
    // The health probe advertises the daemon's root so a publisher can detect
    // a pre-durable-root daemon still serving the legacy directory…
    expect(src).toMatch(/root=\$\{SERVE_ROOT\}/);
    // …and legacy artifacts are migrated forward, never destroyed. The sweep
    // must refuse symlinks (lstat) and must not swallow failures silently.
    expect(src).toMatch(/migrateLegacyArtifacts/);
    expect(src).toMatch(/lstatSync/);
    expect(src).toMatch(/migrationErrors/);
    // The printed link is verified with a real HTTP GET before hand-out.
    expect(src).toMatch(/verifyServed/);
    const md = readFileSync(SKILL_MD, 'utf8');
    expect(md).toMatch(/durable|archive/i);
    expect(md).toMatch(/SOMA_HTML_SERVE_ROOT/);
    // Archive-forever + LAN exposure requires an explicit no-secrets warning.
    expect(md).toMatch(/secrets, tokens, or personal data/i);
  });

  it('ui-ux design driver is the unconditional default, not opt-in', () => {
    const md = readFileSync(SKILL_MD, 'utf8');
    expect(md).toMatch(/not opt-in/i);
    expect(md).toMatch(/every invocation/i);
  });

  it('server/serve.mjs is a self-contained node static server with health + traversal guard', () => {
    expect(existsSync(SERVER)).toBe(true);
    const src = readFileSync(SERVER, 'utf8');
    // node:http only — no express/serve-static runtime deps to install.
    expect(src).toMatch(/node:http/);
    expect(src).not.toMatch(/require\(['"]express['"]\)|from ['"]express['"]/);
    // Ownership probe so we never publish through a foreign process's port.
    expect(src).toMatch(/__soma-serve-health/);
    // Detached daemon — the link must outlive the agent turn.
    expect(src).toMatch(/detached:\s*true/);
    expect(src).toMatch(/unref\(\)/);
    // Path traversal guard — lexical containment AND symlink-following
    // realpath containment (a symlink inside the root must not leak files
    // outside it over the LAN).
    expect(src).toMatch(/startsWith\(rootReal/);
    expect(src).toMatch(/realpathSync\(target\)/);
    // LAN exposure is intentional but must be overridable.
    expect(src).toMatch(/SOMA_HTML_SERVE_BIND/);
    // Entrypoint keeps the 0/1/2 exit-code contract on unexpected throws.
    expect(src).toMatch(/publish\(args\.file, args\.port\)\.catch/);
    // Output contract consumed by the skill (and by humans reading Slack).
    expect(src).toMatch(/localUrl/);
  });
});
