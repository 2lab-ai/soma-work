/**
 * Incident READ-ONLY mode: an incident session may only call named read-only
 * MCP tools.
 *
 * An incident receiver runs unattended on a live host, so it gets a strictly
 * smaller surface than any normal session: every tool is denied except the
 * exact MCP tool names the trusted server config listed. The mode is a *hard*
 * tier — neither `isAdmin` nor `mode: 'bypass'` can widen it, which is the
 * opposite direction from every other flag in `ToolPolicyContext`.
 *
 * Native filesystem tools (Read/Glob/Grep) are denied too, with no "evidence
 * root" escape hatch: `evaluateToolPolicy` is pure, so it cannot `realpath()`
 * anything, and a lexical prefix check cannot see a symlink inside the root, a
 * symlinked ancestor, or one planted between the decision and the read. Evidence
 * reaches the session through the read-only MCP server instead.
 */

import { describe, expect, it, vi } from 'vitest';
import { evaluateToolPolicy, type IncidentReadOnlyContext, type ToolPolicyContext } from '../policy/tool-policy';

const USER = 'U0INCIDENT1';
const EVIDENCE_DIR = '/srv/soma-evidence/INC-42';
const EVIDENCE_FILE = `${EVIDENCE_DIR}/logs/app.log`;
const ALLOWED_MCP = 'mcp__eagle-eye__get_incident_evidence';

function incidentCtx(over: Partial<IncidentReadOnlyContext> = {}): IncidentReadOnlyContext {
  return { allowedMcpTools: [ALLOWED_MCP], ...over };
}

function ctx(over: Partial<ToolPolicyContext> = {}): ToolPolicyContext {
  return {
    user: USER,
    isAdmin: false,
    mode: 'auto',
    aborted: false,
    isDangerousRuleDisabled: () => false,
    handoffContext: undefined,
    checkMcpToolPermission: () => null,
    incidentReadOnly: incidentCtx(),
    ...over,
  };
}

/** The widest normal context there is — incident mode must still shut it down. */
function widestCtx(over: Partial<ToolPolicyContext> = {}): ToolPolicyContext {
  return ctx({ isAdmin: true, mode: 'bypass', ...over });
}

describe('evaluateToolPolicy — incident READ-ONLY mode', () => {
  describe('context absent → normal behaviour is untouched', () => {
    it('bypass mode still allows Write when no incident context is set', () => {
      const r = evaluateToolPolicy(
        'Write',
        { file_path: EVIDENCE_FILE },
        ctx({ mode: 'bypass', incidentReadOnly: undefined }),
      );
      expect(r.decision).toBe('allow');
    });

    it('auto mode still allows non-dangerous Bash when no incident context is set', () => {
      expect(evaluateToolPolicy('Bash', { command: 'ls -la' }, ctx({ incidentReadOnly: undefined })).decision).toBe(
        'allow',
      );
    });

    it('auto mode still allows Read when no incident context is set', () => {
      expect(
        evaluateToolPolicy('Read', { file_path: EVIDENCE_FILE }, ctx({ incidentReadOnly: undefined })).decision,
      ).toBe('allow');
    });
  });

  describe('strict deny-by-default (admin + bypass cannot widen it)', () => {
    const cases: ReadonlyArray<[string, Record<string, unknown>]> = [
      ['Bash', { command: 'ls -la' }],
      ['Read', { file_path: EVIDENCE_FILE }],
      ['Glob', { pattern: '**/*.log', path: EVIDENCE_DIR }],
      ['Grep', { pattern: 'ERROR', path: EVIDENCE_DIR }],
      ['Write', { file_path: `${EVIDENCE_DIR}/note.txt`, content: 'x' }],
      ['Edit', { file_path: EVIDENCE_FILE, old_string: 'a', new_string: 'b' }],
      ['NotebookEdit', { notebook_path: `${EVIDENCE_DIR}/n.ipynb` }],
      ['Task', { subagent_type: 'general-purpose', prompt: 'read evidence' }],
      ['Agent', { prompt: 'read evidence' }],
      ['Skill', { command: 'zwork' }],
      ['WebFetch', { url: 'https://example.com/exfil' }],
      ['WebSearch', { query: 'incident' }],
      ['TodoWrite', { todos: [] }],
      ['KillShell', { shell_id: '1' }],
      ['BrowserNavigate', { url: 'https://example.com' }],
      ['SomeFutureTool', {}],
    ];

    it.each(cases)('%s → deny even for an admin in bypass mode', (tool, input) => {
      expect(evaluateToolPolicy(tool, input, widestCtx()).decision).toBe('deny');
    });

    it('a non-dangerous Bash is denied by incident mode, not merely un-allowed', () => {
      const r = evaluateToolPolicy('Bash', { command: 'ls -la' }, widestCtx());
      expect(r.decision).toBe('deny');
      expect(r.reason).toContain('incident-read-only');
    });

    it('legacy mode gets a deny, not a deferral to the SDK prompt', () => {
      // `pass` would hand the call back to the SDK's own permission logic —
      // i.e. an unattended session could still run the tool.
      const r = evaluateToolPolicy('Read', { file_path: EVIDENCE_FILE }, ctx({ mode: 'legacy' }));
      expect(r.decision).toBe('deny');
      expect(r.reason).toContain('incident-read-only');
    });
  });

  describe('native filesystem tools have no evidence-path escape hatch', () => {
    it.each([
      ['a plausible evidence file', 'Read', { file_path: EVIDENCE_FILE }],
      ['an absolute glob under the evidence dir', 'Glob', { pattern: `${EVIDENCE_DIR}/**/*.log` }],
      ['a grep scoped to the evidence dir', 'Grep', { pattern: 'ERROR', path: EVIDENCE_DIR }],
    ])('%s → deny', (_label, tool, input) => {
      const r = evaluateToolPolicy(tool, input, widestCtx());
      expect(r.decision).toBe('deny');
      expect(r.reason).toContain('incident-read-only');
    });
  });

  describe('MCP allowlist is exact-match and name-inference free', () => {
    it('an exactly named tool → allow', () => {
      expect(evaluateToolPolicy(ALLOWED_MCP, { incident: 'INC-42' }, ctx()).decision).toBe('allow');
    });

    it('an exactly named tool is allowed in legacy mode too (the tier decides alone)', () => {
      expect(evaluateToolPolicy(ALLOWED_MCP, { incident: 'INC-42' }, ctx({ mode: 'legacy' })).decision).toBe('allow');
    });

    it('an empty allowlist allows nothing', () => {
      const noneCtx = widestCtx({ incidentReadOnly: incidentCtx({ allowedMcpTools: [] }) });
      expect(evaluateToolPolicy(ALLOWED_MCP, {}, noneCtx).decision).toBe('deny');
    });

    it('an unlisted tool from the same server → deny', () => {
      expect(evaluateToolPolicy('mcp__eagle-eye__restart_service', {}, ctx()).decision).toBe('deny');
    });

    it('a name that merely extends an allowlisted name → deny (no prefix matching)', () => {
      expect(evaluateToolPolicy(`${ALLOWED_MCP}_admin`, {}, ctx()).decision).toBe('deny');
    });

    it('a wildcard entry allows nothing — it is not a pattern', () => {
      const wildcardCtx = ctx({ incidentReadOnly: incidentCtx({ allowedMcpTools: ['mcp__eagle-eye__*'] }) });
      expect(evaluateToolPolicy(ALLOWED_MCP, {}, wildcardCtx).decision).toBe('deny');
    });

    it('a native tool name in the allowlist cannot allow that native tool', () => {
      const leakyCtx = widestCtx({ incidentReadOnly: incidentCtx({ allowedMcpTools: ['Bash', 'Read'] }) });
      expect(evaluateToolPolicy('Bash', { command: 'ls' }, leakyCtx).decision).toBe('deny');
      expect(evaluateToolPolicy('Read', { file_path: EVIDENCE_FILE }, leakyCtx).decision).toBe('deny');
    });

    it('an allowlisted MCP tool is still denied when its grant guard rejects it', () => {
      const revoked = ctx({ checkMcpToolPermission: () => 'grant expired' });
      const r = evaluateToolPolicy(ALLOWED_MCP, {}, revoked);
      expect(r.decision).toBe('deny');
      expect(r.reason).toContain('mcp-permission');
    });
  });

  describe('hard-deny tier still runs first', () => {
    it('an aborted session denies Bash with the abort reason, not the incident reason', () => {
      const r = evaluateToolPolicy('Bash', { command: 'ls' }, ctx({ aborted: true }));
      expect(r.decision).toBe('deny');
      expect(r.reason).toContain('abort-guard');
    });

    it('the mcp grant guard is consulted before the incident allowlist', () => {
      const spy = vi.fn(() => null);
      evaluateToolPolicy(ALLOWED_MCP, {}, ctx({ checkMcpToolPermission: spy }));
      expect(spy).toHaveBeenCalledWith(ALLOWED_MCP);
    });
  });
});
