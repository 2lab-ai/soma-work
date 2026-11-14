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

  it('records a skipped syntax check as info, not as a pass', () => {
    const i = inspectUserActionScript('Get-Date', 'powershell', { checked: false, ok: false, message: 'no pwsh' });
    expect(i.syntax.checked).toBe(false);
    expect(i.findings.map((f) => f.id)).toContain('syntax-unchecked');
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
