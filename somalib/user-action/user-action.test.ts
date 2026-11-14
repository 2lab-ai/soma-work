import { describe, expect, it } from 'vitest';
import {
  appendUserAction,
  inspectUserActionScript,
  parseInstructUserToolResult,
  parseUserActionRecord,
  resolveUserAction,
  restoreUserActions,
  USER_ACTION_LIMITS,
  USER_ACTIONS_KEPT,
  type UserActionSyntaxCheck,
  validateInstructUserArgs,
} from './user-action';

const SYNTAX_OK: UserActionSyntaxCheck = { checked: true, ok: true, tool: 'bash -n' };

const base = {
  title: 'YouTube 고급 기능 인증 페이지 열기',
  host: 'owner-mac',
  why: '채널 소유자 본인만 할 수 있는 얼굴 인증이라 봇이 대신할 수 없습니다.',
  script: "open 'https://myaccount.google.com/video-verification/submit'",
  expect: '브라우저에 Google 동영상 인증 페이지가 열린다',
  effects: '기본 브라우저로 페이지 하나를 연다. 파일은 바꾸지 않는다.',
};

describe('validateInstructUserArgs', () => {
  it('accepts a complete request and defaults shell to bash, optional to false', () => {
    const r = validateInstructUserArgs(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.shell).toBe('bash');
    expect(r.request.optional).toBe(false);
    expect(r.request.host).toBe('owner-mac');
  });

  it.each(['title', 'host', 'why', 'script', 'expect', 'effects'])('rejects a missing %s', (field) => {
    const r = validateInstructUserArgs({ ...base, [field]: '   ' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INVALID_ARGS');
    expect(r.error.message).toContain(field);
  });

  it('rejects a script longer than the line cap — it must stay short', () => {
    const script = Array.from({ length: USER_ACTION_LIMITS.scriptLines + 1 }, (_, i) => `echo ${i}`).join('\n');
    const r = validateInstructUserArgs({ ...base, script });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SCRIPT_TOO_LONG');
  });

  it('rejects a script longer than the character cap', () => {
    const r = validateInstructUserArgs({ ...base, script: `echo ${'x'.repeat(USER_ACTION_LIMITS.scriptChars)}` });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SCRIPT_TOO_LONG');
  });

  it('rejects a bare URL — a link is not a script', () => {
    const r = validateInstructUserArgs({ ...base, script: 'https://youtube.com/qr/abc' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NOT_A_SCRIPT');
  });

  it('rejects a script that is only comments', () => {
    const r = validateInstructUserArgs({ ...base, script: '# open the page yourself' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NOT_A_SCRIPT');
  });

  it('rejects a script carrying a secret — it would be posted to Slack and the dashboard', () => {
    const r = validateInstructUserArgs({
      ...base,
      script: 'curl -H "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789" https://api.github.com',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SECRET_IN_SCRIPT');
    expect(r.error.message).not.toContain('ghp_abcdef');
  });

  it.each([
    ['a JWT', 'curl -H "x: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc" https://x.example'],
    ['a bearer header', 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345" https://x.example'],
    ['a secret-named assignment', 'API_KEY=abcdef0123456789xyz ./run'],
  ])('rejects %s as a credential', (_name, script) => {
    const r = validateInstructUserArgs({ ...base, script });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SECRET_IN_SCRIPT');
  });

  it.each([
    ["PASSWORD='hunter2' ./login"],
    ["PASSWORD='correct horse battery staple' ./login"],
    ['export API_KEY="abc" && ./run'],
    ['DB_PASSWD=x ./run'],
  ])('rejects any literal assigned to a secret-named variable, whatever its length: %s', (script) => {
    const r = validateInstructUserArgs({ ...base, script });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SECRET_IN_SCRIPT');
  });

  it.each([
    ['API_KEY="$(pass show api/key)" ./run'],
    ['GITHUB_TOKEN=$TOKEN_FROM_ENV ./run'],
    ['TOKEN= ./run'],
    ["PASSWORD='' ./run"],
    ['TOKEN_FILE=/etc/app/token ./run'],
  ])('lets a reference, an empty value or a path through: %s', (script) => {
    expect(validateInstructUserArgs({ ...base, script }).ok).toBe(true);
  });

  it('rejects a secret literal even when it holds a slash (base64, generated passwords)', () => {
    const r = validateInstructUserArgs({ ...base, script: "PASSWORD='abc/defghijklmnopqrstuvwxyz' ./login" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SECRET_IN_SCRIPT');
    expect(validateInstructUserArgs({ ...base, script: 'TOKEN_FILE=~/config/app.json ./run' }).ok).toBe(true);
    expect(validateInstructUserArgs({ ...base, script: 'TOKEN_FILE=./config/app.json ./run' }).ok).toBe(true);
  });

  it('lets a secret read from where it lives, or a path to it, through', () => {
    expect(validateInstructUserArgs({ ...base, script: 'API_TOKEN=$(pass show api/token) ./run' }).ok).toBe(true);
    expect(validateInstructUserArgs({ ...base, script: 'TOKEN_FILE=/Users/me/.config/app.json ./run' }).ok).toBe(true);
  });

  it.each([
    'title',
    'host',
    'why',
    'expect',
    'effects',
  ])('rejects a credential in %s too — every field is posted', (field) => {
    const r = validateInstructUserArgs({ ...base, [field]: 'see ghp_abcdefghijklmnopqrstuvwxyz0123456789' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SECRET_IN_SCRIPT');
    expect(r.error.message).toContain(field);
    expect(r.error.message).not.toContain('ghp_abcdef');
  });

  it.each([
    'title',
    'host',
    'why',
    'expect',
    'effects',
  ])('rejects a short literal secret assignment in %s too — the any-length rule covers every posted field', (field) => {
    for (const text of ["Log in with PASSWORD='hunter2'", 'then API_KEY=abc ./run']) {
      const r = validateInstructUserArgs({ ...base, [field]: text });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('SECRET_IN_SCRIPT');
      expect(r.error.message).toContain(field);
      expect(r.error.message).not.toContain('hunter2');
    }
    expect(validateInstructUserArgs({ ...base, [field]: 'reads API_KEY=$API_KEY from the shell' }).ok).toBe(true);
  });

  it.each([
    ["PASSWORD='$hunter2' ./login"],
    ["PASSWORD='`hunter2`' ./login"],
    ["PASSWORD=$'hunter2' ./login"],
    ['PASSWORD=$"hunter2" ./login'],
  ])('a $ or backtick that the shell does not expand is part of the literal: %s', (script) => {
    const r = validateInstructUserArgs({ ...base, script });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SECRET_IN_SCRIPT');
  });

  it.each([
    ["export 'PASSWORD=hunter2' && ./login", 'script'],
    ['export "PASSWORD=hunter2" && ./login', 'script'],
    ["PASSWORD=' hunter2' ./login", 'script'],
    ["PASSWORD='a;b' ./login", 'script'],
    ['PASSWORD="${PW:-hunter2}" ./login', 'script'],
    ['PASSWORD=$PREFIX"hunter2" ./login', 'script'],
    ['PASSWORD="$(echo hunter2)" ./login', 'script'],
    ['./login --password=hunter2', 'script'],
    ['./login --token abc123', 'script'],
    ['curl -d \'{"password":"hunter2"}\' https://x.example', 'script'],
    ['date # PASSWORD: hunter2', 'script'],
    ['Log in with PASSWORD: hunter2', 'why'],
    ['Log in with password: hunter2', 'why'],
    ['Use `PASSWORD=hunter2` to log in', 'why'],
    ['**Password**: hunter2', 'effects'],
    ['token: " hunter2"', 'expect'],
  ])('a secret-named key followed by = or : and a literal is refused in any form: %s', (text, field) => {
    const args = field === 'script' ? { ...base, script: text } : { ...base, [field]: text };
    const r = validateInstructUserArgs(args);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SECRET_IN_SCRIPT');
    expect(r.error.message).toContain(field);
    expect(r.error.message).not.toContain('hunter2');
  });

  it.each([
    ['비밀번호: hunter2', 'why'],
    ['로그인 암호 = hunter2', 'effects'],
    ['토큰： hunter2', 'expect'],
    ['DB_PASSPHRASE=hunter2 ./run', 'script'],
    ['PRIVATE_KEY=hunter2 ./run', 'script'],
    ['DB_PASS=hunter2 ./run', 'script'],
    ['PW=hunter2 ./run', 'script'],
    ['PASSWORD+=hunter2 ./run', 'script'],
    ['git clone https://me:hunter2@git.example/x.git', 'script'],
    ['PASSWORD="$(base64 -d <<< aHVudGVyMg==)" ./login', 'script'],
    ['PASSWORD="$(cat <<< hunter2)" ./login', 'script'],
  ])('also: Korean keys, more secret names, +=, URL credentials, encoded literals: %s', (text, field) => {
    const args = field === 'script' ? { ...base, script: text } : { ...base, [field]: text };
    const r = validateInstructUserArgs(args);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SECRET_IN_SCRIPT');
    expect(r.error.message).not.toContain('hunter2');
  });

  it.each([
    'cd "$PWD" && ls',
    'BYPASS_CACHE=1 ./run',
    'git clone https://me:$GIT_PASSWORD@git.example/x.git',
    'git clone https://git.example/x.git',
  ])('names that only contain the letters, a reference in a URL, a plain URL pass: %s', (script) => {
    expect(validateInstructUserArgs({ ...base, script }).ok).toBe(true);
  });

  it.each([
    ['PASSWORD="$(cat <<< \'hunter2\')" ./login', 'script'],
    ['PASSWORD="$(cat<<<hunter2)" ./login', 'script'],
    ['node -e \'console.log({password:"hunter2"})\'', 'script'],
    ['{password: hunter2}', 'why'],
    ['curl -d "{\\"password\\":\\"hunter2\\"}" https://x.example/login', 'script'],
    ['export "PASSWORD= hunter2" && ./login', 'script'],
    ['curl -H "X-Api-Key: hunter2" https://x.example', 'script'],
    ['curl -H "Private-Token: hunter2" https://x.example', 'script'],
    ['./app --api-key=hunter2', 'script'],
    ['./app --client-secret hunter2', 'script'],
  ])('also: here-strings, object keys, escaped JSON, quoted spaces, headers and dashed options: %s', (text, field) => {
    const args = field === 'script' ? { ...base, script: text } : { ...base, [field]: text };
    const r = validateInstructUserArgs(args);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SECRET_IN_SCRIPT');
    expect(r.error.message).not.toContain('hunter2');
  });

  it.each([
    'TOKEN= date',
    "PASSWORD='' date",
    'GITHUB_TOKEN= git status',
    'echo "$PASSWORD" | docker login --password-stdin -u me registry.example',
    './app --api-key-file ~/.config/app/key --verbose',
    'curl -H "X-Api-Key: $API_KEY" https://x.example',
  ])('an empty assignment before a command, and options that only name where a secret is, pass: %s', (script) => {
    expect(validateInstructUserArgs({ ...base, script }).ok).toBe(true);
  });

  it.each([
    ["curl -u 'me:hunter2' https://x.example", 'script'],
    ['curl --user=me:hunter2 https://x.example', 'script'],
    ["curl 'https://alice:$hunter2@api.example.com/'", 'script'],
    ['git clone "https://me:${PW:-hunter2}@git.example/x.git"', 'script'],
    ['PASSWORD="$(/bin/echo hunter2)" ./login', 'script'],
    ['PASSWORD="$(command printf hunter2)" ./login', 'script'],
    ['API 키: hunter2', 'why'],
    ['see https://me:${PW:-hunter2}@git.example', 'why'],
  ])('also: curl -u, URL passwords the shell does not expand, path-qualified producers, API 키: %s', (text, field) => {
    const args = field === 'script' ? { ...base, script: text } : { ...base, [field]: text };
    const r = validateInstructUserArgs(args);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SECRET_IN_SCRIPT');
    expect(r.error.message).not.toContain('hunter2');
  });

  it.each([
    'read -rsp \'Password: \' PASSWORD; ./login "$PASSWORD"',
    'GH_TOKEN= git status',
    'curl -u me https://x.example',
    'sudo -u root launchctl list',
    'curl -u "me:$PASSWORD" https://x.example',
    'git clone "https://me:${PW}@git.example/x.git"',
  ])('a prompt string, an empty value, a user without a password, and expanded URL passwords pass: %s', (script) => {
    expect(validateInstructUserArgs({ ...base, script }).ok).toBe(true);
  });

  it.each([
    ["curl -H 'Authorization: Bearer abc123' https://api.example.com", 'script'],
    ['curl -H "Authorization: Basic dXNlcjpw" https://api.example.com', 'script'],
    ['curl --oauth2-bearer abc123 https://api.example.com', 'script'],
    ["curl -H 'X-Api-Key: $hunter2' https://x.example", 'script'],
    ['curl -d \'{"password":"$hunter2"}\' https://x.example/login', 'script'],
    ['send Authorization: Bearer abc123', 'why'],
  ])('also: short bearer/basic credentials, and $ in single quotes in headers and data: %s', (text, field) => {
    const args = field === 'script' ? { ...base, script: text } : { ...base, [field]: text };
    const r = validateInstructUserArgs(args);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SECRET_IN_SCRIPT');
    expect(r.error.message).not.toContain('hunter2');
    expect(r.error.message).not.toContain('abc123');
  });

  it.each([
    'curl -H "Authorization: Bearer $API_TOKEN" https://api.example.com',
    'curl -H "X-Api-Key: $API_KEY" https://x.example',
    'curl -d "{\\"password\\":\\"$PW\\"}" https://x.example/login',
    'curl --oauth2-bearer "$TOKEN" https://api.example.com',
  ])('references the shell expands in headers and data pass: %s', (script) => {
    expect(validateInstructUserArgs({ ...base, script }).ok).toBe(true);
  });

  it('prose about bearer tokens without a value passes', () => {
    expect(validateInstructUserArgs({ ...base, why: 'Bearer tokens are issued by the console' }).ok).toBe(true);
  });

  it.each([
    ['cat > /tmp/login.json <<\'EOF\'\n{"password":"hunter2"}\nEOF', 'script'],
    ['cat > /tmp/login.json <<EOF\n{"password": "hunter2"}\nEOF', 'script'],
    ["curl -H 'Authorization: bearer abc123' https://api.example.com", 'script'],
    ["curl -H 'Authorization: BASIC dXNlcjpw' https://api.example.com", 'script'],
    ['send authorization: bearer abc123', 'why'],
  ])('also: data in a heredoc body, and auth schemes in any case: %s', (text, field) => {
    const args = field === 'script' ? { ...base, script: text } : { ...base, [field]: text };
    const r = validateInstructUserArgs(args);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SECRET_IN_SCRIPT');
    expect(r.error.message).not.toContain('hunter2');
  });

  it.each([
    "PASSWORD='<password>' ./login",
    'cat <<<hello',
    'grep -c x <<< "$(date)"',
    'cat > /tmp/login.json <<EOF\n{"password": "$PW"}\nEOF',
  ])('a quoted placeholder, here-strings, and a reference in heredoc data pass: %s', (script) => {
    expect(validateInstructUserArgs({ ...base, script }).ok).toBe(true);
  });

  it.each([
    ['cat > /tmp/login.json <<\'EOF\'\n{"password":"$hunter2"}\nEOF', 'script'],
    ["cat > /tmp/auth <<'EOF'\nAuthorization: Bearer $hunter2\nEOF", 'script'],
    ['curl -d \'{"password":";hunter2"}\' https://x.example', 'script'],
    ['curl -d \'{"password":")hunter2"}\' https://x.example', 'script'],
    ['curl -d "password=,hunter2" https://x.example', 'script'],
  ])('also: a quoted heredoc writes $ literally, and a value may start with punctuation: %s', (text, field) => {
    const args = field === 'script' ? { ...base, script: text } : { ...base, [field]: text };
    const r = validateInstructUserArgs(args);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SECRET_IN_SCRIPT');
    expect(r.error.message).not.toContain('hunter2');
  });

  it.each([
    'cat > /tmp/login.json <<EOF\n{"password":"$PW"}\nEOF',
    'cat > /tmp/auth <<EOF\nAuthorization: Bearer $TOKEN\nEOF',
    '# Basic setup\ndate',
    'echo "Bearer tokens live in the vault"',
  ])('an expanding heredoc reference, and the words Basic / Bearer outside a header, pass: %s', (script) => {
    expect(validateInstructUserArgs({ ...base, script }).ok).toBe(true);
  });

  it.each([
    ['cat > /tmp/login.json <<\\EOF\n{"password":"$hunter2"}\nEOF', 'script'],
    ["curl -H 'Authorization: Token hunter2' https://api.example.com", 'script'],
    ["curl -H 'Authorization: hunter2' https://api.example.com", 'script'],
    ["curl -H 'Cookie: sid=hunter2' https://x.example", 'script'],
    ['password: ;hunter2', 'why'],
  ])('also: a backslash-quoted heredoc, any Authorization header value, cookies: %s', (text, field) => {
    const args = field === 'script' ? { ...base, script: text } : { ...base, [field]: text };
    const r = validateInstructUserArgs(args);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SECRET_IN_SCRIPT');
    expect(r.error.message).not.toContain('hunter2');
  });

  it.each([
    'curl -H "Authorization: Token $API_TOKEN" https://api.example.com',
    'curl -H "Authorization: $AUTH_HEADER" https://api.example.com',
    'cat <<\\EOF\nhello\nEOF',
  ])('a referenced Authorization header and a closed backslash heredoc pass: %s', (script) => {
    expect(validateInstructUserArgs({ ...base, script }).ok).toBe(true);
  });

  it.each([
    ['curl -H "Cookie: sid=$SID; session=hunter2" https://x.example', 'script'],
    ["date # PASSWORD= 'hunter2'", 'script'],
    ['date # Authorization: Bearer hunter2', 'script'],
  ])('also: every cookie pair, and secrets in comments read as text: %s', (text, field) => {
    const args = field === 'script' ? { ...base, script: text } : { ...base, [field]: text };
    const r = validateInstructUserArgs(args);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SECRET_IN_SCRIPT');
    expect(r.error.message).not.toContain('hunter2');
  });

  it.each([
    'cat <<EOF.json\nhello\nEOF.json',
    "cat <<'END-OF.json'\nhello\nEND-OF.json",
    'curl -H "Cookie: sid=$SID; theme=$THEME" https://x.example',
  ])('a delimiter with punctuation closes, and referenced cookie pairs pass: %s', (script) => {
    expect(validateInstructUserArgs({ ...base, script }).ok).toBe(true);
  });

  it.each([
    'PASSWORD="$PW" ./login',
    'PASSWORD="${PW}" ./login',
    'PASSWORD="${PW:?set PW first}" ./login',
    'API_TOKEN="$(pass show api/token)" ./run',
    'TOKEN_FILE="$HOME/.config/app/token" ./run',
    'printf "%s" "$TOKEN" | ./login --password-stdin',
    'curl -u "me:$PASSWORD" https://x.example',
    './login --token "$TOKEN"',
    'test -n "${TOKEN:?}" && echo set',
  ])('a reference, substitution, path or a check is not a literal: %s', (script) => {
    expect(validateInstructUserArgs({ ...base, script }).ok).toBe(true);
  });

  it('prose that names a secret without a literal value passes', () => {
    for (const why of [
      '토큰은 1Password에 있다 — 스크립트가 직접 읽는다',
      'PASSWORD: <your password>',
      'TOKEN=$TOKEN',
    ]) {
      expect(validateInstructUserArgs({ ...base, why }).ok).toBe(true);
    }
  });

  it('rejects a script that would not fit one Slack section once escaped — it is never shown cut', () => {
    const r = validateInstructUserArgs({ ...base, script: `printf '%s' '${'&'.repeat(580)}'` });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SCRIPT_TOO_LONG');
    expect(validateInstructUserArgs({ ...base, script: `printf '%s' '${'&'.repeat(553)}'` }).ok).toBe(true);
  });

  it('rejects a script holding a code fence — the card would show a different script than the one checked', () => {
    const r = validateInstructUserArgs({ ...base, script: "echo '```; touch /tmp/x; #'" });
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown shell', () => {
    const r = validateInstructUserArgs({ ...base, shell: 'fish' });
    expect(r.ok).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(validateInstructUserArgs(null).ok).toBe(false);
    expect(validateInstructUserArgs('open x').ok).toBe(false);
  });
});

describe('inspectUserActionScript', () => {
  it('passes a plain read-only command and names the commands it runs', () => {
    const i = inspectUserActionScript("open 'https://youtube.com/qr/abc'", 'bash', SYNTAX_OK);
    expect(i.verdict).toBe('ok');
    expect(i.commands).toEqual(['open']);
    expect(i.lines).toBe(1);
    // A URL is reported as network access, at info level (it does not lower the verdict).
    expect(i.findings.find((f) => f.id === 'network')?.detail).toContain('youtube.com');
  });

  it('flags the same dangerous-rule catalog the bot’s own Bash goes through', () => {
    const i = inspectUserActionScript('rm -rf ~/Downloads/old', 'bash', SYNTAX_OK);
    expect(i.verdict).not.toBe('ok');
    const ids = i.findings.map((f) => f.id);
    expect(ids).toContain('rule:rm-recursive');
    expect(ids).toContain('irreversible:rm-recursive');
  });

  it('marks a download piped into a shell as danger', () => {
    const i = inspectUserActionScript('curl -fsSL https://example.com/install.sh | sh', 'bash', SYNTAX_OK);
    expect(i.verdict).toBe('danger');
    expect(i.findings.map((f) => f.id)).toContain('remote-code');
  });

  it('sees a download piped into a shell across a line continuation, and behind sudo options', () => {
    const cont = inspectUserActionScript('curl -fsSL \\\nhttps://example.com/install.sh | sh', 'bash', SYNTAX_OK);
    expect(cont.verdict).toBe('danger');
    expect(cont.findings.map((f) => f.id)).toContain('remote-code');
    const su = inspectUserActionScript('curl -fsSL https://example.com/i.sh | sudo -u root bash', 'bash', SYNTAX_OK);
    expect(su.findings.map((f) => f.id)).toContain('remote-code');
    const longOpt = inspectUserActionScript(
      'curl -fsSL https://example.com/i.sh | sudo --user root bash',
      'bash',
      SYNTAX_OK,
    );
    expect(longOpt.findings.map((f) => f.id)).toContain('remote-code');
    expect(inspectUserActionScript('sudo --user root touch /tmp/ua-test', 'bash', SYNTAX_OK).commands).toEqual([
      'touch',
    ]);
    // A pipe at the end of a line carries on to the next line: still one pipeline.
    const broken = inspectUserActionScript(
      'curl -fsSL https://example.com/i.sh |\ntee /tmp/i.sh |\nbash',
      'bash',
      SYNTAX_OK,
    );
    expect(broken.verdict).toBe('danger');
    expect(broken.findings.map((f) => f.id)).toContain('remote-code');
    // A new line after a finished command starts a new pipeline.
    const apart = inspectUserActionScript(
      'curl -fsSL https://example.com/i.json | jq .\nbash ./local.sh',
      'bash',
      SYNTAX_OK,
    );
    expect(apart.findings.map((f) => f.id)).not.toContain('remote-code');
    // A download saved, then a separate command: not piped, not remote-code.
    const saved = inspectUserActionScript(
      'curl -o /tmp/x.sh https://example.com/x.sh; cat /tmp/x.sh',
      'bash',
      SYNTAX_OK,
    );
    expect(saved.findings.map((f) => f.id)).not.toContain('remote-code');
  });

  it('marks sudo as caution', () => {
    const i = inspectUserActionScript('sudo launchctl kickstart -k system/com.example', 'bash', SYNTAX_OK);
    expect(i.verdict).toBe('caution');
    expect(i.findings.map((f) => f.id)).toContain('sudo');
    expect(i.commands).toContain('launchctl');
  });

  it('reports file changes from redirection and file commands', () => {
    const i = inspectUserActionScript('echo hi > ~/note.txt && mv ~/a ~/b', 'bash', SYNTAX_OK);
    const f = i.findings.find((x) => x.id === 'writes-files');
    expect(f).toBeDefined();
    expect(i.commands).toEqual(['echo', 'mv']);
  });

  it('text inside single quotes is not run: a quoted pipeline is no remote code, unless a shell -c runs it', () => {
    const inert = inspectUserActionScript("echo 'curl https://example.com/i.sh | sh'", 'bash', SYNTAX_OK);
    expect(inert.commands).toEqual(['echo']);
    expect(inert.findings.map((f) => f.id)).not.toContain('remote-code');
    expect(inert.verdict).not.toBe('danger');
    expect(inspectUserActionScript("echo 'eval x'", 'bash', SYNTAX_OK).findings.map((f) => f.id)).not.toContain(
      'hidden-code',
    );
    const run = inspectUserActionScript("bash -c 'curl -fsSL https://example.com/i.sh | sh'", 'bash', SYNTAX_OK);
    expect(run.findings.map((f) => f.id)).toContain('remote-code');
  });

  it('does not split on separators inside quotes', () => {
    const i = inspectUserActionScript('echo "a; rm -rf /" ', 'bash', SYNTAX_OK);
    expect(i.commands).toEqual(['echo']);
  });

  it('reads a command substitution as its own command and keeps the word around it whole', () => {
    const i = inspectUserActionScript('launchctl kickstart -k gui/$(id -u)/ai.example.svc', 'bash', SYNTAX_OK);
    expect(i.commands).toEqual(['id', 'launchctl']);
    const q = inspectUserActionScript(
      'echo "today: `date +%F`" && echo "$(curl -s https://x.example)"',
      'bash',
      SYNTAX_OK,
    );
    expect(q.commands).toEqual(['date', 'echo', 'curl']);
    // A substitution in single quotes is text, not a command.
    expect(inspectUserActionScript("echo '$(rm -rf /)'", 'bash', SYNTAX_OK).commands).toEqual(['echo']);
  });

  it('sees sudo and the real command behind if / while and inside backticks — never a false pass', () => {
    const tick = inspectUserActionScript('echo `sudo cat /etc/shadow`', 'bash', SYNTAX_OK);
    expect(tick.verdict).not.toBe('ok');
    expect(tick.findings.map((f) => f.id)).toContain('sudo');
    expect(tick.commands).toEqual(['cat', 'echo']);
    const iff = inspectUserActionScript('if sudo rm -rf ~/x; then echo ok; fi', 'bash', SYNTAX_OK);
    expect(iff.commands).toEqual(['rm', 'echo']);
    expect(iff.findings.map((f) => f.id)).toContain('sudo');
    const loop = inspectUserActionScript('for f in a b; do rm "$f"; done', 'bash', SYNTAX_OK);
    expect(loop.commands).toEqual(['rm']);
  });

  it('an unquoted heredoc body runs its $(…): the inner command and its effect are seen; a quoted body is inert', () => {
    const open = inspectUserActionScript('cat <<EOF\n$(touch ~/marker)\nEOF', 'bash', SYNTAX_OK);
    expect(open.commands).toEqual(['cat', 'touch']);
    expect(open.findings.map((f) => f.id)).toContain('writes-files');
    const closed = inspectUserActionScript("cat <<'EOF'\n$(touch ~/marker)\nEOF", 'bash', SYNTAX_OK);
    expect(closed.commands).toEqual(['cat']);
    expect(closed.findings.map((f) => f.id)).not.toContain('writes-files');
  });

  it('an unquoted heredoc runs the substitutions in its body; a quoted one does not', () => {
    const open = inspectUserActionScript('cat <<EOF\n$(sudo cat /etc/shadow)\nEOF', 'bash', SYNTAX_OK);
    expect(open.verdict).not.toBe('ok');
    expect(open.commands).toEqual(['cat']);
    expect(open.findings.map((f) => f.id)).toContain('sudo');
    const tick = inspectUserActionScript('cat <<EOF\nnow `date`\nEOF', 'bash', SYNTAX_OK);
    expect(tick.commands).toEqual(['cat', 'date']);
    const closed = inspectUserActionScript("cat <<'EOF'\n$(rm -rf ~/x)\nEOF", 'bash', SYNTAX_OK);
    expect(closed.commands).toEqual(['cat']);
  });

  it('an option value of a wrapper is not the command; a path-qualified sudo is sudo', () => {
    const u = inspectUserActionScript('sudo -u root touch /tmp/ua-test', 'bash', SYNTAX_OK);
    expect(u.commands).toEqual(['touch']);
    expect(u.findings.map((f) => f.id)).toEqual(expect.arrayContaining(['sudo', 'writes-files']));
    expect(inspectUserActionScript('nice -n 10 touch /tmp/ua-test', 'bash', SYNTAX_OK).commands).toEqual(['touch']);
    const path = inspectUserActionScript('/usr/bin/sudo launchctl list', 'bash', SYNTAX_OK);
    expect(path.commands).toEqual(['launchctl']);
    expect(path.findings.map((f) => f.id)).toContain('sudo');
  });

  it('sudo as an argument (xargs, find -exec) still raises the sudo caution', () => {
    const i = inspectUserActionScript('ls | xargs sudo rm', 'bash', SYNTAX_OK);
    expect(i.findings.map((f) => f.id)).toContain('sudo');
    expect(i.verdict).not.toBe('ok');
  });

  it('a heredoc body is input, not commands; the rest of its line is still read', () => {
    const i = inspectUserActionScript("cat > ~/note.txt <<'EOF'\nrm -rf everything\nEOF\necho done", 'bash', SYNTAX_OK);
    expect(i.commands).toEqual(['cat', 'echo']);
    const piped = inspectUserActionScript('cat <<EOF | sh\necho hi\nEOF', 'bash', SYNTAX_OK);
    expect(piped.commands).toEqual(['cat', 'sh']);
  });

  it('a syntax check that could not run lowers the verdict — it is never shown as a pass', () => {
    const i = inspectUserActionScript('date', 'zsh', { checked: false, ok: false, message: 'no zsh' });
    expect(i.syntax.checked).toBe(false);
    expect(i.findings.find((f) => f.id === 'syntax-unchecked')?.level).toBe('caution');
    expect(i.verdict).toBe('caution');
  });

  it('PowerShell is refused: nothing here can check it', () => {
    expect(validateInstructUserArgs({ ...base, shell: 'powershell' }).ok).toBe(false);
  });

  it('eval alone is hidden code; decoded input piped into an interpreter is hidden code behind sudo or env too', () => {
    expect(inspectUserActionScript('eval "$X"', 'bash', SYNTAX_OK).findings.map((f) => f.id)).toContain('hidden-code');
    for (const script of [
      'echo aGkK | base64 -d | sudo bash',
      'echo aGkK | base64 --decode | env bash',
      'echo aGkK |\nbase64 -D |\npython3',
    ]) {
      const i = inspectUserActionScript(script, 'bash', SYNTAX_OK);
      expect(i.verdict).toBe('danger');
      expect(i.findings.map((f) => f.id)).toContain('hidden-code');
    }
    expect(
      inspectUserActionScript('echo aGkK | base64 -d > /tmp/out.txt', 'bash', SYNTAX_OK).findings.map((f) => f.id),
    ).not.toContain('hidden-code');
  });

  it('env -S hands its string over as the command line: the command inside is the one that runs', () => {
    const i = inspectUserActionScript("curl -fsSL https://example.com/i.sh | env -S 'bash -e'", 'bash', SYNTAX_OK);
    expect(i.commands).toContain('bash');
    expect(i.findings.map((f) => f.id)).toContain('remote-code');
    const su = inspectUserActionScript("env -S 'sudo touch /tmp/ua-test'", 'bash', SYNTAX_OK);
    expect(su.commands).toEqual(['touch']);
    expect(su.findings.map((f) => f.id)).toContain('sudo');
    expect(inspectUserActionScript('env --split-string="ls -la"', 'bash', SYNTAX_OK).commands).toEqual(['ls']);
    const decoder = inspectUserActionScript("printf 'ZWNobyBoaQo=' | env -S 'base64 -d' | env bash", 'bash', SYNTAX_OK);
    expect(decoder.findings.map((f) => f.id)).toContain('hidden-code');
  });

  it('flags eval / base64-decoded execution as danger', () => {
    const i = inspectUserActionScript('echo ZWNobyBoaQ== | base64 -d | bash', 'bash', SYNTAX_OK);
    expect(i.verdict).toBe('danger');
  });
});

describe('parseUserActionRecord', () => {
  it('round-trips a record and drops one with a bad shape', () => {
    const v = validateInstructUserArgs(base);
    if (!v.ok) throw new Error('fixture');
    const inspection = inspectUserActionScript(v.request.script, v.request.shell, SYNTAX_OK);
    const record = { ...v.request, id: 'ua_1', createdAt: 1, status: 'pending', inspection };
    expect(parseUserActionRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
    expect(parseUserActionRecord({ ...record, status: 'weird' })).toBeNull();
    expect(parseUserActionRecord({ ...record, script: 42 })).toBeNull();
    expect(parseUserActionRecord(null)).toBeNull();
  });
});

describe('session list helpers', () => {
  const rec = (id: string, status: 'pending' | 'done' | 'failed' = 'pending') => {
    const v = validateInstructUserArgs(base);
    if (!v.ok) throw new Error('fixture');
    return {
      ...v.request,
      id,
      createdAt: 1,
      status,
      inspection: inspectUserActionScript(v.request.script, v.request.shell, SYNTAX_OK),
    } as const;
  };

  it('appendUserAction keeps the newest USER_ACTIONS_KEPT, dropping resolved ones before pending ones', () => {
    let list = [rec('old-done', 'done')];
    for (let i = 0; i < USER_ACTIONS_KEPT; i++) list = appendUserAction(list, rec(`p${i}`));
    expect(list).toHaveLength(USER_ACTIONS_KEPT);
    expect(list.map((a) => a.id)).not.toContain('old-done');
    expect(list[list.length - 1].id).toBe(`p${USER_ACTIONS_KEPT - 1}`);
  });

  it('appendUserAction replaces a record with the same id instead of duplicating it', () => {
    const list = appendUserAction([rec('a')], { ...rec('a'), title: 'new' });
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('new');
  });

  it('resolveUserAction marks a pending action once and refuses a second answer', () => {
    const list = [rec('a'), rec('b')];
    const r = resolveUserAction(list, 'a', 'done', 'U1', 99);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.list.find((a) => a.id === 'a')).toMatchObject({ status: 'done', resolvedBy: 'U1', resolvedAt: 99 });
    expect(r.list.find((a) => a.id === 'b')?.status).toBe('pending');
    const again = resolveUserAction(r.list, 'a', 'failed', 'U2', 100);
    expect(again).toEqual({ ok: false, reason: 'already-resolved', action: r.action });
    expect(resolveUserAction(list, 'zzz', 'done', 'U1', 1)).toEqual({ ok: false, reason: 'not-found' });
  });

  it('restoreUserActions drops malformed entries and non-arrays', () => {
    expect(restoreUserActions(undefined)).toBeUndefined();
    expect(restoreUserActions('x')).toBeUndefined();
    expect(restoreUserActions([rec('a'), { id: 'bad' }])).toEqual([rec('a')]);
    expect(restoreUserActions([{ id: 'bad' }])).toBeUndefined();
  });
});

describe('parseInstructUserToolResult', () => {
  const v = validateInstructUserArgs(base);
  if (!v.ok) throw new Error('fixture');
  const action = {
    ...v.request,
    id: 'ua_9',
    createdAt: 5,
    status: 'pending' as const,
    inspection: inspectUserActionScript(v.request.script, v.request.shell, SYNTAX_OK),
  };
  const payload = JSON.stringify({ type: 'user_action', ok: true, action, note: 'x' });

  it('reads the record from the MCP text content in any of the shapes the SDK hands over', () => {
    expect(parseInstructUserToolResult(payload)).toEqual(action);
    expect(parseInstructUserToolResult([{ type: 'text', text: payload }])).toEqual(action);
    expect(parseInstructUserToolResult({ content: [{ type: 'text', text: payload }] })).toEqual(action);
  });

  it('returns null for a refusal or junk', () => {
    const refusal = JSON.stringify({ type: 'user_action', ok: false, error: { code: 'X', message: 'm' } });
    expect(parseInstructUserToolResult(refusal)).toBeNull();
    expect(parseInstructUserToolResult('not json')).toBeNull();
    expect(parseInstructUserToolResult({ type: 'model_command_result' })).toBeNull();
  });
});
