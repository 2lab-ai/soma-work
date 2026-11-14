import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildInstructUserResponse, checkScriptSyntax, INSTRUCT_USER_TOOL } from './user-action-mcp-server';

const args = {
  title: '동영상 인증 페이지 열기',
  host: 'owner-mac',
  why: '채널 소유자 본인 얼굴 인증이라 봇이 대신할 수 없다.',
  script: "open 'https://myaccount.google.com/video-verification/submit'",
  expect: '브라우저에 인증 페이지가 열린다',
  effects: '페이지 하나를 연다. 파일은 바꾸지 않는다.',
};

const deps = {
  checkSyntax: () => ({ checked: true, ok: true, tool: 'bash -n' }),
  now: () => 1_700_000_000_000,
  newId: () => 'ua_test',
};

describe('user-action MCP server', () => {
  it('defines instruct_user with every field the human needs as required', () => {
    expect(INSTRUCT_USER_TOOL.name).toBe('instruct_user');
    expect(INSTRUCT_USER_TOOL.inputSchema.required).toEqual(['title', 'host', 'why', 'script', 'expect', 'effects']);
  });

  it('returns a pending record carrying the inspection', () => {
    const res = buildInstructUserResponse(args, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.action).toMatchObject({
      id: 'ua_test',
      createdAt: 1_700_000_000_000,
      status: 'pending',
      host: 'owner-mac',
      shell: 'bash',
      optional: false,
    });
    expect(res.action.inspection.verdict).toBe('ok');
    expect(res.action.inspection.syntax).toEqual({ checked: true, ok: true, tool: 'bash -n' });
  });

  it('refuses a script that does not parse, with the checker message, so the model fixes it first', () => {
    const res = buildInstructUserResponse(
      { ...args, script: 'if true; then echo' },
      { ...deps, checkSyntax: () => ({ checked: true, ok: false, tool: 'bash -n', message: 'syntax error' }) },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('SYNTAX_ERROR');
    expect(res.error.message).toContain('syntax error');
  });

  it('passes validation errors through', () => {
    const res = buildInstructUserResponse({ ...args, host: '' }, deps);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('INVALID_ARGS');
  });

  it('checkScriptSyntax parses with bash -n and never runs the script', () => {
    const ok = checkScriptSyntax('echo hi && touch /tmp/should-not-exist-user-action-test', 'bash');
    expect(ok).toMatchObject({ checked: true, ok: true, tool: 'bash -n' });
    expect(fs.existsSync('/tmp/should-not-exist-user-action-test')).toBe(false);
    const bad = checkScriptSyntax('if true; then echo', 'bash');
    expect(bad.checked).toBe(true);
    expect(bad.ok).toBe(false);
    expect(bad.message).toBeTruthy();
  });

  it('checkScriptSyntax reports unchecked for powershell instead of pretending it passed', () => {
    expect(checkScriptSyntax('Get-Date', 'powershell')).toMatchObject({ checked: false, ok: false });
  });
});
