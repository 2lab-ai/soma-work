import { setEventRouterProviders } from '@soma/slack/event-router';
import fetch from 'node-fetch';

import * as channelRegistry from '../channel-registry';
import { config, getIncidentEvidenceConfig, getIncidentTrustedSource } from '../config';
import { userSettingsStore } from '../user-settings-store';
import { computeContentHash, getUserSkill, MAX_SKILL_SIZE, updateUserSkill } from '../user-skill-store';
import { CommandRouter } from './commands/command-router';
import './user-skill-file-roundtrip';

setEventRouterProviders({
  createLegacyCommandRouter: (deps) => new CommandRouter(deps as any),
  markMigrationHintShown: (userId) => userSettingsStore.markMigrationHintShown(userId),
  hasMigrationHintShown: (userId) => userSettingsStore.hasMigrationHintShown(userId),
  registerChannel: async (client, channel) => {
    const register = (channelRegistry as any).registerChannel;
    if (typeof register === 'function') {
      await register(client, channel);
    }
  },
  unregisterChannel: (channel) => {
    const unregister = (channelRegistry as any).unregisterChannel;
    if (typeof unregister === 'function') {
      unregister(channel);
    }
  },
  getBaseDirectory: () => config.baseDirectory,
  // Eagle incident receiver. Config says WHO may send a request; the existing
  // accepted-user store says WHETHER that identity may run turns here at all.
  getIncidentSource: () => getIncidentTrustedSource(),
  isIncidentUserAccepted: (userId: string) => userSettingsStore.isUserAccepted(userId),
  // Runtime readiness — the LAST gate the ingress checks, and a deployment
  // question, not a trust one. The isolated incident runtime (SDK options +
  // completion reporting) is wired, so what remains is whether this host can
  // actually read incident evidence: without an evidence endpoint an admitted
  // attempt could only guess, so the ingress stays closed.
  //
  // Still fail-closed by default: `SOMA_INCIDENT_EVIDENCE_BASE_URL` is unset
  // on every host until an operator sets it, and a rejected value (non-https
  // off-box, path, credentials) reads as unset. Trust stays separate — a ready
  // runtime with no `SOMA_INCIDENT_TRUSTED_SOURCE`, or a sender the
  // accepted-user store does not know, still denies every request.
  isIncidentRuntimeReady: () => getIncidentEvidenceConfig() !== null,
  readCurrentSkillContent: (userId, skillName) => getUserSkill(userId, skillName)?.content ?? null,
  hashSkillContent: computeContentHash,
  applySkillUpdate: updateUserSkill,
  downloadSkillUploadFile: async (file) => {
    try {
      const url = file.url_private_download || file.url_private;
      if (!url) return { ok: false, error: 'missing url_private_download' };
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${config.slack.botToken}` },
        redirect: 'follow',
      });
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.length > MAX_SKILL_SIZE) {
        return {
          ok: false,
          error: `SKILL.md too large (${buf.length} > ${MAX_SKILL_SIZE} bytes)`,
        };
      }
      return { ok: true, content: buf.toString('utf-8') };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message ?? String(err) };
    }
  },
});

export * from '@soma/slack/event-router';
