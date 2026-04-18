/**
 * Unit coverage for the view-submission validator and the view-update
 * contract on the kind radio. The full Bolt registration (`registerCctActions`)
 * is covered by integration in the wiring test; here we focus on the
 * validation surface and the stability of block_ids across a kind flip.
 */

import { describe, expect, it, vi } from 'vitest';
import { parseOAuthBlob, validateAddSubmission } from './actions';
import { buildAddSlotModal } from './builder';
import { CCT_BLOCK_IDS } from './views';

type Values = Record<string, Record<string, any>>;

function withName(name: string, extra: Values = {}): Values {
  return {
    [CCT_BLOCK_IDS.add_name]: {
      cct_name_value: { type: 'plain_text_input', value: name },
    },
    ...extra,
  };
}

function withKind(kind: 'setup_token' | 'oauth_credentials', extra: Values = {}): Values {
  return {
    [CCT_BLOCK_IDS.add_kind]: {
      cct_kind_radio: { type: 'radio_buttons', selected_option: { value: kind } },
    },
    ...extra,
  };
}

function setupTokenValue(val: string): Values {
  return {
    [CCT_BLOCK_IDS.add_setup_token_value]: {
      cct_setup_token_value: { type: 'plain_text_input', value: val },
    },
  };
}

function oauthBlobValue(val: string): Values {
  return {
    [CCT_BLOCK_IDS.add_oauth_credentials_blob]: {
      cct_oauth_blob_value: { type: 'plain_text_input', value: val },
    },
  };
}

function tosAcked(): Values {
  return {
    [CCT_BLOCK_IDS.add_tos_ack]: {
      cct_tos_ack: { type: 'checkboxes', selected_options: [{ value: 'ack' }] },
    },
  };
}

function mergeValues(...parts: Values[]): Values {
  return Object.assign({}, ...parts);
}

function fakeManager(listResult: Array<{ name: string; slotId: string; kind: any; status: string }> = []) {
  return { listTokens: vi.fn(() => listResult) } as any;
}

const GOOD_OAUTH_BLOB = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-xxxxxxxx',
    refreshToken: 'refreshvalue',
    expiresAt: Date.parse('2026-12-31T00:00:00Z'),
    scopes: ['user:profile', 'user:inference'],
  },
});

describe('validateAddSubmission', () => {
  it('empty name → error keyed by cct_add_name', () => {
    const values = mergeValues(withName(''), withKind('setup_token'), setupTokenValue('sk-ant-oat01-abcdefgh'));
    const errors = validateAddSubmission(values, fakeManager());
    expect(errors).not.toBeNull();
    expect(errors?.[CCT_BLOCK_IDS.add_name]).toBeDefined();
  });

  it('duplicate name → error keyed by cct_add_name', () => {
    const values = mergeValues(withName('cct1'), withKind('setup_token'), setupTokenValue('sk-ant-oat01-abcdefgh'));
    const errors = validateAddSubmission(
      values,
      fakeManager([{ name: 'cct1', slotId: 's1', kind: 'setup_token', status: 'healthy' }]),
    );
    expect(errors?.[CCT_BLOCK_IDS.add_name]).toMatch(/already in use/);
  });

  it('setup_token non-matching regex → error keyed by cct_add_value', () => {
    const values = mergeValues(withName('ok'), withKind('setup_token'), setupTokenValue('not-a-valid-token'));
    const errors = validateAddSubmission(values, fakeManager());
    expect(errors?.[CCT_BLOCK_IDS.add_setup_token_value]).toMatch(/sk-ant-oat01/);
  });

  it('oauth_credentials missing ToS ack → error keyed by cct_add_tos_ack', () => {
    const values = mergeValues(
      withName('ok'),
      withKind('oauth_credentials'),
      oauthBlobValue(GOOD_OAUTH_BLOB),
      // no tosAcked()
    );
    const errors = validateAddSubmission(values, fakeManager());
    expect(errors?.[CCT_BLOCK_IDS.add_tos_ack]).toMatch(/Terms/);
  });

  it('oauth_credentials with bad JSON → error keyed by cct_add_oauth_blob', () => {
    const values = mergeValues(withName('ok'), withKind('oauth_credentials'), oauthBlobValue('{not json'), tosAcked());
    const errors = validateAddSubmission(values, fakeManager());
    expect(errors?.[CCT_BLOCK_IDS.add_oauth_credentials_blob]).toBeDefined();
  });

  it('oauth_credentials missing user:profile scope → error keyed by cct_add_oauth_blob', () => {
    const noProfileBlob = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'a',
        refreshToken: 'r',
        expiresAt: Date.parse('2026-12-31T00:00:00Z'),
        scopes: ['user:inference'],
      },
    });
    const values = mergeValues(
      withName('ok'),
      withKind('oauth_credentials'),
      oauthBlobValue(noProfileBlob),
      tosAcked(),
    );
    const errors = validateAddSubmission(values, fakeManager());
    expect(errors?.[CCT_BLOCK_IDS.add_oauth_credentials_blob]).toMatch(/user:profile/);
  });

  it('valid setup_token submission → null', () => {
    const values = mergeValues(withName('new-slot'), withKind('setup_token'), setupTokenValue('sk-ant-oat01-abcdefgh'));
    expect(validateAddSubmission(values, fakeManager())).toBeNull();
  });

  it('valid oauth_credentials submission with ack → null', () => {
    const values = mergeValues(
      withName('oauth'),
      withKind('oauth_credentials'),
      oauthBlobValue(GOOD_OAUTH_BLOB),
      tosAcked(),
    );
    expect(validateAddSubmission(values, fakeManager())).toBeNull();
  });
});

describe('parseOAuthBlob', () => {
  it('accepts the nested claudeAiOauth wrapper', () => {
    const creds = parseOAuthBlob(GOOD_OAUTH_BLOB);
    expect(creds?.accessToken).toBe('sk-ant-oat01-xxxxxxxx');
    expect(creds?.scopes).toContain('user:profile');
    expect(creds?.expiresAtMs).toBe(Date.parse('2026-12-31T00:00:00Z'));
  });

  it('accepts the bare inner shape', () => {
    const raw = JSON.stringify({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAtMs: 1234,
      scopes: ['user:profile'],
    });
    const creds = parseOAuthBlob(raw);
    expect(creds?.expiresAtMs).toBe(1234);
  });

  it('rejects missing fields', () => {
    const raw = JSON.stringify({ claudeAiOauth: { accessToken: 'a' } });
    expect(parseOAuthBlob(raw)).toBeNull();
  });

  it('rejects invalid JSON', () => {
    expect(parseOAuthBlob('{not json')).toBeNull();
  });
});

describe('kind_radio flip preserves block_ids across views.update', () => {
  it('both views use the same add_name block_id so typed value is preserved', () => {
    const setupView = buildAddSlotModal('setup_token') as any;
    const oauthView = buildAddSlotModal('oauth_credentials') as any;
    const setupBlockIds = (setupView.blocks as any[]).map((b) => b.block_id);
    const oauthBlockIds = (oauthView.blocks as any[]).map((b) => b.block_id);
    // Stable IDs across the radio flip.
    expect(setupBlockIds).toContain(CCT_BLOCK_IDS.add_name);
    expect(oauthBlockIds).toContain(CCT_BLOCK_IDS.add_name);
    expect(setupBlockIds).toContain(CCT_BLOCK_IDS.add_kind);
    expect(oauthBlockIds).toContain(CCT_BLOCK_IDS.add_kind);
    // Conditional blocks differ as expected.
    expect(setupBlockIds).toContain(CCT_BLOCK_IDS.add_setup_token_value);
    expect(setupBlockIds).not.toContain(CCT_BLOCK_IDS.add_oauth_credentials_blob);
    expect(oauthBlockIds).toContain(CCT_BLOCK_IDS.add_oauth_credentials_blob);
    expect(oauthBlockIds).toContain(CCT_BLOCK_IDS.add_tos_ack);
  });
});
