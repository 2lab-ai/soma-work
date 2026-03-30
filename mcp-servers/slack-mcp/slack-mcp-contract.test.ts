import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * RED Contract Tests for slack-mcp rename + send_file/send_media tools
 *
 * These tests verify the contract defined in docs/slack-mcp-rename/trace.md.
 * All tests should FAIL (RED) until implementation is complete.
 *
 * Trace references are noted in each test.
 */

// ── Scenario 1: Rename slack-thread → slack-mcp ─────────────

describe('Scenario 1: Rename slack-thread → slack-mcp', () => {
  // Trace: Scenario 1, Section 3c — server identity
  it('server file exists at slack-mcp path', async () => {
    const serverDir = path.resolve(__dirname, '..', 'slack-mcp');
    const serverFile = path.join(serverDir, 'slack-mcp-server.ts');
    await expect(fs.access(serverFile)).resolves.toBeUndefined();
  });

  // Trace: Scenario 1, Section 3a — BASENAME constant
  it('mcp-config-builder uses SLACK_MCP_SERVER_BASENAME', async () => {
    const configBuilder = await fs.readFile(
      path.resolve(__dirname, '..', '..', 'src', 'mcp-config-builder.ts'),
      'utf-8'
    );
    expect(configBuilder).toContain("SLACK_MCP_SERVER_BASENAME = 'slack-mcp-server'");
  });

  // Trace: Scenario 1, Section 3a — registration key
  it('mcp-config-builder registers server as slack-mcp key', async () => {
    const configBuilder = await fs.readFile(
      path.resolve(__dirname, '..', '..', 'src', 'mcp-config-builder.ts'),
      'utf-8'
    );
    expect(configBuilder).toContain("internalServers['slack-mcp']");
    expect(configBuilder).not.toContain("internalServers['slack-thread']");
  });

  // Trace: Scenario 1, Section 3a — allowed tools prefix
  it('allowed tools uses mcp__slack-mcp prefix', async () => {
    const configBuilder = await fs.readFile(
      path.resolve(__dirname, '..', '..', 'src', 'mcp-config-builder.ts'),
      'utf-8'
    );
    expect(configBuilder).toContain("'mcp__slack-mcp'");
    expect(configBuilder).not.toContain("'mcp__slack-thread'");
  });

  // Trace: Scenario 1, Section 3a — env var
  it('passes SLACK_MCP_CONTEXT env var', async () => {
    const configBuilder = await fs.readFile(
      path.resolve(__dirname, '..', '..', 'src', 'mcp-config-builder.ts'),
      'utf-8'
    );
    expect(configBuilder).toContain('SLACK_MCP_CONTEXT');
    expect(configBuilder).not.toContain('SLACK_THREAD_CONTEXT');
  });

  // Trace: Scenario 1, Section 3b — auto-resume prompt
  it('auto-resume prompt references slack-mcp', async () => {
    const handler = await fs.readFile(
      path.resolve(__dirname, '..', '..', 'src', 'slack-handler.ts'),
      'utf-8'
    );
    expect(handler).toContain('slack-mcp → get_thread_messages');
    expect(handler).not.toContain('slack-thread → get_thread_messages');
  });
});

// ── Scenario 2: send_file tool ──────────────────────────────

describe('Scenario 2: send_file tool', () => {
  // Trace: Scenario 2, Section 3a — tool registration
  it('send_file tool is listed in server tools', async () => {
    const serverPath = path.resolve(__dirname, 'slack-mcp-server.ts');
    const source = await fs.readFile(serverPath, 'utf-8');
    expect(source).toContain("name: 'send_file'");
  });

  // Trace: Scenario 2, Section 2 — input schema
  it('send_file requires file_path parameter', async () => {
    const serverPath = path.resolve(__dirname, 'slack-mcp-server.ts');
    const source = await fs.readFile(serverPath, 'utf-8');
    // Check that file_path is in required array
    expect(source).toMatch(/send_file[\s\S]*?required.*file_path/);
  });

  // Trace: Scenario 2, Section 3b — filesUploadV2 call
  it('send_file calls filesUploadV2', async () => {
    const serverPath = path.resolve(__dirname, 'slack-mcp-server.ts');
    const source = await fs.readFile(serverPath, 'utf-8');
    expect(source).toContain('filesUploadV2');
  });

  // Trace: Scenario 2, Section 3a — default filename
  it('send_file uses basename as default filename', async () => {
    const serverPath = path.resolve(__dirname, 'slack-mcp-server.ts');
    const source = await fs.readFile(serverPath, 'utf-8');
    // Should use path.basename for default filename
    expect(source).toMatch(/path\.basename.*file_path|basename.*resolvedPath/);
  });
});

// ── Scenario 3: send_media tool ─────────────────────────────

describe('Scenario 3: send_media tool', () => {
  // Trace: Scenario 3, Section 3a — tool registration
  it('send_media tool is listed in server tools', async () => {
    const serverPath = path.resolve(__dirname, 'slack-mcp-server.ts');
    const source = await fs.readFile(serverPath, 'utf-8');
    expect(source).toContain("name: 'send_media'");
  });

  // Trace: Scenario 3, Section 3a — alt_text parameter
  it('send_media has alt_text parameter', async () => {
    const serverPath = path.resolve(__dirname, 'slack-mcp-server.ts');
    const source = await fs.readFile(serverPath, 'utf-8');
    expect(source).toMatch(/send_media[\s\S]*?alt_text/);
  });

  // Trace: Scenario 3, Section 5 — media type validation
  it('send_media validates media file extensions', async () => {
    const serverPath = path.resolve(__dirname, 'slack-mcp-server.ts');
    const source = await fs.readFile(serverPath, 'utf-8');
    expect(source).toContain('ALLOWED_MEDIA_EXTENSIONS');
  });

  // Trace: Scenario 3, Section 6 — media_type in response
  it('send_media returns media_type in response', async () => {
    const serverPath = path.resolve(__dirname, 'slack-mcp-server.ts');
    const source = await fs.readFile(serverPath, 'utf-8');
    expect(source).toContain('media_type');
  });
});

// ── Scenario 4: Security validation ────────────────────────

describe('Scenario 4: Security validation', () => {
  // Trace: Scenario 4, Section 3 — validateFilePath function
  it('validateFilePath function exists', async () => {
    const serverPath = path.resolve(__dirname, 'slack-mcp-server.ts');
    const source = await fs.readFile(serverPath, 'utf-8');
    expect(source).toContain('validateFilePath');
  });

  // Trace: Scenario 4, Section 3d — MAX_FILE_SIZE constant
  it('MAX_FILE_SIZE is 1GB', async () => {
    const validatorPath = path.resolve(__dirname, 'helpers', 'file-validator.ts');
    const source = await fs.readFile(validatorPath, 'utf-8');
    expect(source).toMatch(/1[_,]?073[_,]?741[_,]?824/);
  });

  // Trace: Scenario 4, Section 3b — symlink check
  it('validates against symlinks', async () => {
    const validatorPath = path.resolve(__dirname, 'helpers', 'file-validator.ts');
    const source = await fs.readFile(validatorPath, 'utf-8');
    expect(source).toContain('isSymbolicLink');
  });

  // Trace: Scenario 4, Section 3a — path traversal check
  it('validates against path traversal', async () => {
    const validatorPath = path.resolve(__dirname, 'helpers', 'file-validator.ts');
    const source = await fs.readFile(validatorPath, 'utf-8');
    expect(source).toMatch(/path.traversal|\.\..*not.allowed|traversal/i);
  });

  // Codex review fix: allowlisted root directory
  it('has ALLOWED_UPLOAD_ROOTS restricting to /tmp', async () => {
    const validatorPath = path.resolve(__dirname, 'helpers', 'file-validator.ts');
    const source = await fs.readFile(validatorPath, 'utf-8');
    expect(source).toContain('ALLOWED_UPLOAD_ROOTS');
    expect(source).toContain("'/tmp'");
  });

  // Codex review fix: isFile() check
  it('validates file is a regular file (not directory)', async () => {
    const validatorPath = path.resolve(__dirname, 'helpers', 'file-validator.ts');
    const source = await fs.readFile(validatorPath, 'utf-8');
    expect(source).toContain('isFile()');
  });

  // Codex review fix: no false success on missing file_id
  it('rejects upload when Slack returns no file metadata', async () => {
    const serverPath = path.resolve(__dirname, 'slack-mcp-server.ts');
    const source = await fs.readFile(serverPath, 'utf-8');
    expect(source).toContain("if (!uploadedFile?.id)");
  });
});

// ── Scenario 5: Existing tools work after rename ────────────

describe('Scenario 5: Existing tools work after rename', () => {
  // Trace: Scenario 5, Section 3 — tool listing
  it('get_thread_messages is still listed', async () => {
    const serverPath = path.resolve(__dirname, 'slack-mcp-server.ts');
    const source = await fs.readFile(serverPath, 'utf-8');
    expect(source).toContain("name: 'get_thread_messages'");
  });

  // Trace: Scenario 5, Section 3 — tool listing
  it('download_thread_file is still listed', async () => {
    const serverPath = path.resolve(__dirname, 'slack-mcp-server.ts');
    const source = await fs.readFile(serverPath, 'utf-8');
    expect(source).toContain("name: 'download_thread_file'");
  });

  // Trace: Scenario 5, Section 1 — env var
  it('server reads SLACK_MCP_CONTEXT env var', async () => {
    const serverPath = path.resolve(__dirname, 'slack-mcp-server.ts');
    const source = await fs.readFile(serverPath, 'utf-8');
    expect(source).toContain('SLACK_MCP_CONTEXT');
    expect(source).not.toContain('SLACK_THREAD_CONTEXT');
  });

  // Trace: Scenario 5, Section 3 — server version bump
  it('server version is 3.0.0', async () => {
    const serverPath = path.resolve(__dirname, 'slack-mcp-server.ts');
    const source = await fs.readFile(serverPath, 'utf-8');
    // After BaseMcpServer refactoring: super('slack-mcp', '3.0.0')
    expect(source).toContain("'3.0.0'");
  });
});
